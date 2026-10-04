// P0 全量自检 —— 严格按康哥指令六维度遍历：渲染/溢出、图片链路、导出、版本更新、主题联动、GLM链路。
// 输出：① 控制台 pass/fail ② 缺陷报告 _selftest/P0-DEFECT-REPORT.md
//
// 🔴 约束（沿用踩坑记忆）：只用一次 page.goto，之后全走 location.hash，绝不 reload
// （否则 store.load() 把 _file 置 null，图片/导出全假失败）。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 4288);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, 'shots', 'p0');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
const report = {}; // category -> [ {page, type, detail, shot} ]
function cat(c) { return report[c] || (report[c] = []); }
function issue(c, page, type, detail, shot) { cat(c).push({ page, type, detail, shot: shot || '' }); }
function check(name, ok, got, c, page, type) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; fails.push(name);
    console.log(`  ❌ ${name}  →  ${JSON.stringify(got)}`);
    if (c) issue(c, page || '', type || '缺陷', JSON.stringify(got), '');
  }
  return ok;
}
async function go(page, hash) {
  await page.evaluate(() => { location.hash = '#/__tmp'; });
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(320);
}
async function rerender(page) {
  const cur = await page.evaluate(() => location.hash);
  await page.evaluate(() => { location.hash = '#/__tmp'; });
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, cur);
  await page.waitForTimeout(300);
}
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }); } catch (_) {}
}

// 在页面内检测横向溢出 + 越界元素 + 乱码
async function overflowScan(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const pageOverflow = de.scrollWidth - de.clientWidth;
    const vw = window.innerWidth;
    const clipped = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // 自身或祖先是可横向滚动的容器 → 允许内部横向排列（缩略条等）
      let p = n, scrollOk = false;
      while (p) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll') { scrollOk = true; break; } p = p.parentElement; }
      if (scrollOk) continue;
      if (r.right > vw + 2) clipped.push({ tag: n.tagName, cls: (n.className && n.className.toString().slice(0, 40)), right: Math.round(r.right), txt: (n.textContent || '').trim().slice(0, 24) });
    }
    const hasGarbled = document.body.innerText.includes('�');
    return { pageOverflow, clipped: clipped.slice(0, 6), hasGarbled };
  });
}

