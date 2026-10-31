'use strict';
// 各 Agent 文件共用的小工具 (会话历史抽出来的字段怎么解析、事件名怎么统一)

const str = (v) => (typeof v === 'string' ? v : '');
// 「"…"」(JSON 字符串) → 文字；坏了就原样
const unq = (v) => { if (!v) return ''; try { return str(JSON.parse(v)); } catch { return v; } };
// JSON 字符串里面的内容 (没有外面的引号)
const unesc = (v) => { if (!v) return ''; try { return str(JSON.parse(`"${v}"`)); } catch { return v; } };
const parseJson = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; } };
const oneLine = (s, n = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// 你说的话：去掉 Grok 的 <user_query> 包装、开头的 <system-reminder> 之类
const cleanPrompt = (s) => oneLine(String(s || '').replace(/<\/?user_query>/g, '').replace(/^(\s*<[a-z-]+>[\s\S]*?<\/[a-z-]+>)+/i, ''));
// 会话历史脚本输出里一个会话的某个字段 (第一个值)
const field = (r, k) => (r.f[k] || [])[0] || '';
// 事件名统一成小写下划线 (Grok 可能是 userPromptSubmit / user_prompt_submit)
const evName = (v) => String(v || '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();

module.exports = { str, unq, unesc, parseJson, oneLine, cleanPrompt, field, evName };
