'use strict';
// Agent 钩子 ：在目标主机上给 Claude Code / Grok / Codex / Antigravity / OpenCode / pi 装上 SSH-WEB 的钩子，
// Agent 开始干活、要权限、问问题、做完、出错时，钩子把事件追加到目标主机的 ~/.cache/ssh-web/hook.log，
// SSH-WEB 借连着的 SSH 连接实时读 (见 session/hooks.js)：状态更准、推送写得出具体内容、安卓通知上能直接「允许 / 拒绝」(Claude Code)。
// 只在网页上点「安装」并确认后才改目标主机；原有的设置和你自己的钩子都保留，卸载只删 SSH-WEB 加的那几条。
// 各 Agent 的配置写法和事件字段是照着各家的文档写的，Claude Code 和 Grok 实测过，别的还没在真的 Agent 上测过 (面板里标「未实测」)

const { posix } = require('path');
const { liveSession } = require('./session');
const { sftpOf } = require('./sftp');
const { setInstalled, rewatch } = require('./session/hooks');
const { AGENT_LIST, agentById } = require('./agents');

const p = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

// 钩子脚本：所有 Agent 共用，第一个参数是哪个 Agent (不写 = Claude Code)。只用 sh / grep / sed (目标主机上不一定有 jq / python)。
// 从 Agent 传来的事件里取出要用的字段 (各家字段名不一样，按 [统一的名字:别名…] 依次找，字符串原样保留转义，直接拼进输出的一行 JSON)；
// 找出事件属于 SSH-WEB 的哪个标签：在 tmux 里 = 挂在这个 tmux 会话上的客户端环境变量里的 LC_SSHWEB
// (同本地快速滚动找 pane 的办法)，不在 tmux 里 = 自己的 LC_SSHWEB。常驻会话里另外报 SSHWEBD_SESSION (daemon)：
// LC_SSHWEB 是第一次开这个会话的标签，换了标签接上以后对不上，服务端按会话编号找现在接着它的标签
// 只有 Agent 要求回话时才往外打印 (Antigravity 的 PreToolUse 要 {"decision":"ask"}，不回当成拒绝，ask = 照你自己的权限设置问你)，
// 其余什么都不输出 (Claude Code 有的事件会把钩子的输出当成给 Claude 的内容)，总是 exit 0
const HOOK_SH = `#!/bin/sh
# SSH-WEB 的 Agent 钩子 (由 SSH-WEB 安装；卸载请在 SSH-WEB 里点「⋯ 更多 → 钩子通知 → 卸载」)
# 把 Claude Code / Grok / Codex / Antigravity / OpenCode 的事件追加到 ~/.cache/ssh-web/hook.log，SSH-WEB 实时读取 (主机状态、推送通知)
# 用法：hook.sh [Agent] [事件名]  (不写 Agent 是 Claude Code；事件名只有 Antigravity 用，它传来的内容里不带事件名)
agent=\${1:-claude}; event=$2
case "$agent:$event" in
  antigravity:PreToolUse) printf '{"decision":"ask"}\\n' ;;
  antigravity:Stop) printf '{"decision":""}\\n' ;;
  antigravity:*) printf '{}\\n' ;;
esac
in=$(head -c 65536 | tr '\\n\\r' '  ')
exec >/dev/null 2>&1
d="$HOME/.cache/ssh-web"; f="$d/hook.log"
mkdir -p "$d" || exit 0
get() { printf '%s' "$in" | grep -oE "\\"$1\\"[[:space:]]*:[[:space:]]*\\"([^\\"\\\\\\\\]|\\\\\\\\.)*\\"" | head -n 1 | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*//'; }
esc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
tabs=; dmn=
if [ -n "$TMUX_PANE" ] && command -v tmux >/dev/null 2>&1; then
  s=$(tmux display -p -t "$TMUX_PANE" '#{session_id}')
  for c in $(tmux list-clients -F '#{client_pid}:#{session_id}'); do
    [ "\${c#*:}" = "$s" ] || continue
    e=$(tr '\\0' '\\n' < "/proc/\${c%%:*}/environ")
    t=$(printf '%s\\n' "$e" | sed -n 's/^LC_SSHWEB=//p' | head -n 1)
    [ -n "$t" ] && tabs="$tabs $t"
    t=$(printf '%s\\n' "$e" | sed -n 's/^SSHWEBD_SESSION=//p' | head -n 1)
    [ -n "$t" ] && dmn="$dmn $t"
  done
elif [ -n "$LC_SSHWEB" ]; then
  tabs=$LC_SSHWEB
fi
[ -n "$dmn" ] || dmn=$SSHWEBD_SESSION
line="{\\"v\\":2,\\"t\\":$(date +%s),\\"agent\\":\\"$(esc "$agent")\\",\\"tabs\\":\\"$(esc "$tabs")\\",\\"daemon\\":\\"$(esc "$dmn")\\",\\"pane\\":\\"$(esc "$TMUX_PANE")\\""
[ -n "$event" ] && line="$line,\\"hook_event_name\\":\\"$(esc "$event")\\""
# 项目目录 (Agent 启动时所在的目录，它在里面 cd 到别处也不变)：Claude Code 给钩子的环境变量
case "$agent" in claude) pd=\${CLAUDE_PROJECT_DIR:-};; *) pd=;; esac
[ -n "$pd" ] && line="$line,\\"proj\\":\\"$(esc "$pd")\\""
for spec in hook_event_name:hookEventName:hook_type:hookType notification_type:notificationType message tool_name:toolName:name \\
  command:cmd:CommandLine file_path:filePath:path url question prompt:user_prompt:userPrompt:lastUserInput \\
  last_assistant_message:lastAssistantMessage:prompt_response error error_details:errorDetails level reason:terminationReason cwd session_id:sessionId:conversationId source; do
  k=\${spec%%:*}
  [ "$k" = hook_event_name ] && [ -n "$event" ] && continue
  v=
  for a in $(printf '%s' "$spec" | tr ':' ' '); do v=$(get "$a"); [ -n "$v" ] && break; done
  [ -n "$v" ] && line="$line,\\"$k\\":$v"
done
# Antigravity 的目录是数组 workspacePaths (取第一个)；对话号 conversationId、你说的话 lastUserInput、Stop 的 terminationReason 在上面的别名里
case "$line" in *'"cwd":'*) ;; *) w=$(printf '%s' "$in" | grep -oE '"workspacePaths"[[:space:]]*:[[:space:]]*\\["([^"\\\\]|\\\\.)*"' | head -n 1 | sed 's/^[^[]*\\[//')
  [ -n "$w" ] && line="$line,\\"cwd\\":$w";; esac
# Antigravity 的 Stop 不带回复：从它的记录文件 (transcriptPath) 里取最后一条模型回复 (PLANNER_RESPONSE 的 content)
if [ "$agent:$event" = antigravity:Stop ]; then
  tp=$(get transcriptPath); tp=\${tp#\\"}; tp=\${tp%\\"}
  if [ -f "$tp" ]; then
    v=$(tail -n 200 "$tp" | grep '"type":"PLANNER_RESPONSE"' | tail -n 1 | head -c 65536 | grep -oE '"content":"([^"\\\\]|\\\\.)*"' | head -n 1 | sed 's/^"content"://')
    [ -n "$v" ] && line="$line,\\"last_assistant_message\\":$v"
  fi
fi
# Antigravity 步骤之间的 Stop (fullyIdle=false) 不算做完；子 Agent 的事件不算主会话的状态
printf '%s' "$in" | grep -qE '"(fullyIdle|fully_idle)"[[:space:]]*:[[:space:]]*false' && line="$line,\\"busy\\":true"
[ "$agent" != claude ] && printf '%s' "$in" | grep -qE '"(subagent_type|subagentType|agent_id)"[[:space:]]*:[[:space:]]*"[^"]' && line="$line,\\"child\\":true"
printf '%s}\\n' "$line" >> "$f"
[ "$(wc -c < "$f")" -gt 1048576 ] && mv -f "$f" "$f.1"
exit 0
`;