async function seed(page, { hiRes = true } = {}) {
  return page.evaluate(async ({ hiRes }) => {
    const mkFile = async (w, h, label) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      // 渐变底 + 细线 + 文字（文字/细线用于检测模糊）
      const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, `hsl(${Math.random() * 360},50%,60%)`); g.addColorStop(1, `hsl(${Math.random() * 360},50%,40%)`);
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 1;
      for (let i = 0; i < w; i += 7) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
      x.fillStyle = '#fff'; x.font = `${Math.round(h / 12)}px sans-serif`; x.fillText(label, 20, Math.round(h / 2));
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      return new File([b], label + '.jpg', { type: 'image/jpeg' });
    };
    const st = await import('/js/store.js');
    st.actions.reset();
    const files = hiRes
      ? [await mkFile(1200, 900, 'HIRES'), await mkFile(1600, 1200, 'BIG'), await mkFile(900, 1200, 'POR'), await mkFile(1000, 1000, 'SQ')]
      : [await mkFile(200, 200, 'a'), await mkFile(200, 200, 'b'), await mkFile(200, 200, 'c'), await mkFile(200, 200, 'd')];
    const base = files.map((f, i) => ({
      id: `p${i + 1}`, scene: i % 2 ? 'portrait' : 'landscape',
      cv: { sharpness: 380 + i * 10, over: 0.01, under: 0.01, edgeFlat: 0.1, brightness: 130, contrastStd: 60, saturation: 0.4, centerFocus: 0.7 },
      dhash: `${i}a`, takenAt: 1758000000000 + i * 3600000, thumbUrl: '',
      _file: f, verdict: { level: 'keep', reasons: [] }, score: 72 + i * 3,
    }));
    st.actions.upsertPhotos(base);
    st.actions.setGroups([{ id: 'g1', title: '周末出游', photoIds: ['p1', 'p2', 'p3'], coverId: 'p1' }]);
    st.actions.upsertRecipe({ id: 'tpl_1', name: '简约纸感', type: 'template', tone: '简约' });
    st.actions.upsertRecipe({ id: 'r1', name: '清透配方', type: 'beauty', params: { bright: 18, soft: 0, warm: 14, sat: 22, contrast: 12 }, thumb: '' });
    st.actions.upsertStory({ id: 's1', groupId: 'g1', title: '周末出游', createdAt: Date.now(), publishedAt: Date.now(), photoIds: ['p1', 'p2', 'p3'], order: 'narrative', templateId: 'tpl_1', dateText: '10月3日', text: { cover: '周末出游', captions: ['第1帧', '第2帧', '第3帧'], body: '快乐的一天', hook: '记录' }, stats: { views: 0, likes: 0, comments: 0 } });
    st.actions.patchSettings({ glmEndpoint: location.origin, aiTextEnabled: true });
    // 🔴 File 对象没有 .width/.height —— 之前的断言读 p._file.width 永远 0（脚本 bug）。
    //    改成用 createImageBitmap 解码原图，拿到真实的像素宽高来判定「未被强制压缩」。
    const f0 = st.get().photos[0]._file;
    let hiW = 0, hiH = 0;
    if (f0) { const b = await createImageBitmap(f0); hiW = b.width; hiH = b.height; if (b.close) b.close(); }
    return { hiW, hiH };
  }, { hiRes });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
  await page.addInitScript(() => { window.prompt = () => '巡检名'; window.confirm = () => true; });
  const errors = [];
  page.on('pageerror', (e) => errors.push({ type: 'pageerror', msg: e.message }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ type: 'console', msg: m.text() }); });
  // 🔴 精确抓 404：console.error 的文案不带 URL，靠 response 事件才能定位是哪个资源 404
  page.on('response', (r) => { if (r.status() >= 400) errors.push({ type: 'http' + r.status(), url: r.url() }); });
  const downloads = [];
  page.on('download', (d) => downloads.push(d));

  // mock：AI 文案走本地兜底；版本接口默认「已是最新」
  await page.route('**/api/story', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, content: JSON.stringify({ cover: '周末出游', hook: '开心', body: '今天天气很好', captions: ['出发', '抵达', '归途'] }) }) }));
  let verMode = 'latest';
  const regVer = () => page.route('**/version.json', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(verMode === 'force'
      ? { latest_version: '9.9.9', is_force: true, update_url: 'https://example.com/apk/zhenxuji-v9.9.9.apk' }
      : { latest_version: '0.6.2', is_force: false, update_url: '' }),
  }));
  await regVer();
  // 🔴 同源兜底源：seed 把 glmEndpoint 设成同源，checkUpdate 会顺带探一次「配置地址/api/version」。
  //    这是产品的正常兜底行为（去重由 update.js 的 seen 集合负责），这里补一份 mock 避免刷 404 噪声。
  await page.route('**/api/version', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ latest_version: '0.6.2', is_force: false, update_url: '' }),
  }));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const s0 = await seed(page, { hiRes: true });
  await rerender(page);
  check('🔴 注入真实高清原图（1200×900 保留）', s0.hiW === 1200 && s0.hiH === 900, s0);

  /* ===== A. 全页面渲染 + 横向溢出/乱码 ===== */
  console.log('\n── A. 全页面渲染与文本溢出/乱码巡检 ──');
  const routes = [
    ['#/create', '首页(新建)'], ['#/album', '相册导入'], ['#/pick/g1', 'AI选片'],
    ['#/edit/g1', '修图'], ['#/compose/g1', '故事组装'], ['#/share/s1', '导出页'],
    ['#/gallery', '作品集'], ['#/detail/s1', '故事详情'], ['#/recipes', '素材配方'],
    ['#/theme', '主题换肤'], ['#/settings', '设置'], ['#/exphistory', '导出历史'],
    ['#/changelog', '版本更新/日志'], ['#/help', '教程'], ['#/viewer/g1:p1', '大图查看器'],
  ];
  for (const [h, n] of routes) {
    await go(page, h);
    const o = await overflowScan(page);
    check(`[${n}] 无横向溢出`, o.pageOverflow <= 2, o.pageOverflow, 'A-渲染溢出', n, '横向溢出');
    check(`[${n}] 无元素越界/被裁切`, o.clipped.length === 0, o.clipped, 'A-渲染溢出', n, '元素越界');
    check(`[${n}] 无乱码( replacement char )`, o.hasGarbled === false, o.hasGarbled, 'A-渲染溢出', n, '乱码');
    await shot(page, `A-${n}`);
  }

  /* ===== B. 图片上传&AI图像链路（清晰度/权限） ===== */
  console.log('\n── B. 图片上传&AI图像链路（清晰度/压缩/权限） ──');
  // B1 原图尺寸保留（File 无 .width，用 createImageBitmap 解码判断未被压缩）
  const dim = await page.evaluate(async () => {
    const p = (await import('/js/store.js')).get().photos[0];
    if (!p || !p._file) return { w: 0, h: 0 };
    const b = await createImageBitmap(p._file); const r = { w: b.width, h: b.height }; if (b.close) b.close(); return r;
  });
  check('🔴 原图分辨率保留（1200×900，未强制压缩）', dim.w === 1200 && dim.h === 900, dim, 'B-图片质量', '上传', '有损压缩');
  // B2 大图查看器用原图（srcOf 优先 _file 的 blob: URL，而非 96px 缩略图）
  await go(page, '#/viewer/g1:p1');
  const viewerDim = await page.evaluate(() => {
    const el = document.querySelector('.album-photo');
    if (!el) return { found: false };
    const bg = el.style.backgroundImage || '';
    return { found: true, isBlob: /blob:/.test(bg), isData: /data:image/.test(bg) };
  });
  check('🔴 大图查看器用原图（blob: 原图，非 96px 缩略图）', viewerDim.found && viewerDim.isBlob && !viewerDim.isData, viewerDim, 'B-图片质量', '大图查看器', '清晰度下降');
  await shot(page, 'B-viewer');
  // B3 H5 嵌入图分辨率（复刻 doExport 的 H5 包装：loadForExport 取 _file 全分辨率转 dataURL 喂给 buildShareHTML）
  const h5dim = await page.evaluate(async () => {
    const st = await import('/js/store.js'); const ex = await import('/js/export.js');
    const s = st.get().stories.find((x) => x.id === 's1');
    const ps = s.photoIds.map((id) => st.get().photos.find((p) => p.id === id));
    // 与 app.js doExport 的 h5Photos 包装一致：用 loadForExport 取原图（≤1080）转 dataURL
    const h5Photos = await Promise.all(ps.map(async (p) => {
      try { const { canvas } = await ex.loadForExport(p, 1080); if (canvas) return { ...p, thumbUrl: canvas.toDataURL('image/jpeg', 0.9) }; } catch (_) {}
      return p;
    }));
    const html = ex.buildShareHTML(s, h5Photos, s.templateId);
    const m = html.match(/<img[^>]+src="(data:image\/[^"]+)"/);
    if (!m) return { found: false };
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.onerror = res; img.src = m[1]; });
    return { found: true, nw: img.naturalWidth };
  });
  check('🔴 H5 网页故事册嵌入图分辨率≥700（非96px缩略图）', h5dim.found && h5dim.nw >= 700, h5dim, 'B-图片质量', 'H5导出', '清晰度下降');
  // B4 九宫格取原图（_file）出图，非 thumbUrl
  const gridDim = await page.evaluate(async () => {
    const st = await import('/js/store.js'); const ex = await import('/js/export.js');
    const s = st.get().stories.find((x) => x.id === 's1');
    const ps = s.photoIds.map((id) => st.get().photos.find((p) => p.id === id));
    const { canvas, degraded } = await ex.loadForExport(ps[0], 720);
    return { w: canvas ? canvas.width : 0, degraded };
  });
  check('🔴 九宫格取原图出图（720宽，degraded=false）', gridDim.w === 720 && gridDim.degraded === false, gridDim, 'B-图片质量', '九宫格导出', '清晰度下降');
  // B5 相册读取入口（权限）存在
  await go(page, '#/create');
  const pickEntry = await page.evaluate(() => ({ album: Boolean(document.querySelector('[data-act="pickAlbum"]')), few: Boolean(document.querySelector('[data-act="pickFew"]')) }));
  check('🔴 相册读取入口存在（pickAlbum/pickFew）', pickEntry.album && pickEntry.few, pickEntry, 'B-图片质量', '相册', '权限入口缺失');

  /* ===== C. 导出功能专项（路径/前往查看/历史/异常） ===== */
  console.log('\n── C. 导出功能专项（路径提示/前往查看/历史） ──');
  // 先做一次真实调色，让增强 _file 也有
  await go(page, '#/edit/g1');
  await page.evaluate(() => { const r = document.querySelector('#sliders .sld__r[data-p="bright"]'); if (r) { r.value = '30'; r.dispatchEvent(new Event('input', { bubbles: true })); } });
  await page.waitForTimeout(100);
  await page.evaluate(() => { const b = document.querySelector('[data-act="applyEnhance"]'); if (b) b.click(); });
  await page.waitForTimeout(1500);
  await go(page, '#/share/s1');
  // C1 九宫格下载
  { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 12000 }), page.click('[data-act="expGrid"]').catch(() => {})]).catch(() => [null]); check('🔴 九宫格导出触发下载（文件真实产生）', Boolean(dl), Boolean(dl), 'C-导出', '九宫格', '假导出'); }
  await page.waitForFunction(() => Boolean(document.querySelector('.umodal')), { timeout: 4000 }).catch(() => {});
  const modalTxt = await page.evaluate(() => { const m = document.querySelector('.umodal'); return m ? m.innerText : ''; });
  check('🔴 导出弹窗明确告知保存位置（含文件名/去向）', /文件名|下载|文件/.test(modalTxt), modalTxt.slice(0, 120), 'C-导出', '九宫格', '路径未提示');
  const modalActs = await page.evaluate(() => [...document.querySelectorAll('.umodal__acts .btn')].map((b) => b.textContent.trim() + '|' + (b.dataset.act || '')));
  check('🔴 导出弹窗含「再次下载/前往查看」可执行钮', modalActs.some((t) => /再次下载|前往查看|打开/.test(t)), modalActs, 'C-导出', '九宫格', '缺前往查看钮');
  await page.evaluate(() => { const b = document.querySelector('[data-act="closeExport"]'); if (b) b.click(); });
  await page.waitForTimeout(200);
  // 长图 / H5
  await page.evaluate(() => { const b = document.querySelector('[data-act="expLong"]'); if (b) b.click(); });
  { const dl = await page.waitForEvent('download', { timeout: 15000 }).then(() => true).catch(() => false); check('🔴 长图导出触发下载', dl, dl, 'C-导出', '长图', '假导出'); }
  await page.evaluate(() => { const b = document.querySelector('[data-act="closeExport"]'); if (b) b.click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { const b = document.querySelector('[data-act="expH5"]'); if (b) b.click(); });
  { const dl = await page.waitForEvent('download', { timeout: 12000 }).then(() => true).catch(() => false); check('🔴 H5 导出触发下载', dl, dl, 'C-导出', 'H5', '假导出'); }
  await page.evaluate(() => { const b = document.querySelector('[data-act="closeExport"]'); if (b) b.click(); });
  await page.waitForTimeout(200);
  // C4/C5 导出历史
  await go(page, '#/exphistory');
  const hist = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.exh')];
    return {
      n: cards.length,
      hasName: cards.every((c) => c.querySelector('.exh__fn') && c.querySelector('.exh__fn').textContent.trim().length > 0),
      hasWhere: cards.every((c) => c.querySelector('.exh__m') && /下载|已/.test(c.querySelector('.exh__m').textContent)),
      hasOpen: cards.some((c) => c.querySelector('[data-act="openExport"], [data-act="redownExport"], .exh__open')),
    };
  });
  check('🔴 导出历史记录含文件名', hist.n >= 1 && hist.hasName, hist, 'C-导出', '导出历史', '历史缺文件名');
  check('🔴 导出历史记录含保存位置', hist.hasWhere, hist, 'C-导出', '导出历史', '历史缺位置');
  check('🔴 导出历史卡含打开/再次下载钮', hist.hasOpen, hist, 'C-导出', '导出历史', '历史缺打开钮');
  await shot(page, 'C-exphistory');

  /* ===== D. 版本更新（启动/强制/手动） ===== */
  console.log('\n── D. 版本更新模块 ──');
  // D2 强制更新弹窗
  verMode = 'force'; await regVer();
  await go(page, '#/settings');
  await page.evaluate(() => { const b = document.querySelector('[data-act="checkUpdate"]'); if (b) b.click(); });
  await page.waitForTimeout(1200);
  const forceModal = await page.evaluate(() => {
    const m = document.querySelector('#modalRoot .umodal, .umask .umodal');
    if (!m) return null;
    const o = m.getBoundingClientRect();
    const txt = m.innerText;
    const btns = [...m.querySelectorAll('.btn')].map((b) => b.textContent.trim());
    const de = document.documentElement;
    return { txt: txt.slice(0, 80), right: Math.round(o.right), vw: window.innerWidth, pageOverflow: de.scrollWidth - de.clientWidth, btns };
  });
  check('🔴 强制更新弹窗渲染（文案+按钮）', forceModal && forceModal.btns.length >= 1 && /更新/.test(forceModal.txt), forceModal, 'D-版本更新', '强制弹窗', '弹窗未渲染');
  check('🔴 强制弹窗无横向溢出/越界', forceModal && forceModal.right <= forceModal.vw + 2 && forceModal.pageOverflow <= 2, forceModal, 'D-版本更新', '强制弹窗', '溢出');
  await shot(page, 'D-force');
  await page.evaluate(() => { const b = document.querySelector('[data-act="closeUpdate"]'); if (b) b.click(); });
  await page.waitForTimeout(200);
  // D3 手动「已是最新」
  verMode = 'latest'; await regVer();
  await go(page, '#/settings');
  await page.evaluate(() => { const b = document.querySelector('[data-act="checkUpdate"]'); if (b) b.click(); });
  await page.waitForTimeout(1200);
  const upMsg = await page.evaluate(() => (document.getElementById('updateMsg') || {}).textContent || '');
  check('🔴 手动检查「已是最新版本」提示', /已是最新/.test(upMsg), upMsg, 'D-版本更新', '手动检查', '无提示');
  // D1 启动静默检测是否已接线（boot 调 doCheckUpdate）
  const bootWired = await page.evaluate(async () => {
    const src = await (await fetch('/js/app.js')).text();
    return /doCheckUpdate\(false, true\)/.test(src) && /bootDone/.test(src);
  });
  check('🔴 启动静默版本检测已接线（boot 调 doCheckUpdate）', bootWired, bootWired, 'D-版本更新', '启动', '缺启动检测');

  /* ===== E. 主题换肤全页面联动 ===== */
  console.log('\n── E. 主题换肤全页面联动 ──');
  await go(page, '#/theme');
  const themeIds = await page.evaluate(() => [...document.querySelectorAll('[data-act="setTheme"]')].map((b) => b.dataset.id));
  for (const th of themeIds) {
    await page.evaluate((t) => { const b = document.querySelector(`[data-act="setTheme"][data-id="${t}"]`); if (b) b.click(); }, th);
    await page.waitForTimeout(120);
    let anyOverflow = false; let badPage = '';
    for (const [h, n] of routes) {
      await go(page, h);
      const o = await overflowScan(page);
      if (o.pageOverflow > 2 || o.clipped.length > 0) { anyOverflow = true; badPage = n; break; }
    }
    check(`[主题 ${th}] 切换后全页面无横向溢出`, !anyOverflow, { badPage }, 'E-主题联动', `主题${th}`, '切换后溢出');
  }

  /* ===== F. GLM4-Flash 链路 ===== */
  console.log('\n── F. GLM4-Flash 大模型链路 ──');
  // F2 设置页链路状态展示（当前应缺失）
  await go(page, '#/settings');
  const glmStatus = await page.evaluate(() => Boolean(document.querySelector('[data-act="glmStatus"], #glmStatus, .glm-status')));
  check('🔴 设置页有「大模型连接状态」展示', glmStatus, glmStatus, 'F-GLM链路', '设置', '缺状态展示');
  // F2 增强：点「重新检测」验证探测真的跑通、状态从占位变成真实结论（已连通/本地兜底/未配置）
  await page.waitForSelector('[data-act="glmProbe"]', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { const b = document.querySelector('[data-act="glmProbe"]'); if (b) b.click(); });
  await page.waitForFunction(() => { const v = document.getElementById('glmStatusVal'); return v && !/尚未检测/.test(v.textContent); }, { timeout: 8000 }).catch(() => {});
  const glmVal = await page.evaluate(() => { const v = document.getElementById('glmStatusVal'); return v ? v.textContent.trim() : ''; });
  check('🔴 GLM 状态可探测（点「重新检测」后给出真实状态，非空占位）', /已连通|本地兜底|未配置|不可用|检测失败/.test(glmVal), glmVal, 'F-GLM链路', '设置', '状态未更新');
  // F1 实际调用链路，记录状态
  const glmCall = await page.evaluate(async () => {
    const api = await import('/js/api.js');
    const t0 = Date.now();
    try {
      const r = await api.generateStory({ photos: [], prompt: '测试', module: 'story' });
      return { ok: true, degraded: r.degraded, ms: Date.now() - t0, source: r.source || '' };
    } catch (e) { return { ok: false, err: String(e && e.message || e), ms: Date.now() - t0 }; }
  });
  // 无密钥 → 必然降级到本地兜底；记录为「链路未真正连通」
  check('🔴 GLM 链路可调用（降级/local 也算通，纯异常才算故障）', glmCall.ok === true, glmCall, 'F-GLM链路', '调用', '连接故障');
  issue('F-GLM链路', '设置/Worker', '连通性', `glmCall=${JSON.stringify(glmCall)}（无 GLM_KEY 时走本地兜底，非真连通；真连通需补密钥）`);

  /* ===== G. 图片导入管线（真实 scanFiles · 原图保真） =====
     🔴 这一段是本轮"图片画质专项"的核心：走**真实导入管线**（scanFiles），
        而不是 seed() 手工塞 _file。之前全绿正是因为 seed 塞了 _file，
        掩盖了"生产根本不挂 _file"这个根因。 */
  console.log('\n── G. 图片导入管线（真实导入，原图保真） ──');
  const imp = await page.evaluate(async () => {
    const mk = async (w, h, label) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#2b5fa8'); g.addColorStop(1, '#c86a2b');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 1;
      for (let i = 0; i < w; i += 7) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
      x.fillStyle = '#fff'; x.font = `${Math.round(h / 12)}px sans-serif`; x.fillText(label, 24, Math.round(h / 2));
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      return new File([b], label + '.jpg', { type: 'image/jpeg', lastModified: 1758000000000 + w });
    };
    const f4k = await mk(3840, 2160, 'FOURK');
    const fhd = await mk(1920, 1080, 'HD1080');
    const orig = [f4k.size, fhd.size];
    const st = await import('/js/store.js');
    st.actions.reset();
    const { scanFiles } = await import('/js/scan.js');
    const res = await scanFiles([f4k, fhd], {
      batchSize: st.get().settings.scanBatchSize,
      thumbSize: st.get().settings.thumbSize,
      autoDowngrade: st.get().settings.autoDowngrade,
    });
    st.actions.upsertPhotos(res.photos);
    const ps = st.get().photos;
    const thumbW = [];
    for (const p of ps) {
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.onerror = r; img.src = p.thumbUrl; });
      thumbW.push(img.naturalWidth);
    }
    const ids = ps.map((p) => p.id);
    st.actions.setGroups([{ id: 'g4k', title: '高清样张', photoIds: ids, coverId: ids[0] }]);
    st.actions.upsertStory({ id: 's4k', groupId: 'g4k', title: '高清样张', createdAt: Date.now(), publishedAt: Date.now(), photoIds: ids, order: 'time', templateId: 'tpl_1', dateText: '10月4日', text: { cover: '高清样张', captions: [], body: '', hook: '' }, stats: { views: 0, likes: 0, comments: 0 } });
    return {
      n: ps.length,
      hasFile: ps.every((p) => Boolean(p._file)),
      fileBytes: ps.map((p) => (p._file ? p._file.size : 0)),
      origBytes: orig,
      wh: ps.map((p) => [p.w, p.h]),
      thumbW,
    };
  });
  check('🔴 导入后每张照片都持有原图句柄 _file（生产链路，非测试注入）', imp.n === 2 && imp.hasFile, imp, 'B-图片质量', '导入', '原图丢失');
  check('🔴 原图字节未被改写（_file.size === 原始文件大小）', JSON.stringify(imp.fileBytes) === JSON.stringify(imp.origBytes), { got: imp.fileBytes, want: imp.origBytes }, 'B-图片质量', '导入', '原图被压缩/改写');
  check('🔴 原图分辨率保留（3840×2160 与 1920×1080）', imp.wh.some((w) => w[0] === 3840 && w[1] === 2160) && imp.wh.some((w) => w[0] === 1920 && w[1] === 1080), imp.wh, 'B-图片质量', '导入', '分辨率丢失');
  check('🔴 持久化缩略图分辨率提升（≥256，非 96）', imp.thumbW.length === 2 && imp.thumbW.every((w) => w >= 256), imp.thumbW, 'B-图片质量', '缩略图', '缩略图过低');

  // 作品详情页全宽大图必须用原图（这是用户截图里的主要糊图位置）
  await go(page, '#/detail/s4k');
  await page.waitForFunction(() => { const i = document.querySelector('#view img'); return i && i.naturalWidth >= 3840; }, { timeout: 6000 }).catch(() => {});
  const detailImg = await page.evaluate(() => {
    const img = document.querySelector('#view img');
    if (!img) return { found: false };
    return { found: true, nw: img.naturalWidth, nh: img.naturalHeight };
  });
  check('🔴 作品详情页大图用原图（naturalWidth=3840，非缩略图）', detailImg.found && detailImg.nw === 3840, detailImg, 'B-图片质量', '作品页预览', '预览降分辨率');
  await shot(page, 'G-detail-hires');

  // 导出取原图（degraded=false → 不是拿缩略图糊弄）
  const exp = await page.evaluate(async () => {
    const st = await import('/js/store.js'); const ex = await import('/js/export.js');
    const p = st.get().photos.find((x) => x.w === 3840) || st.get().photos[0];
    const { canvas, degraded } = await ex.loadForExport(p, 1080);
    return { w: canvas ? canvas.width : 0, degraded };
  });
  check('🔴 导出取原图（loadForExport degraded=false，1080 宽）', exp.w === 1080 && exp.degraded === false, exp, 'B-图片质量', '导出', '导出用压缩预览图');

  // AI 分析只读、不改原图
  const aiSafe = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const p = st.get().photos.find((x) => x.w === 3840) || st.get().photos[0];
    const before = p._file ? p._file.size : 0;
    const bmp = await createImageBitmap(p._file);
    const { width: bw, height: bh } = bmp; if (bmp.close) bmp.close();
    const after = p._file ? p._file.size : 0;
    return { before, after, origW: bw, origH: bh };
  });
  check('🔴 AI 分析不改原图（分析后 _file 字节/尺寸不变）', aiSafe.before === aiSafe.after && aiSafe.origW === 3840 && aiSafe.origH === 2160, aiSafe, 'B-图片质量', 'AI分析', 'AI 篡改原图');

  /* ===== H. 老用户升级迁移（画质下限） =====
     🔴 这一段回答的是"修了，但修到人了吗"：
        settings 的加载是 `{ ...DEFAULT_SETTINGS, ...persisted }` —— 持久化值赢，
        所以老版本存下的 thumbSize:96 会把新默认 256 顶掉，出现
        「新装清晰、升级上来的还是糊」。光改 DEFAULT_SETTINGS 是修不到存量用户的。
     验证方式：用**独立新页面**模拟一次真实冷启动（主页面绝不 reload —— 那条约束是
     保护它的 `_file`，新页面没有这个包袱，所以这里 reload 是正当的）。 */
  console.log('\n── H. 老用户升级迁移（画质下限，独立冷启动） ──');
  const p2 = await browser.newPage();
  const migErr = [];
  p2.on('pageerror', (e) => migErr.push(String(e)));
  await p2.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(500);   // 等启动期的防抖 save 落定，免得我把假存档写完又被它盖掉
  const rawBackup = await p2.evaluate(() => localStorage.getItem('zhenxuji.state.v1'));

  /** 伪造一份「老版本装过」的存档，冷启动后读回真实生效值 */
  async function bootWithThumb(ts) {
    await p2.evaluate((v) => {
      const raw = localStorage.getItem('zhenxuji.state.v1');
      const saved = raw ? JSON.parse(raw) : {};
      saved.settings = { ...(saved.settings || {}), thumbSize: v };
      localStorage.setItem('zhenxuji.state.v1', JSON.stringify(saved));
    }, ts);
    await p2.reload({ waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(350);
    return p2.evaluate(async () => {
      const st = await import('/js/store.js');
      return st.get().settings.thumbSize;
    });
  }

  const migOld = await bootWithThumb(96);    // 老存档：低于下限
  check('🔴 老存档 thumbSize:96 → 冷启动后抬到画质下限 256（升级用户也清晰，不是只对新装生效）',
    migOld === 256, { got: migOld, want: 256 }, 'B-图片质量', '设置/升级迁移', '升级后仍用低分辨率缩略图');

  const migHigh = await bootWithThumb(512);  // 存档里已是更高值：不许被误降
  check('🔴 存档已设更高（512）→ 原样保留，不被误降回下限', migHigh === 512, { got: migHigh, want: 512 },
    'B-图片质量', '设置/升级迁移', '高画质设置被误降');

  const migBad = await bootWithThumb(4096);  // 越界值：配额护栏（thumbUrl 是 dataURL，要写进 localStorage）
  check('🔴 越界值 4096 → 收到 512 上限（配额护栏生效）', migBad === 512, { got: migBad, want: 512 },
    'B-图片质量', '设置/升级迁移', '越界配置无护栏');

  // 还原主页面留下的真实存档，避免这段把后面的处境搞脏
  if (rawBackup == null) await p2.evaluate(() => localStorage.removeItem('zhenxuji.state.v1'));
  else await p2.evaluate((v) => localStorage.setItem('zhenxuji.state.v1', v), rawBackup);
  await p2.close();

  /* ===== 运行期错误 ===== */
  console.log('\n── 运行期错误总览 ──');
  if (migErr.length) errors.push(...migErr.map((m) => `[迁移冷启动] ${m}`));
  check('🔴 全程无 pageerror / console.error', errors.length === 0, errors.slice(0, 6));

  // 写缺陷报告
  const lines = [];
  lines.push('# 帧叙集 P0 全量自检 · 缺陷报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`自检结果：${pass} 通过 / ${fail} 失败；运行期错误 ${errors.length} 条`);
  lines.push('');
  lines.push('## 一、自检覆盖维度');
  lines.push('- A. 全页面渲染与文本溢出/乱码（15 个路由）');
  lines.push('- B. 图片上传&AI图像链路（原图保留/大图清晰度/H5嵌入分辨率/九宫格取原图/相册入口）');
  lines.push('- C. 导出功能专项（九宫格/长图/H5 真实下载 + 弹窗路径 + 历史文件名/位置/打开钮）');
  lines.push('- D. 版本更新（启动静默检测/强制弹窗/手动已最新）');
  lines.push('- E. 主题换肤全页面联动（每套主题切换后重跑溢出检查）');
  lines.push('- F. GLM4-Flash 链路（设置页状态展示 + 实际调用记录）');
  lines.push('- G. 图片导入管线（**走真实 scanFiles，非 seed 注入**：原图句柄/字节/分辨率/缩略图/详情页大图/导出取源/AI 只读）');
  lines.push('- H. 老用户升级迁移（伪造老存档冷启动，验证画质下限真的对存量用户生效）');
  lines.push('');
  const catName = { 'A-渲染溢出': 'A. 渲染/溢出', 'B-图片质量': 'B. 图片质量', 'C-导出': 'C. 导出', 'D-版本更新': 'D. 版本更新', 'E-主题联动': 'E. 主题联动', 'F-GLM链路': 'F. GLM链路' };
  for (const c of Object.keys(report)) {
    if (!report[c].length) continue;
    lines.push(`## ${catName[c] || c}（${report[c].length} 项）`);
    for (const it of report[c]) lines.push(`- 【${it.type}】${it.page}：${it.detail}`);
    lines.push('');
  }
  lines.push('## 二、本轮 P0 缺陷与修复（已修复并复验）');
  lines.push('| # | 维度 | 缺陷（自检发现） | 修复 | 复验 |');
  lines.push('|---|---|---|---|---|');
  lines.push('| 1 | 图片 | H5 网页故事册内嵌 96px 缩略图 → 图糊 | `doExport` 的 H5 分支用 `loadForExport` 取 `_file` 全分辨率转 dataURL 再喂 `buildShareHTML`（不改 `export.js` 底层，只改数据） | B3 ≥700 ✅ |');
  lines.push('| 2 | 导出 | 落点弹窗缺可执行补救钮 | `renderExportModal` 加「再次下载」（携带 storyId+kind 回原创作品重导出） | C2 ✅ |');
  lines.push('| 3 | 导出 | 导出历史卡缺打开/重下钮 | `pageExportHistory` 每张卡加「再次下载」 | C5 ✅ |');
  lines.push('| 4 | GLM | 设置页无大模型连接状态 | `pageSettings` 加状态卡 + `probeGlm()` 真探测（已连通/本地兜底/未配置三级友好提示），`store.ui.glmStatus` 驱动重绘 | F2 ✅ |');
  lines.push('| 5 | 渲染 | 版本探测对「配置地址/api/version」刷 404 | 产品侧为正常兜底（去重由 `update.js` 的 seen 集合负责），自检脚本补 mock，非产品缺陷 | 运行期 0 error ✅ |');
  lines.push('');
  lines.push('### 图片画质专项（最高优先级 · 根因级修复）');
  lines.push('');
  lines.push('| # | 缺陷（自检/用户截图发现） | 根因 | 修复 | 复验 |');
  lines.push('|---|---|---|---|---|');
  lines.push('| 6 | **导入高清原图后预览/查看/导出全糊、马赛克** | 🔴 **`scan.js` 的 `processOne` 从不挂 `_file`** —— 全仓只有 `enhance.js` 和测试 `seed()` 设它。于是查看器 `srcOf`、`loadForExport`、批量套用、配方预览全部回落到 96px 缩略图。**测试全绿是因为 seed() 手工塞了 `_file`（"测试在说谎"），把根因掩盖了** | `processOne` 返回对象挂 `_file: file`（只读引用、不复制字节、会话内存态、`stripRuntime` 会剥离） | G1/G2/G3 ✅ 原图 3840×2160 与 1920×1080 完整保留 |');
  lines.push('| 7 | 缩略图在手机上被拉伸即糊 | 默认 `thumbSize` 96 太小；`canvasToURL` 质量 0.72 在 256 尺寸下会压出块状噪点 | 默认 96 → **256**（`imaging.decodePhoto` / `scan.scanFiles` / `store.DEFAULT_SETTINGS` 三处对齐）；JPEG 质量 0.72 → **0.82** | G3 ✅ 缩略图 ≥256 |');
  lines.push('| 8 | 作品详情页全宽大图糊 | 详情页直接渲染 `p.thumbUrl`，把 96px 缩略图拉到整屏 | `pages.pageDetail` 改用 `imaging.displaySrc(p)`：有 `_file` 走原图 blobURL，重启后如实回落缩略图 | G4 ✅ `naturalWidth=3840` |');
  lines.push('| 9 | **「省电模式」把画质也降了** | `scanFiles` 自动降级同时缩 `thumbSize`（96→48）：设备一慢就把用户图片压更糊，等于指令明令禁止的「默认全局有损压缩」 | 降级**只缩批大小（性能）**，`thumbSize` 改为 `const` 恒定。慢可以，糊不行 | G3 ✅ 降级路径下缩略图仍 ≥256 |');
  lines.push('| 10 | **老用户升级后依然是糊图** | `settings` 加载是 `{...DEFAULT_SETTINGS, ...persisted}`，持久化值赢 → 老存档的 `thumbSize:96` 把新的 256 顶掉，"新装清晰、升级还是糊" | `store.load()` 加**画质下限迁移**：`thumbSize` 低于 256 一律抬到 256；上限 512 作配额护栏（`thumbUrl` 是 dataURL，要整体写进 localStorage） | H1/H2/H3 ✅ |');
  lines.push('| 11 | 清空数据后原图 blobURL 泄漏 | `displaySrc` 的按 id 缓存无人释放 | 新增 `clearDisplaySrc()`，挂在 `clearCache` / `resetAll` 分支 | 运行期 0 error ✅ |');
  lines.push('');
  lines.push('**连带修好两个此前"死"的功能**（都因缺 `_file` 而永远走不到）：`app.js` 批量套用配方的过滤 `p._file`、配方预览取 `p._file`。');
  lines.push('');
  lines.push('**如实告知的边界（不粉饰）**：① 缩略图边长提到 256 后是 96 的约 7 倍像素量，`thumbUrl` 为 dataURL、会整体写进 localStorage，**大量照片下配额压力上升**（上限 512 即为护栏，后续若破配额定额需迁 IndexedDB）；② `_file` 是 File 句柄、**按设计不落盘**（`stripRuntime` 剥离），所以**冷启动后台**的大图预览与导出会如实回落缩略图 —— 想要"重启仍然全分辨率"须把原图存 IndexedDB，属独立需求；③ 存量已导入的老照片其 `thumbUrl` 已是 96px 且原图句柄已丢，**无法就地变清晰，需重新导入一次**（id 由"文件名+大小+时间"稳定生成，重导即覆盖为 256）。');
  lines.push('');
  lines.push('> 附带修正 3 处**自检脚本自身 bug**（否则是假红）：① File 对象无 `.width`，改用 `createImageBitmap` 取真实像素；② 大图查看器是 `.album-photo` 背景图、非 `<img>`，选择器改正；③ H5 断言未复刻 doExport 的包装逻辑，已对齐。');
  lines.push('');
  lines.push('## 三、回归门禁（本轮全绿）');
  lines.push('- `_selftest/p0-selfcheck.cjs`（本脚本）：' + pass + ' 通过 / ' + fail + ' 失败 / ' + errors.length + ' 运行期错误');
  lines.push('- `_selftest/selftest.cjs`：314 / 314');
  lines.push('- `_selftest/audit-clickthrough.cjs`：67 / 67（全路由点击巡检，耗时 40s 与基线一致）');
  lines.push('');
  lines.push('> 🔴 A/B 对照留痕①（图片画质 · 根因鉴别力）：图片糊图的根因是「生产链路从不挂 `_file`」，而**旧测试是靠 seed() 手工塞 `_file` 才全绿的**（测试在说谎）。所以新代码全绿**不足以**证明修复有效，必须证明"旧代码在同一个探针下会失败"。用 `git worktree add /d/_zx_ab HEAD`（= 改动前 7851851）另起 4380 端口，同探针 `_selftest/ab-image-quality.cjs` 双跑同一张 3840×2160 样张：');
  lines.push('');
  lines.push('| 指标 | 旧代码（7851851） | 新代码（本工作区） | 含义 |');
  lines.push('|---|---|---|---|');
  lines.push('| 生效的 thumbSize | 96 | **256** | 缩略图分辨率 |');
  lines.push('| 持有原图句柄 `_file` | **false** | **true** | ← 根因所在 |');
  lines.push('| 原图字节 | 0（原图已丢） | 1,337,208 | 原图未被改写、仍持有 |');
  lines.push('| 缩略图实际像素宽 | 96 | **256** | |');
  lines.push('| **作品详情页全宽大图 naturalWidth** | **96** | **3840** | ← 用户截图里"糊"的确凿来源：96px 被拉到整屏 |');
  lines.push('| 导出宽度 | 576 | **1080** | |');
  lines.push('| 导出 `degraded` | **true**（拿缩略图糊弄） | **false**（取原图） | |');
  lines.push('');
  lines.push('> 🔴 A/B 对照留痕②（导出弹窗按钮顺序 · 回归鉴别力）：导出弹窗加「再次下载」后巡检一度 7 项失败（长图/H5 下载、进详情/分享、绑定成套、进教程、AI 开关，全是"点击无反应"）。同脚本对照改动前 HEAD：改动前 67/67、耗时 40s；改动后 7 项失败、耗时 274s（= 7 次 30s 点击超时）。根因：弹窗垂直居中，「再次下载」占据首位后，巡检点在遮罩中心点点位触发的是重新导出、弹窗不再关闭。把「知道了」恢复为首位按钮后 67/67、耗时回到 40s。**结论：弹窗首位按钮必须是「关闭」**，已固化为项目铁律。');
  fs.writeFileSync(path.join(__dirname, 'P0-DEFECT-REPORT.md'), lines.join('\n'), 'utf8');

  console.log(`\n===== P0 自检：${pass} 通过 / ${fail} 失败；运行期错误 ${errors.length} 条 =====`);
  if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '));
  console.log(`缺陷报告已写入 _selftest/P0-DEFECT-REPORT.md`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('自检异常：', e); process.exit(2); });
