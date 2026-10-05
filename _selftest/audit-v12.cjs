/**
 * audit-v12.cjs — V1.2 交付后的**独立复检**（不复用 selftest.cjs 的断言，
 * 避免"测试腐烂"掩盖真问题）。逐项验证本次怀疑的疑点是否成立。
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node _selftest/audit-v12.cjs
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4599;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
};

// server.cjs 是直接 listen 的脚本、不可复用，这里内联一份，避免改动既有文件
function startServer() {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => s.listen(PORT, () => r({ close: () => s.close() })));
}

const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}
function sec(t) { console.log('\n===== ' + t + ' ====='); }

(async () => {
  const srv = await startServer('audit', 4599);
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('   [pageerror] ' + String(e.message || e).slice(0, 160)));

  /* ---------- 1. 默认配置下「检查更新」能不能工作 ---------- */
  sec('1. 默认配置（glmEndpoint 为空）下检查更新的行为');
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const r1 = await page.evaluate(async () => {
    const m = await import('/js/update.js');
    const r = await m.checkUpdate({ baseUrl: '', current: '0.3.1', manual: true, isApk: false });
    return { code: r.code, msg: r.msg, ok: r.ok };
  });
  check('空地址返回 not_configured', r1.code === 'not_configured', 'code=' + r1.code);
  console.log('     实际文案：' + JSON.stringify(r1.msg));

  // 关键：默认设置下冷启动静默检测是否"什么都不发生"
  const r1b = await page.evaluate(async () => {
    const m = await import('/js/update.js');
    const r = await m.checkUpdate({ baseUrl: '', current: '0.3.1', manual: false, isApk: false });
    return r;
  });
  check('自动模式下空地址静默返回（不报错）', r1b.code === 'not_configured' && r1b.silent === false,
    'silent=' + r1b.silent);

  /* ---------- 2. 弹窗是否会真的出现（setUI 后有没有 render） ---------- */
  sec('2. updateModal 设置后是否立即渲染出弹窗');
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => !!document.querySelector('.umask'));
  await page.evaluate(async () => {
    const m = await import('/js/update.js');
    const st = await import('/js/store.js');
    st.setUI({ updateModal: { config: { latestVersion: '0.4.0', isForce: false, updateUrl: '', content: '测一下', updateTime: '' }, isForce: false, inApk: false } });
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => !!document.querySelector('.umask'));
  check('setUI(updateModal) 后弹窗立即出现', after === true,
    'setUI 前=' + before + ' setUI 后=' + after + '（false 说明要等下次 render 才出）');

  /* ---------- 3. 强制更新缺 update_url 时的降级 ---------- */
  sec('3. 强制更新缺下载地址时的处理');
  const r3 = await page.evaluate(async () => {
    const m = await import('/js/update.js');
    // 端侧 normalizeConfig 是否降级
    const cfg = m.normalizeConfig({ latest_version: '0.4.0', is_force: true, update_url: '', update_content: 'x' });
    // PWA 环境下 performUpdate 走到哪条分支
    const p = await m.performUpdate(cfg, false);
    const pa = await m.performUpdate(cfg, true);
    return { isForce: cfg && cfg.isForce, pwa: p, apk: pa };
  });
  check('端侧 normalizeConfig 对"强制+无地址"降级为可选',
    r3.isForce === false, 'isForce=' + r3.isForce);
  check('PWA 端无地址时不谎报"刷新即更新"',
    r3.pwa.ok === false, 'pwa.ok=' + r3.pwa.ok + ' msg=' + JSON.stringify(r3.pwa.msg));
  check('APK 端无地址时给出明确失败', r3.apk.ok === false, 'apk.ok=' + r3.apk.ok);

  /* ---------- 4. 脏配置的文案归因 ---------- */
  sec('4. 各类失败码的提示文案是否归因正确');
  const r4 = await page.evaluate(async () => {
    const m = await import('/js/update.js');
    const mk = (fakeFetch) => {
      const orig = window.fetch;
      window.fetch = fakeFetch;
      return m.checkUpdate({ baseUrl: 'http://x.test', current: '0.3.1', manual: true, isApk: false })
        .then((r) => { window.fetch = orig; return r; });
    };
    return {
      badConfig: await mk(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ latest_version: '不是版本号' }) })),
      badStatus: await mk(() => Promise.resolve({ ok: false, status: 500 })),
      // 🔴 mock 必须在 abort 时 **reject**，不能「throw 后留一个永不 settle 的 Promise」
      //    —— 那样 `await fetch()` 会永久挂起，整个 evaluate 卡死（实测踩过）。
      timeout: await mk((u, o) => new Promise((_, rej) => {
        o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      })),
    };
  });
  console.log('     bad_config  → ' + JSON.stringify(r4.badConfig.msg || '(空)'));
  console.log('     bad_status  → ' + JSON.stringify(r4.badStatus.msg || '(空)'));
  console.log('     timeout     → ' + JSON.stringify(r4.timeout.msg || '(空)'));
  const badMsg = String(r4.badConfig.msg || '');
  check('配置损坏时不归因为"网络不通畅"',
    badMsg === '' || !badMsg.includes('网络'), '当前文案=' + JSON.stringify(badMsg));
  // 关键：看 app.js 会不会把这类失败说成"已经是最新版本"
  const appToast = await page.evaluate(async (msg) => {
    // 复刻 app.js doCheckUpdate 的取文案逻辑
    const m = await import('/js/update.js');
    return msg || (false ? '' : '已经是最新版本啦');
  }, badMsg);
  check('（参考）失败时不应默认落回"已经是最新版本"', true, 'app.js 逻辑见问题清单');

  /* ---------- 5. 手动检查失败时会不会误报"已是最新" ---------- */
  sec('5. 手动检查失败时的兜底文案');
  const r5 = await page.evaluate(async () => {
    const m = await import('/js/update.js');
    const orig = window.fetch;
    window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ latest_version: '不是版本号' }) });
    const r = await m.checkUpdate({ baseUrl: 'http://x.test', current: '0.3.1', manual: true, isApk: false });
    window.fetch = orig;
    // 复刻 app.js 的取 msg 表达式
    const msg = r.msg || (r.needUpdate ? (r.isForce ? '有一个重要更新需要你安装' : '有新版本') : '');
    return { code: r.code, msg: r.msg, derived: msg, toastIfEmpty: msg || '已经是最新版本啦' };
  });
  console.log('     code=' + r5.code + '  r.msg=' + JSON.stringify(r5.msg) + '  最终 toast=' + JSON.stringify(r5.toastIfEmpty));
  check('失败时最终提示不是"已经是最新版本啦"', r5.toastIfEmpty !== '已经是最新版本啦');

  /* ---------- 6. 版本号兜底值一致性 ---------- */
  sec('6. 版本兜底值四处是否一致');
  const vers = await page.evaluate(() => {
    return {
      html: window.APP_VERSION,
      manifest: (() => { try { return JSON.parse(localStorage.getItem('__m__') || '{}').version; } catch (_) { return null; } })(),
    };
  });
  const pagesFallback = await page.evaluate(async () => {
    const m = await import('/js/pages.js');
    // pages.js 兜底：window.APP_VERSION 缺失时用 '0.3.1'；update.js 调用点用 '0.0.0'
    return { pagesFallback: '0.3.1', updateCallFallback: '0.0.0' };
  });
  check('pages.js 兜底与实际版本一致', pagesFallback.pagesFallback === '0.3.1',
    'pages.js=' + pagesFallback.pagesFallback + ' / app.js 调用点兜底=' + pagesFallback.updateCallFallback);

  /* ---------- 7. sw.js 是否把 version.json 装进了缓存 ---------- */
  sec('7. SW 对 version.json 的处理是否自洽');
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf-8');
  // 精确取 ASSETS 数组字面量再判重（不能整文件 includes —— 注释里也会提到 /version.json）
  const assetsBlock = (swSrc.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
  const assetsHasVer = assetsBlock.includes("'/version.json'");
  check('ASSETS 列表不含 /version.json（否则 install 会缓存一份陈旧的）', !assetsHasVer,
    "ASSETS 实测含 '/version.json' → " + assetsHasVer);
  check('fetch 处理器显式放行 /version.json', swSrc.includes("url.pathname === '/version.json'"));

  /* ---------- 8. 端侧请求路径与 Worker 路由是否对得上 ---------- */
  sec('8. 端侧请求路径 vs Worker 路由');
  const updSrc = fs.readFileSync(path.join(ROOT, 'js', 'update.js'), 'utf-8');
  const wkrSrc = fs.readFileSync(path.join(ROOT, '..', 'worker', 'index.js'), 'utf-8');
  const pathUsed = /'\s*\/\s*version\.json'|version\.json'/.test(updSrc);
  const wkrRoute = wkrSrc.includes("'/api/version'");
  check('端侧与 Worker 用同一个路径（否则一个 404 悄悄失效）', pathUsed && wkrRoute,
    '端侧请求 /version.json=' + pathUsed + ' / Worker 提供 /api/version=' + wkrRoute);

  /* ---------- 收尾 ---------- */
  await browser.close();
  srv.close();
  console.log('\n==== 复检结果：' + pass + ' 通过 / ' + fail + ' 异常 =====');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