// Windows 主机 (没有 sh / grep)：同样的事情用 PowerShell 做 (Windows 都有，能直接解析 JSON)。钩子命令用 powershell -File 跑这个文件
// (不管 Agent 用 cmd 还是 Git Bash 执行钩子都能跑)；读事件也是一个文件 (watch.ps1)，不用 -EncodedCommand：那是 Windows Defender 的报警项 
// 开头的 ﻿ (UTF-8 的 BOM) 不能去掉：Windows PowerShell 5.1 读没有 BOM 的 .ps1 按系统代码页 (中文系统是 GBK) 解码，
// 注释里的中文会吃掉后面的换行，把下一行代码并进注释里，整个脚本解析失败 (v1.80.0 就这样，钩子在 Windows 上完全不工作)
const HOOK_PS1 = `﻿# SSH-WEB 的 Agent 钩子 (Windows 版，由 SSH-WEB 安装；卸载请在 SSH-WEB 里点「⋯ 更多 → 钩子通知 → 卸载」)
# 把 Claude Code 等 Agent 的事件追加到 %USERPROFILE%\\.cache\\ssh-web\\hook.log，SSH-WEB 实时读取 (主机状态、推送通知)
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File hook.ps1 [Agent] [事件名]
param([string]$agent = 'claude', [string]$evName = '')
$ErrorActionPreference = 'SilentlyContinue'
# switch 会把所有匹配的分支都执行一遍 (不像 sh 的 case 只走第一个)，每个分支都要 break，不然 Stop 会再多回一行 {}
switch -Wildcard ("\${agent}:$evName") {
  'antigravity:PreToolUse' { [Console]::Out.WriteLine('{"decision":"ask"}'); break }
  'antigravity:Stop' { [Console]::Out.WriteLine('{"decision":""}'); break }
  'antigravity:*' { [Console]::Out.WriteLine('{}'); break }
}
try {
  $stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding $false))
  $raw = $stdin.ReadToEnd()
  $j = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { New-Object psobject }
  $ti = $j.tool_input; if (-not $ti) { $ti = $j.toolInput }; if (-not $ti -and $j.toolCall) { $ti = $j.toolCall.args } # Antigravity：toolCall.{name,args}
  $pick = { param($names) foreach ($n in $names) { $v = $j.$n; if ($v -is [string] -and $v) { return $v } } ; return $null }
  $o = [ordered]@{ v = 3; t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); agent = $agent; tabs = "$env:LC_SSHWEB"; daemon = "$env:SSHWEBD_SESSION"; pane = "$env:TMUX_PANE" }
  # 没有标签 / 常驻会话的标记 (Windows 的 SSH 不传 LC_SSHWEB)：往上找父进程，有 sshd 才是从 SSH 连进来的终端里开的 Agent，
  # 标上 ssh；主机上自己开的终端里的 Agent 不标 (SSH-WEB 不把它的事件推给网页上的标签)
  # (查不了进程就照旧当成 SSH 连进来的，不丢事件)。
  # 先看环境变量：sshd 给连进来的会话设 SSH_CONNECTION / SSH_CLIENT，Agent 和它跑的钩子都继承，每个 Agent 进程各是各的，
  # 同一个对话先后 (或同时) 在 SSH 里和本地终端里打开，各自都判断得准，也不用查进程。
  # 没有的话再往上找父进程 (查一次所有进程要三四百毫秒，每次用工具都跑钩子会拖慢 Agent)：结果按「会话号 + 这个 Agent 的环境变量」
  # 记在 %TEMP% 里 (两天没用的删掉)。环境变量是 Agent 启动时从所在的终端继承的，换个终端打开同一个对话就对不上、重新查，不会用错
  if (-not $env:LC_SSHWEB -and -not $env:SSHWEBD_SESSION) {
    $o.ssh = $true
    try {
      if (-not $env:SSH_CONNECTION -and -not $env:SSH_CLIENT) {
        $sid = & $pick @('session_id', 'sessionId')
        $fp = (Get-ChildItem env: | Sort-Object Name | ForEach-Object { $_.Name + '=' + $_.Value }) -join "\`n"
        $sha = [Security.Cryptography.SHA1]::Create()
        $key = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$sid\`n$fp"))) -replace '-', '').Substring(0, 20)
        $cf = Join-Path $env:TEMP "sshweb-hook-$key.txt"
        if (Test-Path $cf) { $o.ssh = (Get-Content -Raw $cf).Trim() -eq '1' }
        else {
          $all = @{}; Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name -ErrorAction Stop | ForEach-Object { $all[[int]$_.ProcessId] = $_ }
          $p = $all[[int]$PID]
          if ($p) {
            $o.ssh = $false
            for ($i = 0; $p -and $i -lt 30; $i++) { if ($p.Name -match '^sshd(-session)?\\.exe$') { $o.ssh = $true; break }; $p = $all[[int]$p.ParentProcessId] }
            Get-ChildItem (Join-Path $env:TEMP 'sshweb-hook-*.txt') | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | Remove-Item -Force
            [IO.File]::WriteAllText($cf, $(if ($o.ssh) { '1' } else { '0' }))
          }
        }
      }
    } catch { $o.ssh = $true }
  }
  $o.hook_event_name = if ($evName) { $evName } else { & $pick @('hook_event_name', 'hookEventName', 'hook_type', 'hookType') }
  $o.notification_type = & $pick @('notification_type', 'notificationType')
  $o.message = & $pick @('message')
  $o.tool_name = & $pick @('tool_name', 'toolName', 'name'); if (-not $o.tool_name -and $j.toolCall.name -is [string]) { $o.tool_name = $j.toolCall.name }
  if ($ti) {
    foreach ($k in @('command', 'cmd', 'CommandLine')) { if ($ti.$k -is [string]) { $o.command = $ti.$k; break } }
    foreach ($k in @('file_path', 'filePath', 'path')) { if ($ti.$k -is [string]) { $o.file_path = $ti.$k; break } }
    if ($ti.url -is [string]) { $o.url = $ti.url }
    if ($ti.questions) { $q = @($ti.questions)[0]; if ($q.question) { $o.question = $q.question } }
  }
  $o.prompt = & $pick @('prompt', 'user_prompt', 'userPrompt', 'lastUserInput')
  $o.last_assistant_message = & $pick @('last_assistant_message', 'lastAssistantMessage', 'prompt_response')
  # Antigravity 的 Stop 不带回复：从它的记录文件 (transcriptPath) 里取最后一条模型回复
  if ($agent -eq 'antigravity' -and $evName -eq 'Stop' -and $j.transcriptPath -is [string] -and (Test-Path -LiteralPath $j.transcriptPath)) {
    $r = Get-Content -LiteralPath $j.transcriptPath -Tail 200 -Encoding UTF8 | Where-Object { $_ -match '"type":"PLANNER_RESPONSE"' } | Select-Object -Last 1
    if ($r) { try { $c = ($r | ConvertFrom-Json).content; if ($c -is [string] -and $c) { $o.last_assistant_message = $c } } catch {} }
  }
  $o.error = & $pick @('error')
  $o.error_details = & $pick @('error_details', 'errorDetails')
  $o.level = & $pick @('level')
  $o.reason = & $pick @('reason', 'terminationReason')
  $o.cwd = & $pick @('cwd'); if (-not $o.cwd -and $j.workspacePaths) { $w = @($j.workspacePaths)[0]; if ($w -is [string]) { $o.cwd = $w } } # Antigravity：目录是数组
  $o.session_id = & $pick @('session_id', 'sessionId', 'conversationId')
  $o.source = & $pick @('source')
  $pd = if ($agent -eq 'claude') { $env:CLAUDE_PROJECT_DIR } else { '' }
  if ($pd) { $o.proj = $pd } # 项目目录 (Agent 启动时所在的目录，它在里面 cd 到别处也不变)
  if ($j.fullyIdle -eq $false -or $j.fully_idle -eq $false) { $o.busy = $true }
  if ($agent -ne 'claude' -and ($j.subagent_type -or $j.subagentType -or $j.agent_id)) { $o.child = $true }
  foreach ($k in @($o.Keys)) { if ($null -eq $o[$k]) { $o.Remove($k) } }
  $line = ($o | ConvertTo-Json -Compress -Depth 3)
  $d = Join-Path $env:USERPROFILE '.cache\\ssh-web'; $f = Join-Path $d 'hook.log'
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  [IO.File]::AppendAllText($f, $line + "\`n", (New-Object Text.UTF8Encoding $false))
  if ((Get-Item $f).Length -gt 1048576) { Move-Item -Force $f "$f.1" }
} catch {}
exit 0
`;

