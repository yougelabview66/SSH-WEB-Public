'use strict';
// 版本号：package.json 和 package-lock.json 要一样，网页上显示的、app.js / style.css 后面带的 ?v= 都是 package.json 的
// (只改了 package-lock.json 的话，网页一直显示旧版本，浏览器还会继续用缓存里的旧 app.js)
const { BASE, ok } = require('./helpers');
const pkg = require('../package.json'), lock = require('../package-lock.json');

(async () => {
  ok(pkg.version === lock.version && pkg.version === lock.packages[''].version, `package.json (${pkg.version}) 和 package-lock.json (${lock.version} / ${lock.packages[''].version}) 版本一样`);
  const html = await (await fetch(BASE + '/')).text();
  ok(html.includes(`content="${pkg.version}"`) && html.includes(`/app.js?v=${pkg.version}`) && html.includes(`/style.css?v=${pkg.version}`), `首页的版本号和 app.js / style.css 的 ?v= 都是 ${pkg.version}`);
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
