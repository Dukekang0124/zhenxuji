/**
 * audit-flow.cjs — 真实交互链路复检：不走模块直调，走真实按钮点击。
 * 目的：抓 selftest 里"模块级全绿但整条流程其实是坏的"这类漏网之鱼。
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4601;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
};

function startServer() {
  // 🔴 mock 返回的版本必须**严格大于** APP 真版本，否则升级一 bump 版本这里就假红
  //    （实测 0.3.2→0.4.0 时 mock 还写死 0.4.0，compare 判成"已是最新"，4 条断言全挂）。
  //    从 index.html 读真版本再递增 patch 位，以后升级不用改测试。
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const v = (html.match(/window\.APP_VERSION\s*=\s*'([\d.]+)'/) || [])[1] || '0.0.0';
  const bumped = v.split('.').map(Number).map((n, i) => (i === 2 ? n + 1 : n)).join('.');
  console.log('[audit-flow] 真版本 =', v, '| mock 伪装成新版本 =', bumped);

  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    if (p === '/version.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        latest_version: bumped, is_force: false, update_url: '',
        update_content: '这次修了一些小问题，用起来更顺手。', update_time: '2026-10',
      }));
    }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(PORT, () => r({ close: () => s.close() })));
}

const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;
function check(n, ok, d) {
  if (ok) { pass++; console.log('  ✓ ' + n + (d ? '  — ' + d : '')); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  — ' + d : '')); }
}

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 160)));

  console.log('\n===== 真实路径：填了服务地址后点「检查更新」 =====');
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(400);

  // 1) 进设置页
  await page.click('[data-tab="settings"]');
  await page.waitForTimeout(300);
  const onSettings = await page.evaluate(() => !!document.querySelector('[data-act="checkUpdate"]'));
  check('设置页有「检查版本更新」按钮', onSettings);

  // 2) 填一个会返回新版本的服务地址（上面 server 对 /version.json 返回 0.4.0）
  await page.evaluate(() => {
    const d = document.querySelector('#advPanel');
    if (d && !d.open) d.open = true;
    const ep = document.getElementById('endpoint');
    if (ep) { ep.value = 'http://127.0.0.1:' + location.port; }
  });
  await page.waitForTimeout(150);
  await page.click('[data-act="saveKeys"]');
  await page.waitForTimeout(300);

  // 3) 真的点「检查版本更新」
  const hasBtn = await page.evaluate(() => !!document.querySelector('[data-act="checkUpdate"]'));
  if (hasBtn) await page.click('[data-act="checkUpdate"]');
  await page.waitForTimeout(1800);

  const after = await page.evaluate(() => ({
    modal: !!document.querySelector('.umask'),
    text: (document.getElementById('updateMsg') || {}).textContent || '',
    toast: (document.getElementById('toast') || {}).textContent || '',
  }));
  check('点击后有新版本提示', after.text.includes('0.4.0') || after.toast.includes('0.4.0') || after.modal,
    'updateMsg=' + JSON.stringify(after.text) + ' toast=' + JSON.stringify(after.toast) + ' modal=' + after.modal);
  check('🔴 更新弹窗真的弹出来了（不是要等下次 render）', after.modal === true,
    'modal=' + after.modal);

  // 4) 弹窗里的按钮能不能点
  if (after.modal) {
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.umodal button')).map((b) => b.textContent.trim()));
    check('弹窗按钮齐全（含「稍后提醒」）', btns.length >= 2, JSON.stringify(btns));
    await page.click('[data-act="snoozeUpdate"]');
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => !document.querySelector('.umask'));
    check('点「稍后提醒」弹窗关闭', closed);
  }

  // 5) 冷却是否真的写入
  const cooled = await page.evaluate(() => Number(localStorage.getItem('zhenxuji.update.snoozeAt') || 0));
  check('冷却时间戳已写入', cooled > 0, 'snoozeAt=' + cooled);

  // 6) 手动再点一次（此时在冷却内）应该还能看到更新提示
  await page.click('[data-tab="settings"]');
  await page.waitForTimeout(250);
  const btn2 = await page.evaluate(() => !!document.querySelector('[data-act="checkUpdate"]'));
  if (btn2) await page.click('[data-act="checkUpdate"]');
  await page.waitForTimeout(1600);
  const after2 = await page.evaluate(() => ({
    modal: !!document.querySelector('.umask'),
    text: (document.getElementById('updateMsg') || {}).textContent || '',
  }));
  check('冷却期内手动检查仍能看到新版本（不被静默吞掉）',
    after2.modal || after2.text.includes('0.4.0'),
    'modal=' + after2.modal + ' updateMsg=' + JSON.stringify(after2.text));

  check('全程无 JS 错误', errs.length === 0, errs.join(' | ') || 'none');

  await browser.close();
  srv.close();
  console.log('\n==== 真实链路复检：' + pass + ' 通过 / ' + fail + ' 异常 =====');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