const WATCH_PS1 = `﻿# SSH-WEB 读钩子事件 (Windows 版，由 SSH-WEB 安装)：先报一行装了钩子，再一直读 hook.log 的新行 (同 Linux 上的 tail -F)。
# SSH 断开、通道关掉时 Windows 不结束这个进程 (以前用 Get-Content -Wait，一台主机积了几十个、几个 GB 内存)：
# 每 2 秒看一眼启动它的 sshd 还在不在，不在了就退出；启动时顺手结束以前留下的 (sshd 已经没了的)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$enc = New-Object Text.UTF8Encoding $false
$d = Join-Path $env:USERPROFILE '.cache\\ssh-web'; $f = Join-Path $d 'hook.log'
if (Test-Path (Join-Path $env:USERPROFILE '.ssh-web\\hook.ps1')) { 'SSHWEB_HOOKS=1' } else { 'SSHWEB_HOOKS=0' }
New-Item -ItemType Directory -Force -Path $d | Out-Null
if (-not (Test-Path $f)) { [IO.File]::WriteAllText($f, '') }
$sshd = $null
try {
  $all = @{}; foreach ($p in (Get-CimInstance Win32_Process -ErrorAction Stop)) { $all[[int]$p.ProcessId] = $p }
  # 往上找启动它的 sshd (中间隔着 cmd / powershell)；找不到 (上面有一层已经没了) = 留下的
  $up = { param($id) for ($i = 0; $i -lt 4; $i++) { $x = $all[[int]$all[[int]$id].ParentProcessId]; if (-not $x) { return $null }; if ($x.Name -like 'sshd*') { return $x }; $id = $x.ProcessId }; return $null }
  $me = & $up $PID
  if ($me) { $sshd = Get-Process -Id $me.ProcessId -ErrorAction SilentlyContinue }
  foreach ($p in $all.Values) {
    if ($p.ProcessId -eq $PID -or $p.Name -ne 'powershell.exe' -or [string]$p.CommandLine -notlike '*\\.ssh-web\\watch.ps1*') { continue }
    if (-not (& $up $p.ProcessId)) {
      $pp = $all[[int]$p.ParentProcessId]
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      if ($pp -and [string]$pp.CommandLine -like '*\\.ssh-web\\watch.ps1*') { Stop-Process -Id $pp.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  }
} catch {}
$fs = $null; $pos = (Get-Item -LiteralPath $f).Length; $dec = $enc.GetDecoder(); $buf = ''; $at = [DateTime]::Now
while ($true) {
  if (([DateTime]::Now - $at).TotalSeconds -ge 2) { $at = [DateTime]::Now; if ($sshd -and $sshd.HasExited) { exit 0 } }
  try {
    if (-not $fs) { $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite, Delete'); [void]$fs.Seek($pos, 'Begin') }
    $n = $fs.Length - $fs.Position
    if ($n -gt 0) {
      $b = New-Object byte[] $n; $r = $fs.Read($b, 0, $n); $pos += $r
      $c = New-Object char[] ($enc.GetMaxCharCount($r)); $k = $dec.GetChars($b, 0, $r, $c, 0); $buf += New-Object string($c, 0, $k)
      $i = $buf.LastIndexOf("\`n")
      if ($i -ge 0) { [Console]::Out.Write($buf.Substring(0, $i + 1)); [Console]::Out.Flush(); $buf = $buf.Substring($i + 1) }
      continue
    }
    # hook.ps1 在 hook.log 超过 1MB 时把它改名成 hook.log.1 再写新的：路径上的文件比读到的位置短 = 换了新文件，从头读
    if ((New-Object IO.FileInfo $f).Length -lt $pos) { $fs.Dispose(); $fs = $null; $pos = 0; $dec = $enc.GetDecoder(); continue }
  } catch { if ($fs) { $fs.Dispose(); $fs = $null } }
  Start-Sleep -Milliseconds 300
}
`;

