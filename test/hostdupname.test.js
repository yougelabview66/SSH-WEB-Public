'use strict';
// 新建 / 编辑主机时名字和已有的一样：先问一下 (标签、主机状态卡片、推送里分不清是哪台)。
// 取消：留在表单里、选中名字；确定：照样保存。编辑时名字没改 (重名是以前答应过的)、新建不重名的：不问
const { BASE, ok, wait, run, launch, post } = require('./helpers');

run(async () => {
  await post('/api/hosts', { name: 'NAS', host: 'nas.example.com', port: 22, username: 'demo', password: 'x' });
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const asked = [];
  let answer = false;
  p.on('dialog', (d) => { asked.push(d.message()); (answer ? d.accept() : d.dismiss()).catch(() => {}); });
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  const count = async () => (await (await fetch(BASE + '/api/hosts')).json()).length;

  // 1. 新建一个也叫 NAS 的 (大小写不同也算)：问；取消 → 没存、表单还开着、名字选中
  await p.click('#btnNew'); await wait(300);
  await p.fill('#hostForm [name=name]', 'nas'); await p.fill('#hostForm [name=host]', '192.168.1.30');
  await p.fill('#hostForm [name=username]', 'demo'); await p.fill('#hostForm [name=password]', 'x');
  await p.click('#btnSaveOnly'); await wait(500);
  const sel = await p.evaluate(() => { const i = document.querySelector('#hostForm [name=name]'); return document.activeElement === i && i.selectionEnd - i.selectionStart === i.value.length; });
  ok(asked.length === 1 && /已经有一台主机叫「nas」/.test(asked[0]) && /demo@nas\.example\.com/.test(asked[0]), '名字和已有的一样：保存前问一下，说明是哪台: ' + JSON.stringify(asked));
  ok(await count() === 1 && await p.isVisible('#modal') && sel, '选取消：没保存，表单还开着，名字选中方便改');

  // 2. 坚持用这个名字：确定 → 存上
  answer = true;
  await p.click('#btnSaveOnly'); await wait(800);
  ok(asked.length === 2 && await count() === 2 && !(await p.isVisible('#modal')), '选确定：照样保存');

  // 3. 编辑已有的 NAS、名字不变 (现在有两台叫 NAS，以前答应过)：不问；新建不重名的：不问
  const row = p.locator('.host', { hasText: 'nas.example.com' }).first();
  await row.hover(); await row.locator('[data-op=edit]').click(); await wait(300);
  await p.click('#btnSaveOnly'); await wait(600);
  await p.click('#btnNew'); await wait(300);
  await p.fill('#hostForm [name=name]', 'gpu-box'); await p.fill('#hostForm [name=host]', '192.168.1.40');
  await p.fill('#hostForm [name=username]', 'demo'); await p.fill('#hostForm [name=password]', 'x');
  await p.click('#btnSaveOnly'); await wait(600);
  ok(asked.length === 2 && await count() === 3, '编辑时名字不变、新建不重名的：都不问: ' + JSON.stringify(asked.slice(2)));
  await browser.close();
});
