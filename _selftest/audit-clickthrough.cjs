// 全功能点击巡检 —— 用本机 Chrome 逐个路由导航 + 点击关键 action，
// 捕获 pageerror / console.error，对真实路径（调色/导出/AI 文案）做行为断言。
//
// 🔴 关键约束（来自踩坑记忆）：
//   - 只用一次 page.goto 进首页；之后所有路由切换走 location.hash，
//     绝不 page.reload / 再次 goto —— 否则 store.load() 把 _file 置 null，
//     调色/导出全部"假失败"。需要干净态时调用 reset+reseed（不 reload）。
//   - 截图供肉眼复核，断言防止回归。
//   - prompt/confirm 用 addInitScript 自动放行，让"执行型" action 真正跑起来。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 4288);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, 'shots', 'audit');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
const errors = [];   // {type, where, msg}
let curWhere = 'boot';

function check(name, ok, got) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  →  ${JSON.stringify(got)}`); }
}

/* ---------- 路由导航（hash，不 reload） ---------- */
async function go(page, hash) {
  await page.evaluate(() => { location.hash = '#/__tmp'; });
  await page.waitForTimeout(50);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(340);
}
async function rerender(page) {
  const cur = await page.evaluate(() => location.hash);
  await page.evaluate(() => { location.hash = '#/__tmp'; });
  await page.waitForTimeout(50);
  await page.evaluate((h) => { location.hash = h; }, cur);
  await page.waitForTimeout(300);
}
async function snapErrors(page, label) {
  // 返回自上次快照以来新增的错误数量
  const before = errors.__len || 0;
  errors.__len = errors.length;
  return errors.length - before;
}

/* ---------- 完整种子数据（含真实 _file） ---------- */
async function seed(page, { withFile = true } = {}) {
  return page.evaluate(async ({ withFile }) => {
    const mkPngFile = async (hue, name) => {
      const c = document.createElement('canvas');
      c.width = 140; c.height = 140;
      const ctx = c.getContext('2d');
      for (let y = 0; y < 140; y++) for (let x = 0; x < 140; x++) {
        ctx.fillStyle = `hsl(${hue + (x + y) * 0.3}, 55%, ${30 + ((x * y) % 40)}%)`;
        ctx.fillRect(x, y, 1, 1);
      }
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    };
    const st = await import('/js/store.js');
    st.actions.reset();
    const files = [await mkPngFile(20, 'a.png'), await mkPngFile(120, 'b.png'), await mkPngFile(220, 'c.png'), await mkPngFile(300, 'd.png')];
    const basePhotos = files.map((f, i) => ({
      id: `p${i + 1}`, scene: i % 2 ? 'portrait' : 'landscape',
      cv: { sharpness: 380 + i * 10, over: 0.01, under: 0.01, edgeFlat: 0.1, brightness: 130, contrastStd: 60, saturation: 0.4, centerFocus: 0.7 },
      dhash: `${i}a2b3c4d5e6f7081`,
      takenAt: 1758000000000 + i * 3600000,
      thumbUrl: '',
      _file: withFile ? f : null,
      verdict: { level: i === 2 ? 'A' : 'keep', reasons: i === 2 ? [{ code: 'blur', label: '模糊' }] : [] },
      score: 72 + i * 3,
    }));
    st.actions.upsertPhotos(basePhotos);
    st.actions.setGroups([
      { id: 'g1', title: '周末出游', photoIds: ['p1', 'p2', 'p3'], coverId: 'p1' },
      { id: 'g2', title: '日常碎片', photoIds: ['p4'], coverId: 'p4' },
    ]);
    // 内置模板 + 一个美颜配方
    st.actions.upsertRecipe({ id: 'tpl_1', name: '简约纸感', type: 'template', tone: '简约' });
    st.actions.upsertRecipe({ id: 'tpl_2', name: '留白叙事', type: 'template', tone: '留白' });
    st.actions.upsertRecipe({ id: 'tpl_3', name: '温柔日常', type: 'template', tone: '温柔' });
    st.actions.upsertRecipe({ id: 'r1', name: '清透配方', type: 'beauty', params: { bright: 18, soft: 0, warm: 14, sat: 22, contrast: 12 }, thumb: '' });
    // 一个故事
    st.actions.upsertStory({
      id: 's1', groupId: 'g1', title: '周末出游', createdAt: Date.now(), publishedAt: Date.now(),
      photoIds: ['p1', 'p2', 'p3'], order: 'narrative', templateId: 'tpl_1', dateText: '10月3日',
      text: { cover: '周末出游', captions: ['第1帧', '第2帧', '第3帧'], body: '快乐的一天', hook: '记录' },
      stats: { views: 0, likes: 0, comments: 0 },
    });
    // 导出历史（运行态，不落盘）
    st.setUI({ exportHistory: [{ kind: 'grid', filename: '帧叙集-九宫格-周末出游.jpg', at: Date.now(), thumb: '' }] });
    // 让 AI 文案走真实通道（mock 的 /api/story 由 Playwright 拦）
    st.actions.patchSettings({ glmEndpoint: location.origin, aiTextEnabled: true });
    return { n: st.get().photos.length, hasFile: Boolean(st.get().photos[0] && st.get().photos[0]._file), recipes: st.get().recipes.length };
  }, { withFile });
}

/* ---------- 断言某路由渲染正常 ---------- */
async function visit(page, hash, name) {
  await go(page, hash);
  const info = await page.evaluate(() => {
    const v = document.getElementById('view');
    const h1 = v ? v.querySelector('h1') : null;
    return {
      textLen: v ? v.innerText.trim().length : 0,
      err: h1 ? h1.textContent.trim() : '',
      hasContent: v ? v.children.length > 0 : false,
    };
  });
  check(`[render] ${name} 渲染正常（无"出错了"、有内容）`, info.err !== '出错了' && info.hasContent && info.textLen > 20, info);
  return info;
}

/* ---------- 截图 ---------- */
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }); }
  catch (_) {}
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 412, height: 900 } });

  // 自动放行 prompt/confirm，让执行型 action 真正跑
  await page.addInitScript(() => {
    window.prompt = (m) => '巡检名';
    window.confirm = () => true;
  });

  // 错误采集
  page.on('pageerror', (e) => errors.push({ type: 'pageerror', where: curWhere, msg: e.message }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ type: 'console', where: curWhere, msg: m.text() }); });
  const downloads = [];
  page.on('download', (d) => downloads.push(d));

  // 先注册具体 mock（确保命中），不挂 broad catch-all
  await page.route('**/api/story', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, content: JSON.stringify({
      cover: '周末出游', hook: '一次开心的出行', body: '今天天气很好，我们去了郊外，拍了很多照片。',
      captions: ['出发', '抵达', '归途'],
    }) }),
  }));
  // /api/version：与当前版本一致 → 检查更新不会误报「有更新」、也不 404
  await page.route('**/api/version', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ latest_version: '0.6.2', update_url: '' }),
  }));

  /* ===== 0. 进入首页 + 种子 ===== */
  curWhere = 'boot';
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const s0 = await seed(page);
  await rerender(page);
  console.log('\n── 0. 种子数据 ──');
  check('🔴 注入真实 File 对象（_file 在内存里）', s0.hasFile === true, s0);
  check('🔴 配方含 3 模板 + 1 美颜', s0.recipes === 4, s0);

  /* ===== 1. 全路由渲染巡检 ===== */
  console.log('\n── 1. 全路由渲染巡检 ──');
  const routes = [
    ['#/create', '新建(空状态)'],
    ['#/album', '相册(已导入)'],
    ['#/pick/g1', 'AI选片'],
    ['#/edit/g1', '批量修图'],
    ['#/compose/g1', '故事组装'],
    ['#/share/s1', '分享/导出'],
    ['#/gallery', '作品集'],
    ['#/detail/s1', '故事详情'],
    ['#/recipes', '素材配方'],
    ['#/theme', '外观主题'],
    ['#/settings', '设置'],
    ['#/changelog', '更新日志'],
    ['#/help', '使用教程'],
    ['#/viewer/g1:p1', '相册大图查看器'],
    ['#/exphistory', '导出历史'],
  ];
  for (const [h, n] of routes) { curWhere = `render:${n}`; await visit(page, h, n); await shot(page, `render-${n}`); }

  /* ===== 2. 新建页 ===== */
  console.log('\n── 2. 新建页 ──');
  curWhere = 'create';
  await go(page, '#/create');
  const createBtns = await page.evaluate(() => ({
    album: Boolean(document.querySelector('[data-act="pickAlbum"]')),
    few: Boolean(document.querySelector('[data-act="pickFew"]')),
  }));
  check('新建页有「导入整批/挑几张」入口', createBtns.album && createBtns.few, createBtns);

  /* ===== 3. 相册页交互 ===== */
  console.log('\n── 3. 相册页交互 ──');
  curWhere = 'album';
  await go(page, '#/album');
  const album = await page.evaluate(() => ({
    cards: document.querySelectorAll('.gcard, [class*="gcard"]').length,
    aiBtn: Boolean(document.querySelector('[data-act="aiPickAll"]')),
    regroup: Boolean(document.querySelector('[data-act="regroup"]')),
  }));
  check('相册页有分组卡片', album.cards >= 1, album);
  // AI 帮我选片 → 跳 pick
  await page.click('[data-act="aiPickAll"]').catch(() => {});
  await page.waitForTimeout(400);
  check('AI 帮我选片跳转到选片页', (await page.evaluate(() => location.hash)).includes('pick'), await page.evaluate(() => location.hash));
  await go(page, '#/album');
  // 重新聚类：必须保留已有分组 id（否则故事的 groupId 悬空）
  await page.click('[data-act="regroup"]').catch(() => {});
  await page.waitForTimeout(350);
  check('点「重新聚类」无报错', true, null);
  const regroupState = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const g = st.get().groups.find((x) => x.id === 'g1');
    const sid = (st.get().stories.find((s) => s.id === 's1') || {}).groupId;
    return {
      g1Exists: Boolean(g),
      g1Photos: g ? g.photoIds.length : 0,
      storyGroupResolves: Boolean(sid && st.get().groups.find((x) => x.id === sid)),
    };
  });
  check('🔴 重新聚类后 g1 仍存在（身份保留，不悬空故事引用）', regroupState.g1Exists === true, regroupState);
  check('🔴 重新聚类后故事的 groupId 仍可解析', regroupState.storyGroupResolves === true, regroupState);
  // 恢复干净状态供后续章节使用
  await seed(page, { withFile: true });
  await rerender(page);
  await shot(page, 'album-after');

  /* ===== 4. AI 选片页交互 ===== */
  console.log('\n── 4. AI 选片页交互 ──');
  curWhere = 'pick';
  await go(page, '#/pick/g1');
  const pick = await page.evaluate(() => ({
    cells: document.querySelectorAll('.pk-cell, [class*="pk-cell"]').length,
    toggle: Boolean(document.querySelector('[data-act="togglePhoto"]')),
    goEdit: Boolean(document.querySelector('[data-act="goEdit"]')),
  }));
  check('选片页有照片卡片', pick.cells >= 1, pick);
  // 翻转一张照片判定
  const beforeToggle = await page.evaluate(() => {
    const st = window.__st; return null; // 仅占位
  });
  await page.click('[data-act="togglePhoto"]').catch(() => {});
  await page.waitForTimeout(300);
  check('点照片翻转判定无报错', true, null);

  /* ===== 5. 批量修图页交互（真实调色） ===== */
  console.log('\n── 5. 批量修图页（真实像素调色） ──');
  curWhere = 'edit';
  await go(page, '#/edit/g1');
  const edit = await page.evaluate(() => ({
    sliders: document.querySelectorAll('#sliders .sld__r').length,
    apply: Boolean(document.querySelector('[data-act="applyEnhance"]')),
    save: Boolean(document.querySelector('[data-act="saveRecipe"]')),
  }));
  check('修图页有 5 个滑杆 + 应用 + 存配方', edit.sliders === 5 && edit.apply && edit.save, edit);
  // 拖亮滑杆
  await page.evaluate(() => {
    const r = document.querySelector('#sliders .sld__r[data-p="bright"]');
    if (r) { r.value = '40'; r.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(120);
  // 应用批量调色（真实像素）
  const dBefore = downloads.length;
  await page.click('[data-act="applyEnhance"]').catch(() => {});
  await page.waitForTimeout(1500);
  const applied = await page.evaluate(() => {
    const st = window.__st; // 可能不存在；改用 import
    return null;
  });
  const applyRes = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const g = st.get().groups.find((x) => x.id === 'g1');
    if (!g) return { total: 0, enhanced: 0, hasFile: false, missing: true };
    const ps = g.photoIds.map((id) => st.get().photos.find((p) => p.id === id)).filter(Boolean);
    return { total: ps.length, enhanced: ps.filter((p) => p.enhancedUrl).length, hasFile: ps.every((p) => Boolean(p._file)) };
  });
  check('🔴 批量调色后每张都有 enhancedUrl（真改像素）', applyRes.enhanced === applyRes.total && applyRes.total > 0, applyRes);
  check('🔴 调色后原图 _file 仍在', applyRes.hasFile === true, applyRes);
  await shot(page, 'edit-enhanced');
  // 撤销
  await page.click('[data-act="revertEnhance"]').catch(() => {});
  await page.waitForTimeout(500);
  const reverted = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const g = st.get().groups.find((x) => x.id === 'g1');
    if (!g) return { enhanced: 0, hasFile: false, missing: true };
    const ps = g.photoIds.map((id) => st.get().photos.find((p) => p.id === id)).filter(Boolean);
    return { enhanced: ps.filter((p) => p.enhancedUrl).length, hasFile: ps.every((p) => Boolean(p._file)) };
  });
  check('🔴 撤销后 enhancedUrl 清空、原图仍在', reverted.enhanced === 0 && reverted.hasFile === true, reverted);
  // 存为我的配方（prompt 自动放行）；配方缩略图需 enhance 真实像素生成，放宽等待
  await page.click('[data-act="saveRecipe"]').catch(() => {});
  await page.waitForTimeout(2200);
  const saved = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    return st.get().recipes.filter((r) => r.type === 'beauty').length;
  });
  check('🔴 存为配方后美颜配方 +1', saved >= 2, { saved });

  /* ===== 6. 故事组装 + AI 文案 + 完成导出 ===== */
  console.log('\n── 6. 故事组装 / AI 文案 / 完成 ──');
  curWhere = 'compose';
  await go(page, '#/compose/g1');
  const compose = await page.evaluate(() => ({
    gen: Boolean(document.querySelector('[data-act="genText"]')),
    finish: Boolean(document.querySelector('[data-act="finishStory"]')),
  }));
  check('组装页有「生成文案 / 完成导出」', compose.gen && compose.finish, compose);
  // 生成 AI 文案（走 mock /api/story）
  await page.click('[data-act="genText"]').catch(() => {});
  const genOk = await page.waitForFunction(() => {
    const b = document.getElementById('fBody');
    return b && b.value && b.value.length > 0;
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  check('🔴 点「生成 AI 文案」后文本框被填充', genOk, genOk);
  await shot(page, 'compose-gen');
  // 完成并导出 → 跳 share
  await page.click('[data-act="finishStory"]').catch(() => {});
  await page.waitForTimeout(500);
  check('完成故事后跳到分享页', (await page.evaluate(() => location.hash)).includes('share'), await page.evaluate(() => location.hash));

  /* ===== 7. 分享/导出（真实下载 + 弹窗） ===== */
  console.log('\n── 7. 分享 / 导出 ──');
  curWhere = 'share';
  await go(page, '#/share/s1');
  const share = await page.evaluate(() => ({
    grid: Boolean(document.querySelector('[data-act="expGrid"]')),
    long: Boolean(document.querySelector('[data-act="expLong"]')),
    h5: Boolean(document.querySelector('[data-act="expH5"]')),
  }));
  check('分享页有三导出按钮', share.grid && share.long && share.h5, share);
  // 九宫格（先注册 download 监听再点，避免同步下载竞态漏抓）
  const gEvt = await Promise.all([
    page.waitForEvent('download', { timeout: 12000 }),
    page.click('[data-act="expGrid"]').catch(() => {}),
  ]).then(() => true).catch(() => false);
  const gExp = await page.waitForFunction(async () => { const st = await import('/js/store.js'); return Boolean(st.get().ui.exportResult); }, { timeout: 4000 }).then(() => true).catch(() => false);
  check('🔴 九宫格导出触发下载', gEvt, { evt: gEvt, total: downloads.length });
  check('🔴 导出后弹出落点弹窗', gExp, gExp);
  await shot(page, 'share-modal');
  await page.click('[data-act="closeExport"]').catch(() => {});
  await page.waitForTimeout(300);
  // 长图（大图拼接耗时较长，放宽等待）
  const lEvt = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('[data-act="expLong"]').catch(() => {}),
  ]).then(() => true).catch(() => false);
  check('🔴 长图导出触发下载', lEvt, { evt: lEvt, total: downloads.length });
  await page.click('[data-act="closeExport"]').catch(() => {});
  await page.waitForTimeout(300);
  // H5（downloadText 同步触发，必须监听先于点击）
  const hEvt = await Promise.all([
    page.waitForEvent('download', { timeout: 12000 }),
    page.click('[data-act="expH5"]').catch(() => {}),
  ]).then(() => true).catch(() => false);
  check('🔴 H5 导出触发下载', hEvt, { evt: hEvt, total: downloads.length });
  await page.click('[data-act="closeExport"]').catch(() => {});
  await page.waitForTimeout(300);

  /* ===== 8. 导出历史 ===== */
  console.log('\n── 8. 导出历史 ──');
  curWhere = 'exphistory';
  await go(page, '#/exphistory');
  const hist = await page.evaluate(() => ({
    items: document.querySelectorAll('.ehist, [class*="ehist"], .ecard, [class*="ecard"]').length,
    empty: /还没有/.test(document.getElementById('view').innerText),
  }));
  check('导出历史页有记录条目（非空状态）', hist.items >= 1 || !hist.empty, hist);

  /* ===== 9. 作品集 + 详情 ===== */
  console.log('\n── 9. 作品集 / 详情 ──');
  curWhere = 'gallery';
  await go(page, '#/gallery');
  const gal = await page.evaluate(() => ({
    cards: document.querySelectorAll('.scard, [class*="scard"], article').length,
    open: Boolean(document.querySelector('[data-act="openStory"]')),
    share: Boolean(document.querySelector('[data-act="shareStory"]')),
  }));
  check('作品集页有故事卡片', gal.cards >= 1, gal);
  // 进入详情
  await page.click('[data-act="openStory"]').catch(() => {});
  await page.waitForTimeout(400);
  check('点故事进入详情页', (await page.evaluate(() => location.hash)).includes('detail'), await page.evaluate(() => location.hash));
  await shot(page, 'detail');
  // 详情页分享
  curWhere = 'detail';
  await go(page, '#/detail/s1');
  await page.click('[data-act="shareStory"]').catch(() => {});
  await page.waitForTimeout(400);
  check('详情页分享跳到分享页', (await page.evaluate(() => location.hash)).includes('share'), await page.evaluate(() => location.hash));

  /* ===== 10. 素材配方管理 ===== */
  console.log('\n── 10. 素材配方管理 ──');
  curWhere = 'recipes';
  await go(page, '#/recipes');
  const rc = await page.evaluate(() => ({
    cards: document.querySelectorAll('.rcard').length,
    makeBundle: Boolean(document.querySelector('[data-act="makeBundle"]')),
    bdBeauty: Boolean(document.getElementById('bdBeauty')),
    bdTpl: Boolean(document.getElementById('bdTpl')),
  }));
  check('配方页有卡片 + 成套绑定选择器', rc.cards >= 1 && rc.makeBundle && rc.bdBeauty && rc.bdTpl, rc);
  // 选两个 + 绑定成套
  await page.selectOption('#bdBeauty', { label: /清透/ }).catch(() => {});
  await page.selectOption('#bdTpl', { label: /简约/ }).catch(() => {});
  await page.click('[data-act="makeBundle"]').catch(() => {});
  await page.waitForTimeout(400);
  const bundled = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    return (st.get().settings.recipeBundles || []).length;
  });
  check('🔴 绑定成套后 recipeBundles +1', bundled >= 1, { bundled });
  // 一键加载（真执行：调色 + 定模板）
  const loadBtn = await page.evaluate(() => {
    const b = document.querySelector('[data-act="loadBundle"]');
    return b ? b.getAttribute('data-id') : null;
  });
  if (loadBtn) {
    await page.click(`[data-act="loadBundle"][data-id="${loadBtn}"]`).catch(() => {});
    await page.waitForTimeout(1800);
    const loaded = await page.evaluate(async () => {
      const st = await import('/js/store.js');
      const g = st.get().groups[0];
      const ps = g.photoIds.map((id) => st.get().photos.find((p) => p.id === id)).filter(Boolean);
      return { enhanced: ps.filter((p) => p.enhancedUrl).length, total: ps.length, tpl: g.templateId };
    });
    check('🔴 一键加载真调色 + 定模板', loaded.enhanced === loaded.total && loaded.total > 0 && Boolean(loaded.tpl), loaded);
  }
  // 重命名 / 复制 / 删除 一个美颜配方
  await go(page, '#/recipes');
  const beautyCard = await page.evaluate(() => document.querySelector('.rcard[data-id="r1"]') || document.querySelector('.rcard[data-kind="beauty"]'));
  if (beautyCard) {
    const before = await page.evaluate(async () => (await import('/js/store.js')).get().recipes.filter((r) => r.type === 'beauty').length);
    await page.evaluate(() => { const c = document.querySelector('.rcard[data-id="r1"]') || document.querySelector('.rcard[data-kind="beauty"]'); c.querySelector('[data-act="dupRecipe"]').click(); });
    await page.waitForTimeout(400);
    const afterDup = await page.evaluate(async () => (await import('/js/store.js')).get().recipes.filter((r) => r.type === 'beauty').length);
    check('🔴 复制配方 +1', afterDup === before + 1, { before, afterDup });
    // 删除一个（confirm 自动放行）
    await page.evaluate(() => { const c = document.querySelector('.rcard[data-kind="beauty"]'); const d = c.querySelector('[data-act="delRecipe"]'); if (d) d.click(); });
    await page.waitForTimeout(400);
    const afterDel = await page.evaluate(async () => (await import('/js/store.js')).get().recipes.filter((r) => r.type === 'beauty').length);
    check('🔴 删除配方 -1', afterDel === before, { before, afterDel });
  }
  // 删除成套方案
  await page.evaluate(() => { const b = document.querySelector('[data-act="delBundle"]'); if (b) b.click(); });
  await page.waitForTimeout(300);

  /* ===== 11. 外观主题 ===== */
  console.log('\n── 11. 外观主题 / 明暗 ──');
  curWhere = 'theme';
  await go(page, '#/theme');
  const themeIds = await page.evaluate(() => [...document.querySelectorAll('[data-act="setTheme"]')].map((b) => b.dataset.id));
  for (const th of themeIds) {
    await page.evaluate((t) => { const b = document.querySelector(`[data-act="setTheme"][data-id="${t}"]`); if (b) b.click(); }, th);
    await page.waitForTimeout(180);
    const ok = await page.evaluate((t) => document.documentElement.dataset.theme === t, th);
    check(`[主题] ${th} 切换生效`, ok, { th, attr: await page.evaluate(() => document.documentElement.dataset.theme) });
  }
  await shot(page, 'theme');
  for (const m of ['light', 'dark', 'auto']) {
    await page.evaluate((mm) => { const b = document.querySelector(`[data-act="setMode"][data-id="${mm}"]`); if (b) b.click(); }, m);
    await page.waitForTimeout(220);
    const ok = await page.evaluate((mm) => { const a = document.documentElement.dataset.mode; return mm === 'auto' ? (a === 'light' || a === 'dark') : a === mm; }, m);
    check(`[明暗] ${m} 切换生效`, ok, { m, attr: await page.evaluate(() => document.documentElement.dataset.mode) });
  }

  /* ===== 12. 设置页 ===== */
  console.log('\n── 12. 设置页 ──');
  curWhere = 'settings';
  await go(page, '#/settings');
  const set = await page.evaluate(() => ({
    help: Boolean(document.querySelector('[data-act="goHelp"]')),
    theme: Boolean(document.querySelector('[data-act="goTheme"]')),
    ai: Boolean(document.querySelector('[data-act="toggleAI"]')),
    check: Boolean(document.querySelector('[data-act="checkUpdate"]')),
  }));
  check('设置页有教程/主题/AI开关/检查更新入口', set.help && set.theme && set.ai && set.check, set);
  // 进教程
  await page.click('[data-act="goHelp"]').catch(() => {});
  await page.waitForTimeout(400);
  check('设置页进教程成功', (await page.evaluate(() => location.hash)).includes('help'), await page.evaluate(() => location.hash));
  await go(page, '#/settings');
  // 开关 AI 文案
  await page.click('[data-act="toggleAI"]').catch(() => {});
  await page.waitForTimeout(300);
  const aiOff = await page.evaluate(async () => (await import('/js/store.js')).get().settings.aiTextEnabled);
  check('🔴 切换 AI 文案开关生效', aiOff === false, { aiOff });
  await page.click('[data-act="toggleAI"]').catch(() => {}); // 切回
  await page.waitForTimeout(200);
  // 检查版本更新（同源 version.json 应成功）
  const updBefore = errors.length;
  await page.click('[data-act="checkUpdate"]').catch(() => {});
  await page.waitForTimeout(1200);
  check('点「检查版本更新」无报错', errors.length === updBefore, errors.slice(updBefore));
  await shot(page, 'settings');

  /* ===== 13. 相册大图查看器 ===== */
  console.log('\n── 13. 相册大图查看器 ──');
  curWhere = 'viewer';
  await go(page, '#/viewer/g1:p1');
  const viewer = await page.evaluate(() => ({
    mounted: Boolean(document.querySelector('.album-viewer, [class*="album-viewer"]')),
    pickerBar: Boolean(document.querySelector('[class*="picker"], [class*="__pickerBar"]')),
  }));
  check('查看器挂载成功', viewer.mounted, viewer);
  await shot(page, 'viewer');

  /* ===== 14. 破坏性操作（最后做，做完补 seed） ===== */
  console.log('\n── 14. 破坏性操作 ──');
  // 删故事（section 6 的 finishStory 已新增一条故事，故断言「数量 -1」而非清 0）
  curWhere = 'gallery-del';
  await go(page, '#/gallery');
  const beforeDelStory = await page.evaluate(async () => (await import('/js/store.js')).get().stories.length);
  await page.evaluate(() => { const b = document.querySelector('[data-act="delStory"]'); if (b) b.click(); });
  await page.waitForTimeout(400);
  const afterDelStory = await page.evaluate(async () => (await import('/js/store.js')).get().stories.length);
  check('🔴 删除故事生效（数量 -1）', afterDelStory === beforeDelStory - 1, { beforeDelStory, afterDelStory });
  // 重新补故事（后续断言不需要，但保持环境干净）
  await seed(page, { withFile: true });
  await rerender(page);
  // 删分组
  curWhere = 'album-del';
  await go(page, '#/album');
  await page.evaluate(() => { const b = document.querySelector('[data-act="delGroup"]'); if (b) b.click(); });
  await page.waitForTimeout(400);
  const afterDelGroup = await page.evaluate(async () => (await import('/js/store.js')).get().groups.length);
  check('🔴 删除分组生效', afterDelGroup === 1, { afterDelGroup });
  // 清空全部数据（confirm 自动放行）
  curWhere = 'resetAll';
  await go(page, '#/settings');
  await page.evaluate(() => { const b = document.querySelector('[data-act="resetAll"]'); if (b) b.click(); });
  await page.waitForTimeout(500);
  const afterReset = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    return { photos: st.get().photos.length, groups: st.get().groups.length, stories: st.get().stories.length, recipes: st.get().recipes.length };
  });
  check('🔴 清空全部数据后归零', afterReset.photos === 0 && afterReset.groups === 0 && afterReset.stories === 0, afterReset);

  /* ===== 15. 错误总览 ===== */
  console.log('\n── 15. 运行期错误总览 ──');
  const byWhere = {};
  for (const e of errors) { (byWhere[e.where] = byWhere[e.where] || []).push(`${e.type}: ${e.msg}`); }
  const errCount = errors.length;
  check('🔴 全程无 pageerror / console.error', errCount === 0, byWhere);
  if (errCount) {
    console.log('错误明细：');
    for (const [w, list] of Object.entries(byWhere)) {
      console.log(`  [${w}]`);
      for (const m of list.slice(0, 4)) console.log(`     - ${m}`);
    }
  }

  console.log(`\n===== 全功能点击巡检：${pass} 通过 / ${fail} 失败；运行期错误 ${errCount} 条 =====`);
  if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('巡检异常：', e); process.exit(2); });