const HOOK_CMD = 'sh "$HOME/.ssh-web/hook.sh"';
const isOurs = (h) => !!h && typeof h.command === 'string' && /\.ssh-web[\\/]hook(\.(sh|ps1)|-[\w-]+\.cmd)/.test(h.command);
// Claude Code 的 [事件, 匹配的工具]：问问题 (AskUserQuestion) 用 PreToolUse 看；工具用完 (PostToolUse) = 确认过了、接着在干活；
// SessionStart 的 source 分得出是恢复的旧对话 (resume) 还是新开的 (startup / clear)：标签名照对话的换 (见 session/hooks.js)
// 各 Agent 的钩子写在哪、怎么写 (每个 Agent 一个文件，见 lib/agents/ 里各自的 hooks 一节)：
// kind = settings：合并进 Agent 自己的 JSON 设置 (和 Claude 一样的 hooks 结构)；own：SSH-WEB 自己的一个钩子文件，卸载直接删；
// bundle：Antigravity 的 hooks.json 里一个命名的分组；plugin：插件 / 扩展文件 (OpenCode 的插件、pi 的扩展)。
// events：[事件, 匹配的工具, 超时]；detect：主机上有这些路径之一就算装了这个 Agent (只用来排序、提示，没找到也可以装)；
// tip / after：钩子面板上这一行的说明 / 装好后还要做的事 (网页上不按 Agent 写死，见 agentStatus)；
// toml：顺带写进它的 TOML 配置的一项 (Grok 的 pager.toml、Codex 的 config.toml，见下面的 tomlSet)；json：顺带写进它的 JSON 设置的一项 (pi 的 settings.json，见 jsonSet)；tested：在真的 Agent 上测过 (别的面板里标「未实测」)
const AGENTS = AGENT_LIST.filter((a) => a.hooks).map((a) => ({ id: a.id, name: a.name, tested: !!a.tested, ...a.hooks }));
const HOOK_EVENTS = agentById('claude').hooks.events;
const OPENCODE_PLUGIN = agentById('opencode').hooks.plugin;
const PI_EXTENSION = agentById('pi').hooks.plugin;
const agentOf = (id) => AGENTS.find((a) => a.id === (id || 'claude'));
// 钩子命令：跑钩子脚本的命令 (Linux：sh hook.sh；Windows：powershell -File hook.ps1) + 哪个 Agent (+ 事件名)
const cmdOf = (a, ev, base = HOOK_CMD) => { const arg = typeof a.arg === 'function' ? a.arg(ev) : a.arg; return arg ? `${base} ${arg}` : base; };
// Windows 上 winWrap 的 Agent (Antigravity)：每个事件一个 .cmd 小文件，钩子命令只写它的路径 (不带引号、不带参数)。
// agy 在 Windows 上把命令交给 cmd 跑，命令里带引号的路径传过去会被转义坏掉 (实测 powershell -File "…" 的写法一次都没跑起来)。
// 路径里有空格等 cmd 要加引号的字符就没法这么写，还用原来的命令
const WRAP_SAFE = /^\/[A-Za-z]:[\w\/.\-]+$/;
const wrapName = (a, ev) => `hook-${a.id}-${ev}.cmd`;
const wrapText = (a, ev) => `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hook.ps1" ${cmdOf(a, ev, '').trim()}\r\n`;
const wraps = (P, a) => (P.win && a.winWrap && WRAP_SAFE.test(P.dir) ? a.events.map(([ev]) => ev) : []);
// 某个事件的钩子命令 (Linux：sh hook.sh …；Windows：powershell -File hook.ps1 … 或者 .cmd 小文件的路径)
const cmdFor = (P, a) => (wraps(P, a).length ? (ev) => `${P.dir.slice(1)}/${wrapName(a, ev)}` : (ev) => cmdOf(a, ev, P.cmd));
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 一个钩子定义里有没有 SSH-WEB 的 (Antigravity 的部分事件把 command 直接写在定义上)
const defIsOurs = (g) => isOurs(g) || (isPlain(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs));
// 去掉一组定义里 SSH-WEB 的钩子 (别的原样保留；空了的定义删掉)
function stripDefs(groups) {
  return groups.map((g) => (isPlain(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !isOurs(g) && !(isPlain(g) && Array.isArray(g.hooks) && !g.hooks.length));
}
function stripHooks(hooks) {
  const out = { ...hooks };
  for (const [ev, groups] of Object.entries(out)) {
    if (!Array.isArray(groups)) continue;
    const kept = stripDefs(groups);
    if (kept.length) out[ev] = kept; else delete out[ev];
  }
  return out;
}

// 去掉 SSH-WEB 加的钩子 (某个事件下没东西了就删掉这个事件)
function removeHooks(settings, agent = agentOf()) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  const key = agent.kind === 'bundle' ? agent.bundle : 'hooks';
  if (!isPlain(out[key])) return out;
  out[key] = stripHooks(out[key]);
  if (!Object.keys(out[key]).length) delete out[key];
  return out;
}

// 加上 SSH-WEB 的钩子 (先去掉旧的，重复安装不会加出两份)
function addHooks(settings, agent = agentOf(), base = HOOK_CMD, cmd = (ev) => cmdOf(agent, ev, base)) {
  const out = removeHooks(settings, agent);
  const key = agent.kind === 'bundle' ? agent.bundle : 'hooks';
  if (!isPlain(out[key])) out[key] = {};
  for (const [ev, matcher, timeout] of agent.events) {
    if (!Array.isArray(out[key][ev])) out[key][ev] = [];
    const hook = { type: 'command', command: cmd(ev), timeout: timeout || agent.timeout || 10 };
    // Antigravity 不带匹配的事件把命令直接写在定义上
    out[key][ev].push(agent.kind === 'bundle' && !matcher ? hook : { ...(matcher ? { matcher } : {}), hooks: [hook] });
  }
  return out;
}

const hookCount = (settings, agent = agentOf()) => {
  const box = agent.kind === 'bundle' ? settings?.[agent.bundle] : settings?.hooks;
  return agent.events.filter(([ev]) => (Array.isArray(box?.[ev]) ? box[ev] : []).some(defIsOurs)).length;
};

// 装钩子时顺带写进 Agent 的 TOML 配置的一项 (Grok 的 pager.toml、Codex 的 config.toml)：只加一行，后面带上 TOML_MARK，卸载时只删带它的行。
// 你自己写过这一项 (不管写的什么) 就不动；没有这一节就在文件末尾加上 (节标题也带标记)。返回新内容，不用改返回 null
const TOML_MARK = '# SSH-WEB 钩子加的，卸载钩子时去掉';
// 换行照原文件的 (Windows 上常是 \r\n)
const eolOf = (text) => (/\r\n/.test(text || '') ? '\r\n' : '\n');
function tomlSet(text, t) {
  const eol = eolOf(text), lines = text == null ? [] : text.split(/\r?\n/);
  const head = (l) => /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(l)?.[1].trim();
  const isKey = (l, k) => new RegExp(`^\\s*(${k}|"${k}")\\s*=`).test(l);
  let sec = '', at = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = head(lines[i]);
    if (h != null) { sec = h; if (h === t.table) at = i; continue; }
    if ((sec === t.table && isKey(lines[i], t.key)) || (sec === '' && isKey(lines[i], `${t.table}\\.${t.key}`))) return null;
  }
  const line = `${t.key} = ${t.value}  ${TOML_MARK}`;
  if (at >= 0) lines.splice(at + 1, 0, line);
  else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push(`[${t.table}]  ${TOML_MARK}`, line);
  }
  return lines.join(eol).replace(/(\r?\n)*$/, eol);
}
// 去掉带 TOML_MARK 的行；剩下的只有空白 (文件是装钩子时新建的) 返回 ''
function tomlUnset(text) {
  if (text == null || !text.includes(TOML_MARK)) return null;
  const eol = eolOf(text), left = text.split(/\r?\n/).filter((l) => !l.includes(TOML_MARK)).join(eol);
  return left.trim() ? left.replace(/(\r?\n)*$/, eol) : '';
}

