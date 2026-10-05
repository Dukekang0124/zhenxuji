/* 浏览器内集成探针（鉴别力比 Node 版更强）：
 * 真起一个 http server 服务 `npm run build:web` 产出的 www/，
 * 用本机 Chrome 加载真实 index.html（含 3 个 vendor 经典脚本），断言：
 *   ① 三脚本加载后 window.Capacitor 存在、Plugins.AppInstallPlugin / Filesystem 已注册
 *      （这正是「应用内更新」能成立的前提：vendor 脚本真把全局与插件建出来了）
 *   ② 调 performUpdate(APK) 时 window.open 调用 = 0（核心修复点：不再跳出应用）
 *   ③ 原生 installApk 被调用 = 1（走应用内安装链路）
 * 若旧版（无 vendor 脚本、走 window.open 兜底）在此探针下：② 会调用 window.open → 判失败。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require(require('path').join(
  process.env.NODE_PATH || '', 'playwright'));

const ROOT = path.join(__dirname, '..', 'www');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  let jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  // APK 下载地址走 mock，避免真联网
  await page.route('**/x.apk', (route) =>
    route.fulfill({ status: 200, body: Buffer.from([1, 2, 3, 4]) }));

  // 注意：不在外部注入 synapse 桩 —— 验证「发出的 index.html 自身」已包含桩并可用
  await page.goto(base + '/index.html', { waitUntil: 'load' });

  let failures = 0;
  const ok = (c, m) => { if (c) console.log('  ✓', m); else { console.error('  ✗', m); failures++; } };

  // 等 vendor 脚本把全局建出来
  await page.waitForFunction(() => !!globalThis.Capacitor, null, { timeout: 8000 })
    .catch(() => {});

  // ① 全局与插件是否真的注册上
  const reg = await page.evaluate(() => ({
    capacitor: !!globalThis.Capacitor,
    fs: !!(globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.Filesystem),
    install: !!(globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.AppInstallPlugin),
  }));
  ok(reg.capacitor, '① window.Capacitor 已被 vendor/capacitor.js 建出');
  ok(reg.fs, '① Capacitor.Plugins.Filesystem 已注册（filesystem-plugin.js 生效）');
  ok(reg.install, '① Capacitor.Plugins.AppInstallPlugin 已注册（app-install-plugin.js 生效）');

  // ② + ③ 覆盖插件方法 + 监视 window.open，再调 performUpdate
  const result = await page.evaluate(async (apkUrl) => {
    window.__open = 0; window.__install = 0;
    const origOpen = window.open;
    window.open = (...a) => { window.__open++; console.log('[window.open]', a); };
    // 用 mock 替换真实插件对象（避免浏览器无原生实现报错，同时计数）
    globalThis.Capacitor.Plugins.AppInstallPlugin = {
      canInstallUnknownApps: async () => ({ granted: true }),
      openInstallUnknownAppsSettings: async () => ({}),
      installApk: async () => { window.__install++; return { message: 'ok' }; },
    };
    globalThis.Capacitor.Plugins.Filesystem = {
      writeFile: async () => {},
      getUri: async () => ({ uri: 'file:///cache/x.apk' }),
    };
    // 直接用 mock fetch 拿到 APK 字节，避免依赖网络路由（测试只关心「行为」）
    globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])]) });
    const m = await import('/js/update.js');
    let r, err;
    try {
      r = await m.performUpdate({ updateUrl: apkUrl }, true);
    } catch (e) { err = String(e && e.stack || e); }
    return { open: window.__open, install: window.__install, r, err,
      hasFs: !!globalThis.Capacitor.Plugins.Filesystem,
      hasInstall: !!(globalThis.Capacitor.Plugins.AppInstallPlugin && globalThis.Capacitor.Plugins.AppInstallPlugin.installApk) };
  }, base + '/x.apk');

  ok(result.open === 0, '② APK 更新路径未调用 window.open（核心修复点：不跳出应用）');
  ok(result.install === 1, '③ 原生 installApk 被调用 1 次（走应用内安装链路）');
  ok(result.r && result.r.ok === true && result.r.mode === 'apk', '③ 返回 {ok:true, mode:apk}');
  if (result.err || result.install !== 1) {
    console.log('  [debug] result =', JSON.stringify(result, null, 2));
  }

  if (jsErrors.length) console.log('  （页面 JS 错误，供参考，不阻断断言）:\n   - ' + jsErrors.join('\n   - '));

  await browser.close();
  server.close();
  console.log(failures === 0 ? '\nBROWSER ALL PASS ✅' : `\n${failures} FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('运行异常:', e); server.close(); process.exit(2); });