// 装钩子时顺带写进 Agent 的 JSON 设置的一项 (pi 的 settings.json 里 "tuiMode": "regular")：JSON 里没法加注释当标记，
// pi 自己也会改写这个文件 (重新排版、加别的项)，所以加没加过记在 ~/.ssh-web/<Agent>-settings.json 里 (见 jsonMark)。
// 你自己写过这一项 (不管写的什么) 就不动。返回新的设置，不用改返回 null
function jsonSet(settings, j) {
  if (Object.prototype.hasOwnProperty.call(settings, j.key)) return null;
  return { ...settings, [j.key]: j.value };
}
// 卸载：装的时候加过 (有记录)、现在还是装的时候的值才去掉 (你后来改成别的就不动)。返回新的设置，不用改返回 null
function jsonUnset(settings, j, added) {
  if (!added || settings[j.key] !== j.value) return null;
  const out = { ...settings };
  delete out[j.key];
  return out;
}
const jsonMark = (P, a) => posix.join(P.dir, `${a.id}-settings.json`);
const jsonLine = (j) => `"${j.key}": ${JSON.stringify(j.value)}`;
// 顺带改的配置，写给人看 (安装前的确认框里)
const alsoText = (a) => (a.toml ? `~/${a.toml.file} 的 [${a.toml.table}] 里设 ${a.toml.key} = ${a.toml.value}` : a.json ? `~/${a.json.file} 里设 ${jsonLine(a.json)}` : '');

// 目标主机上的路径 (主目录用 sftp 的 realpath('.') 得到)
async function paths(sftp) {
  const home = await p((cb) => sftp.realpath('.', cb));
  // Windows 主机：SFTP 的主目录是 /C:/Users/xx 这样
  const win = /^\/[A-Za-z]:/.test(home), dir = posix.join(home, '.ssh-web');
  return { home, dir, win, script: posix.join(dir, win ? 'hook.ps1' : 'hook.sh'), scriptText: win ? HOOK_PS1 : HOOK_SH, watch: posix.join(dir, 'watch.ps1'),
    others: [posix.join(dir, 'hook.sh'), posix.join(dir, 'hook.ps1'), posix.join(dir, 'watch.ps1')],
    cmd: win ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${home.slice(1)}/.ssh-web/hook.ps1"` : HOOK_CMD };
}
const fileOf = (P, a) => posix.join(P.home, a.file);

// 读 JSON 设置：没有这个文件 = 空设置；不是合法 JSON 就不动它 (抛错)
async function readSettings(sftp, file) {
  let text;
  try { text = String(await p((cb) => sftp.readFile(file, cb))); } catch (e) { if (e.code === 2) return { settings: {}, text: null }; throw e; }
  if (!text.trim()) return { settings: {}, text };
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error(`${file} 不是合法的 JSON，没有改动 (请先修好它)`); }
  if (!isPlain(settings)) throw new Error(`${file} 不是 JSON 对象，没有改动`);
  return { settings, text };
}
const readText = (sftp, file) => p((cb) => sftp.readFile(file, cb)).then(String, () => null);
const exists = (sftp, file) => p((cb) => sftp.stat(file, cb)).then(() => true, () => false);

// 写文件：先写临时文件再换上去 (写到一半断了原文件不受影响)
async function writeAtomic(sftp, file, data, mode) {
  const tmp = `${file}.sshweb-${Date.now().toString(36)}`;
  await p((cb) => sftp.writeFile(tmp, data, { mode }, cb));
  try {
    await p((cb) => sftp.ext_openssh_rename(tmp, file, cb));
  } catch {
    await p((cb) => sftp.unlink(file, cb)).catch(() => {});
    await p((cb) => sftp.rename(tmp, file, cb));
  }
}
// 逐级建目录 (已经有了不算错)
async function mkdirs(sftp, home, dir) {
  let cur = home;
  for (const part of posix.relative(home, dir).split('/').filter(Boolean)) {
    cur = posix.join(cur, part);
    await p((cb) => sftp.mkdir(cur, cb)).catch(() => {});
  }
}

// 一个 Agent 的安装情况：installed 全装上了、partial 只有一部分、outdated 装的插件是旧版本
async function agentStatus(sftp, P, a) {
  const file = fileOf(P, a);
  const present = (await Promise.all(a.detect.map((d) => exists(sftp, posix.join(P.home, d))))).some(Boolean);
  // 网页上显示的都从这里来：说明、装好后要做的事、顺带改的配置、会不会备份原来的设置 (合并进 JSON 设置的才备份)
  const base = { id: a.id, name: a.name, present, config: file, file: '~/' + a.file, tested: a.tested,
    tip: a.tip || '', after: a.after || '', also: alsoText(a), backup: a.kind === 'settings' || a.kind === 'bundle' };
  if (a.kind === 'plugin') {
    const text = await readText(sftp, file);
    return { ...base, installed: text != null, partial: false, outdated: text != null && text !== a.plugin };
  }
  try {
    const { settings } = await readSettings(sftp, file);
    const n = hookCount(settings, a);
    // 装的命令和现在该写的不一样 (比如 Antigravity 在 Windows 上换成了 .cmd 小文件)：提示重新安装
    const box = a.kind === 'bundle' ? settings?.[a.bundle] : settings?.hooks, cmd = cmdFor(P, a);
    const has = new Set(Object.values(isPlain(box) ? box : {}).flat().flatMap((g) => [g, ...(Array.isArray(g?.hooks) ? g.hooks : [])]).filter(isOurs).map((h) => h.command));
    const installed = n === a.events.length;
    return { ...base, installed, partial: n > 0 && n < a.events.length, outdated: installed && a.events.some(([ev]) => !has.has(cmd(ev))) };
  } catch (e) {
    return { ...base, installed: false, partial: false, outdated: false, error: e.message };
  }
}

async function status(sess) {
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const script = await readText(sftp, P.script);
  const scriptOk = script != null;
  const agents = await Promise.all(AGENTS.map((a) => agentStatus(sftp, P, a)));
  for (const a of agents) if (a.installed && !scriptOk) { a.installed = false; a.partial = true; }
  const claude = agents[0];
  // outdated：装的钩子脚本是旧版本 (SSH-WEB 更新后脚本多取了字段)，重新安装一下。
  // installed / partial / settings 是 Claude Code 的 (以前只有 Claude 时的字段)
  return { agents, scriptOk, win: P.win, outdated: scriptOk && script !== P.scriptText,
    installed: claude.installed, partial: claude.partial, settings: claude.config };
}

// 主机上的 watch.ps1 是旧版 (装钩子时写的)：换成现在的。每次开始读事件前调 (见 session/hooks.js 的 startWatch)，
// 不用重新安装钩子 (旧版断开后不退出，要尽快换掉)；没装钩子 (没有 watch.ps1) 不动
async function refreshWatch(sess) {
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  if (!P.win) return false;
  const old = await readText(sftp, P.watch);
  if (old == null || old === WATCH_PS1) return false;
  await writeAtomic(sftp, P.watch, WATCH_PS1, 0o644);
  return true;
}

async function install(sess, id) {
  const a = agentOf(id);
  if (!a) throw new Error('不认识的 Agent');
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const file = fileOf(P, a);
  // 先读：格式不对就什么都不改
  const cur = a.kind === 'plugin' || a.kind === 'own' ? null : await readSettings(sftp, file);
  if (cur && a.strict && Object.keys(cur.settings).some((k) => k !== 'hooks' && k !== 'description')) {
    throw new Error(`${file} 里有 hooks / description 以外的内容，${a.name} 会整个文件不认，没有改动`);
  }
  const jf = a.json && posix.join(P.home, a.json.file), jcur = a.json ? await readSettings(sftp, jf) : null;
  await mkdirs(sftp, P.home, P.dir);
  await mkdirs(sftp, P.home, posix.dirname(file));
  await writeAtomic(sftp, P.script, P.scriptText, 0o755);
  await p((cb) => sftp.chmod(P.script, 0o755, cb)).catch(() => {});
  if (P.win) await writeAtomic(sftp, P.watch, WATCH_PS1, 0o644);
  for (const ev of wraps(P, a)) await writeAtomic(sftp, posix.join(P.dir, wrapName(a, ev)), wrapText(a, ev), 0o755);
  const cmd = cmdFor(P, a);
  let backup = null;
  if (a.kind === 'plugin') {
    await writeAtomic(sftp, file, a.plugin, 0o644);
  } else if (a.kind === 'own') {
    await writeAtomic(sftp, file, JSON.stringify(addHooks({}, a, P.cmd, cmd), null, 2) + '\n', 0o644);
  } else {
    // 第一次装之前备份原来的设置 (之后再装不覆盖备份)
    if (cur.text != null) {
      backup = `${file}.bak-sshweb`;
      if (!(await exists(sftp, backup))) await p((cb) => sftp.writeFile(backup, cur.text, { mode: 0o600 }, cb));
    }
    await writeAtomic(sftp, file, JSON.stringify(addHooks(cur.settings, a, P.cmd, cmd), null, 2) + '\n', 0o600);
  }
  let toml = null; // 顺带写的 TOML 配置：set 加上了 / kept 你自己写过这一项，没动
  if (a.toml) {
    const tf = posix.join(P.home, a.toml.file);
    const old = await readText(sftp, tf), next = tomlSet(old, a.toml);
    if (next != null) await writeAtomic(sftp, tf, next, 0o644);
    // 没改：上次装的时候加过 (带标记) 还是 set；不带标记的是你自己写的
    toml = { file: '~/' + a.toml.file, line: `${a.toml.key} = ${a.toml.value}`, key: a.toml.key, state: next != null || old?.includes(TOML_MARK) ? 'set' : 'kept' };
  }
  if (a.json) { // 顺带写的 JSON 设置 (结果同 toml)：加上了记一笔，卸载时才知道是 SSH-WEB 加的
    const next = jsonSet(jcur.settings, a.json), mark = jsonMark(P, a);
    if (next) {
      await mkdirs(sftp, P.home, posix.dirname(jf));
      await writeAtomic(sftp, jf, JSON.stringify(next, null, 2) + '\n', 0o644);
      await writeAtomic(sftp, mark, JSON.stringify({ file: a.json.file, key: a.json.key, value: a.json.value, created: jcur.text == null }) + '\n', 0o644);
    }
    toml = { file: '~/' + a.json.file, line: jsonLine(a.json), key: a.json.key, state: next || (await exists(sftp, mark)) ? 'set' : 'kept' };
  }
  setInstalled(sess, true); // 这台主机从现在起只按钩子推送
  if (P.win) rewatch(sess); // Windows：读事件的通道之前没有 watch.ps1 跑不起来，现在重开
  return { ok: true, agent: a.id, config: file, settings: file, backup, toml };
}

async function uninstall(sess, id) {
  const a = agentOf(id);
  if (!a) throw new Error('不认识的 Agent');
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const file = fileOf(P, a);
  if (a.kind === 'plugin' || a.kind === 'own') {
    await p((cb) => sftp.unlink(file, cb)).catch(() => {});
  } else {
    const { settings, text } = await readSettings(sftp, file);
    if (text != null && hookCount(settings, a)) await writeAtomic(sftp, file, JSON.stringify(removeHooks(settings, a), null, 2) + '\n', 0o600);
  }
  if (P.win && a.winWrap) for (const [ev] of a.events) await p((cb) => sftp.unlink(posix.join(P.dir, wrapName(a, ev)), cb)).catch(() => {});
  if (a.toml) { // 只去掉装的时候加的那几行；装的时候新建的文件，去掉后空了就删
    const tf = posix.join(P.home, a.toml.file);
    const next = tomlUnset(await readText(sftp, tf));
    if (next === '') await p((cb) => sftp.unlink(tf, cb)).catch(() => {});
    else if (next != null) await writeAtomic(sftp, tf, next, 0o644);
  }
  if (a.json) { // 只去掉装的时候加的那一项；装的时候新建的文件，去掉后空了就删。设置文件坏了就不动它
    const jf = posix.join(P.home, a.json.file), mark = jsonMark(P, a);
    const rec = await readText(sftp, mark);
    if (rec != null) {
      const cur = await readSettings(sftp, jf).catch(() => null);
      const next = cur && jsonUnset(cur.settings, a.json, true);
      if (next && !Object.keys(next).length && JSON.parse(rec).created) await p((cb) => sftp.unlink(jf, cb)).catch(() => {});
      else if (next) await writeAtomic(sftp, jf, JSON.stringify(next, null, 2) + '\n', 0o644);
      await p((cb) => sftp.unlink(mark, cb)).catch(() => {});
    }
  }
  // 别的 Agent 都没装了才删 hook.sh；删了以后终端响铃、看屏幕判断的状态照常推送
  const left = (await Promise.all(AGENTS.filter((x) => x !== a).map((x) => agentStatus(sftp, P, x)))).some((x) => x.installed || x.partial);
  if (!left) {
    for (const f of P.others) await p((cb) => sftp.unlink(f, cb)).catch(() => {}); // hook.sh / hook.ps1 / watch.ps1
    setInstalled(sess, false);
  }
  return { ok: true, scriptRemoved: !left };
}

function registerHooks(app) {
  const route = (fn) => async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      res.json(await fn(s, req.body?.agent && String(req.body.agent)));
    } catch (e) {
      res.status(400).json({ error: e.code === 3 ? '权限不足' : e.message || String(e) });
    }
  };
  app.post('/api/hooks/status', route(status));
  app.post('/api/hooks/install', route(install));
  app.post('/api/hooks/uninstall', route(uninstall));
}

module.exports = { registerHooks, refreshWatch, HOOK_SH, HOOK_PS1, WATCH_PS1, HOOK_EVENTS, OPENCODE_PLUGIN, PI_EXTENSION, AGENTS, addHooks, removeHooks, tomlSet, tomlUnset, TOML_MARK, jsonSet, jsonUnset };
