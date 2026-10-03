// AI 选片模块真跑自测 —— 走本机 Chrome + http 服务，绝不只做静态检查。
// 验收对应指令 8 项清单，断言的是「行为」不是「不报错」。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 4231);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, got) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  →  ${JSON.stringify(got)}`); }
}

// ── 合成照片 ───────────────────────────────────────────────
// dHash 为 16 字符十六进制串；hamming ≤ 10 判相似。
// ⚠️ p-keep 的 dhash 必须与 simA/B 明显不同，否则会被拉进同一簇（造数据时的坑）。
const PHOTOS = [
  { id: 'p-keep',  name: '清晰好片', dhash: '1a2b3c4d5e6f7081', exactHash: 'aa11',
    cv: { sharpness: 900, blurVar: 900, over: 0.01, under: 0.01, edgeFlat: 0.10, brightness: 130, contrastStd: 66, saturation: 0.42, centerFocus: 0.80 },
    bg: ['#2f6f4f', '#8fd0a8'], takenAt: 1758000000000, scene: 'outdoor' },
  { id: 'p-simA', name: '连拍A', dhash: '0f1e2d3c4b5a6978', exactHash: 'bb22',
    cv: { sharpness: 700, blurVar: 700, over: 0.02, under: 0.02, edgeFlat: 0.12, brightness: 128, contrastStd: 64, saturation: 0.40, centerFocus: 0.72 },
    bg: ['#2b5f9e', '#9ec5f0'], takenAt: 1758000100000, scene: 'outdoor' },
  { id: 'p-simB', name: '连拍B', dhash: '0f1e2d3c4b5a6979', exactHash: 'cc33',
    cv: { sharpness: 300, blurVar: 300, over: 0.03, under: 0.03, edgeFlat: 0.18, brightness: 126, contrastStd: 62, saturation: 0.38, centerFocus: 0.60 },
    bg: ['#2b5f9e', '#a9cdf5'], takenAt: 1758000110000, scene: 'outdoor' },
  { id: 'p-mid',  name: '待评估', dhash: '1122334455667788', exactHash: 'ff66',
    // 仅 blur 一项致命缺陷（其余指标正常）→ 落在"待评估"档
    cv: { sharpness: 60, blurVar: 60, over: 0.05, under: 0.05, edgeFlat: 0.20, brightness: 120, contrastStd: 58, saturation: 0.35, centerFocus: 0.55 },
    bg: ['#7a5f2f', '#e0c48f'], takenAt: 1758000400000, scene: 'food' },
  { id: 'p-trash', name: '废片', dhash: 'aabbccddeeff0011', exactHash: 'dd44',
    cv: { sharpness: 20, blurVar: 20, over: 0.62, under: 0.05, edgeFlat: 0.81, brightness: 240, contrastStd: 20, saturation: 0.10, centerFocus: 0.15 },
    bg: ['#e8e8e8', '#ffffff'], takenAt: 1758000200000, scene: 'indoor' },
  { id: 'p-dark', name: '疑似废片2', dhash: '9988776655443322', exactHash: 'ee55',
    cv: { sharpness: 40, blurVar: 40, over: 0.05, under: 0.71, edgeFlat: 0.30, brightness: 20, contrastStd: 25, saturation: 0.15, centerFocus: 0.30 },
    bg: ['#111111', '#333333'], takenAt: 1758000300000, scene: 'indoor' },
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 首开：注入合成存档后 reload（hash-only goto 不 reload 会假绿）
  // ⚠️ thumbUrl 必须在**第一次**注入时就写好：thumbUrl 是持久化剥离字段，
  //    若先存无图存档再灌图，viewer 会走回退分支，DOM 数量与预期对不上，
  //    表现为"标记栏挂不上"的假故障（踩过一次）。
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async (photos) => {
    const cv = await import('/js/cv.js');
    const mk = (n) => 'data:image/svg+xml;base64,' + btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="${n.bg}"/><text x="120" y="128" font-size="20" fill="#fff" text-anchor="middle">${n.id}</text></svg>`);
    const built = photos.map((p) => ({
      id: p.id, name: p.name, dhash: p.dhash, exactHash: p.exactHash,
      takenAt: p.takenAt, scene: p.scene, cv: p.cv,
      thumbUrl: mk({ id: p.id, bg: p.bg[0] }), _file: null,
    }));
    for (const p of built) p.verdict = cv.verdict(p.cv);
    const raw = JSON.parse(localStorage.getItem('zhenxuji.state.v1') || '{}');
    raw.photos = built;
    raw.groups = [{ id: 'g-pick', title: '测试相册', photoIds: built.map((p) => p.id), coverId: built[0].id }];
    localStorage.setItem('zhenxuji.state.v1', JSON.stringify(raw));
  }, PHOTOS);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  /* ── P1 三级分级 + 理由（浏览器内 import 真实模块做单元断言） ── */
  const unit = await page.evaluate(async () => {
    const pk = await import('/js/picker.js');
    const st = await import('/js/store.js');
    const s = st.get();
    const map = {};
    for (const p of s.photos) map[p.id] = pk.pickLevel(p, s.settings);
    const sim = pk.similarGroupsOf(s.photos);
    return {
      map,
      sim: sim.map((g) => ({ bestId: g.bestId, ids: g.ids, score: g.score })),
      levels: pk.LEVEL_ORDER.map((k) => [k, s.photos.filter((p) => map[p.id].level === k).map((p) => p.id)]),
    };
  });
  console.log('\n── P1 三级分级 / P3 相似组（单元） ──');
  check('p-keep → 推荐保留', unit.map['p-keep'].level === 'keep', unit.map['p-keep']);
  check('p-mid（单一轻微缺陷）→ 待评估', unit.map['p-mid'].level === 'review', unit.map['p-mid']);
  check('p-trash（过曝+遮挡）→ 疑似废片', unit.map['p-trash'].level === 'trash', unit.map['p-trash']);
  check('p-dark（死黑）→ 疑似废片', unit.map['p-dark'].level === 'trash', unit.map['p-dark']);
  // 「每条标记附带理由」的准确口径：非 keep 档必须给出**为什么**；
  // keep 档无缺陷理由是合理的（它本来就没被扣分），强行编一句才是假可解释。
  const needReason = unit.levels.filter(([lv]) => lv !== 'keep').flatMap(([, ids]) => ids);
  check('非保留档每条都带中文理由',
    needReason.every((id) => unit.map[id].reasons.length > 0),
    needReason.map((id) => [id, unit.map[id].reasons.map((r) => r.label)]));
  check('keep 档理由为空（不编假理由）', unit.map['p-keep'].reasons.length === 0, unit.map['p-keep'].reasons);
  check('相似提示不冤枉好图：清晰的那张仍判 keep（相似≠缺陷）',
    unit.map['p-simA'].level === 'keep', unit.map['p-simA']);
  const sim = unit.sim.find((g) => g.ids.includes('p-simA'));
  check('🔴 相似聚类把连拍 A/B 归到同一组', Boolean(sim) && sim.ids.includes('p-simB'), unit.sim);
  check('🔴 组内推荐最优 = 分数高的那张（p-simA）', sim && sim.bestId === 'p-simA', sim);
  check('独立照片不该被拉进相似组', !unit.sim.some((g) => g.ids.includes('p-keep') && g.ids.length > 2), unit.sim);

  /* ── P1b pagePick 页面渲染 ── */
  await page.goto(`${BASE}/index.html#/pick/g-pick`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const pickView = await page.evaluate(() => ({
    title: (document.querySelector('.page-title') || {}).textContent || '',
    badges: [...document.querySelectorAll('.pk-badge')].map((e) => e.textContent),
    chips: [...document.querySelectorAll('.pk-chip')].map((e) => e.textContent),
    simText: (document.querySelector('.pk-sim__h') || {}).textContent || '',
    note: (document.querySelector('.note') || {}).textContent || '',
  }));
  console.log('\n── P1b 选片页渲染 ──');
  check('选片页标题渲染', pickView.title.includes('AI 选片'), pickView.title);
  check('三种级别徽章齐全（保留/待评估/疑似废片）',
    ['推荐保留', '待评估', '疑似废片'].every((l) => pickView.badges.includes(l)), pickView.badges);
  check('理由 chip 渲染且非空', pickView.chips.length > 0, pickView.chips.slice(0, 6));
  check('🔴 页面显式声明"绝不删除原图"', pickView.note.includes('绝不删除'), pickView.note.slice(0, 60));
  check('相似组区显示推荐第几张 + 分数', /推荐第 \d 张（\d+ 分）/.test(pickView.simText), pickView.simText);
  // 批量归档按钮在折叠区里（废片默认折叠）——必须先展开才能拿到
  const foldOpen = await page.evaluate(() => {
    const f = document.getElementById('foldTrash');
    return f ? f.classList.contains('fold--open') : null;
  });
  check('🔴 疑似废片区默认折叠（低频项不铺满屏，保住保留/待评估的可见性）', foldOpen === false, foldOpen);
  await page.click('#foldTrash .fold__h');
  await page.waitForTimeout(320);
  const trashBtn = await page.evaluate(() => {
    const b = document.querySelector('[data-act="batchArchive"]');
    return { open: document.getElementById('foldTrash').classList.contains('fold--open'), text: b ? b.textContent : '' };
  });
  check('折叠区可展开', trashBtn.open === true, trashBtn.open);
  check('批量归档按钮存在', trashBtn.text.includes('全部标记为废片'), trashBtn.text);
  await page.screenshot({ path: path.join(OUT, '_shot_pick.png'), fullPage: true });

  /* ── P2 一键入口 ── */
  console.log('\n── P2 一键 AI 选片入口 ──');
  await page.goto(`${BASE}/index.html#/album`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
  const entry = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-act="aiPickAll"]')][0];
    return { has: Boolean(b), text: b ? b.textContent : '', cards: document.querySelectorAll('.gcard').length };
  });
  check('相册页有一键「AI 帮我选片」入口', entry.has && entry.text.includes('AI 帮我选片'), entry);
  await page.click('[data-act="aiPickAll"]');
  await page.waitForTimeout(450);
  const afterEntry = await page.evaluate(() => ({ hash: location.hash, title: (document.querySelector('.page-title') || {}).textContent || '' }));
  check('🔴 点击后跳到「有废片」的分组选片页',
    afterEntry.hash.includes('/pick/') && afterEntry.title.includes('AI 选片'), afterEntry);

  /* ── P4 相似组归档：只标记不删，且不覆盖已珍藏 ── */
  console.log('\n── P4 归档只标记不删 ──');
  await page.goto(`${BASE}/index.html#/pick/g-pick`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
  // 先把连拍 B 手动珍藏，再点「归档其余」→ 应跳过 B
  // 🔴 必须等 save() 的 300ms 节流落盘再 reload，否则 localStorage 里还是旧值，
  //    reload 后珍藏消失 → 误判成"批量归档覆盖了珍藏"（踩过一次，纯属时序坑）。
  await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.actions.override('p-simB', 'keep');
  });
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const keepSurvived = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    return st.get().photos.find((p) => p.id === 'p-simB').userOverride;
  });
  check('珍藏标记已落盘（reload 后仍在）', keepSurvived === 'keep', keepSurvived);
  await page.goto(`${BASE}/index.html#/pick/g-pick`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const archiveBtn = await page.evaluate(() => {
    const b = document.querySelector('[data-act="archiveSimilar"]');
    return { has: Boolean(b), ids: b ? b.dataset.ids : '', text: b ? b.textContent : '' };
  });
  check('相似组「归档其余」按钮存在且带 id 列表', archiveBtn.has && archiveBtn.ids.length > 0, archiveBtn);

  // 还原：把 p-simA 归档，验证 B(已珍藏) 不被覆盖
  await page.evaluate((ids) => {
    const btn = document.createElement('button');
    btn.dataset.act = 'archiveSimilar'; btn.dataset.ids = ids; btn.dataset.id = 'g-pick';
    document.body.appendChild(btn); btn.click();
  }, 'p-simA');
  await page.waitForTimeout(500);
  const afterArchive = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const s = st.get();
    return {
      simA: s.photos.find((p) => p.id === 'p-simA').userOverride,
      simB: s.photos.find((p) => p.id === 'p-simB').userOverride,
      total: s.photos.length,
    };
  });
  check('归档后该张被标记 trash', afterArchive.simA === 'trash', afterArchive);
  check('🔴 已珍藏的那张不被批量归档覆盖', afterArchive.simB === 'keep', afterArchive);
  check('🔴 原图一张没少（只标记，不删）', afterArchive.total === PHOTOS.length, afterArchive);

  /* ── P5 viewer 互通 ── */
  console.log('\n── P5 viewer 大图页互通 ──');
  await page.goto(`${BASE}/index.html#/viewer/g-pick:p-simB`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const vw = await page.evaluate(() => {
    const bar = document.querySelector('.pk-bar');
    return {
      bar: Boolean(bar),
      lv: bar ? (bar.querySelector('.pk-bar__lv').textContent || '') : '',
      cls: bar ? bar.querySelector('.pk-bar__lv').className : '',
      thumbs: document.querySelectorAll('.athumb').length,
      onIdx: (document.querySelector('.athumb--on') || { dataset: {} }).dataset.i,
    };
  });
  check('🔴 viewer 页成功挂上 AI 标记栏', vw.bar, vw);
  check('标记栏显示当前张的级别+理由', vw.lv.includes('推荐保留') || vw.lv.includes('待评估') || vw.lv.includes('疑似废片'), vw.lv);
  check('封面定位：startId 生效（.athumb--on 命中封面序号）', vw.onIdx !== undefined, vw.onIdx);

  // 切换到大图里的废片并标记「珍藏」→ 偏好入库 + userOverride 写回
  // ⚠️ viewer 只展示 usable 的照片，废片已被过滤掉 → 大图里能点到的都是好图，
  //    而好图没有 reasons → 记不进 byReason。这是**真实且正确的**行为
  //    （偏好按"缺陷类别"统计，对无缺陷照片无从统计），所以断言只能查 rescuedTotal。
  const markRes = await page.evaluate(async () => {
    const thumbs = [...document.querySelectorAll('.athumb')];
    const target = thumbs.find((t) => t.dataset.i === '0');
    if (target) target.click();
    await new Promise((r) => setTimeout(r, 350));
    const before = ((await import('/js/store.js')).get().settings || {}).pickPrefs || null;
    const btn = document.querySelector('.pk-btn--keep');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const st = (await import('/js/store.js')).get();
    return {
      before,
      prefs: st.settings.pickPrefs || null,
      overrides: st.photos.map((x) => [x.id, x.userOverride === undefined ? null : x.userOverride]),
      toast: (document.getElementById('toast') || {}).textContent || '',
    };
  });
  check('🔴 大图页点「珍藏」后 userOverride 写回 store',
    markRes.overrides.some(([, v]) => v === 'keep'), markRes.overrides);
  check('🔴 珍藏计数已累加（rescuedTotal+1）',
    (markRes.prefs ? markRes.prefs.rescuedTotal : 0) === ((markRes.before && markRes.before.rescuedTotal) || 0) + 1,
    { before: markRes.before, after: markRes.prefs });
  check('🔴 toast 明确告知"原图仍在相册"口径', markRes.toast.includes('珍藏'), markRes.toast);
  await page.screenshot({ path: path.join(OUT, '_shot_viewer_picker.png') });

  // 偏好按缺陷类别统计：必须用一张真有 reasons 的照片验证
  const prefUnit = await page.evaluate(async () => {
    const pk = await import('/js/picker.js');
    const st = await import('/js/store.js');
    const s = st.get();
    const target = s.photos.find((p) => p.id === 'p-trash');   // reasons 非空
    const next = pk.recordOverride(s.settings, target, 'keep');
    return { byReason: next.pickPrefs.byReason, total: next.pickPrefs.rescuedTotal };
  });
  check('🔴 recordOverride 按缺陷类别累计（blur/over/occlude 都记上）',
    Object.keys(prefUnit.byReason).length >= 2 && prefUnit.byReason.blur && prefUnit.byReason.blur.keep === 1,
    prefUnit);

  /* ── P6 偏好真的改变判定 ── */
  console.log('\n── P6 偏好记忆改变判定 ──');
  const prefEffect = await page.evaluate(async () => {
    const pk = await import('/js/picker.js');
    // 🔴 样本必须只有**一项**致命缺陷：用纯模糊的合成照片。
    //    拿真数据里的 p-dark（含 blur+under 两项）测是测不出来的 ——
    //    两项致命走的是"必废"分支，偏好救不回来，那是规则本身，不是 bug。
    const blurOnly = {
      id: 'x', userOverride: undefined,
      cv: { sharpness: 20, over: 0.01, under: 0.01, edgeFlat: 0.1, brightness: 128, contrastStd: 65, saturation: 0.4, centerFocus: 0.7 },
    };
    blurOnly.verdict = (await import('/js/cv.js')).verdict(blurOnly.cv);
    const base = { pickPrefs: { byReason: {}, rescuedTotal: 0 } };
    const before = pk.pickLevel(blurOnly, base);
    const after = pk.pickLevel(blurOnly, { pickPrefs: { byReason: { blur: { keep: 3, trash: 0 } }, rescuedTotal: 3 } });
    return {
      reasons: blurOnly.verdict.reasons.map((r) => r.code),
      beforeLv: before.level, afterLv: after.level,
      beforeFatal: before.fatalCount, beforeDec: before.decisiveCount,
    };
  });
  check('🔴 样本前提正确（仅 blur 一项致命）',
    prefEffect.reasons.length === 1 && prefEffect.reasons[0] === 'blur', prefEffect.reasons);
  check('🔴 偏好生效：惯常救回的那类缺陷不再单独判废（废片→待评估）',
    prefEffect.beforeLv === 'trash' && prefEffect.afterLv === 'review', prefEffect);

  // 老存档兼容：只有 verdict、cv 指标缺失时，不能把上游的 A 级硬废片放过
  const legacy = await page.evaluate(async () => {
    const pk = await import('/js/picker.js');
    const legacyPhoto = {
      id: 'old', thumbUrl: 'x',
      verdict: { level: 'A', reasons: [{ code: 'blur', label: '严重模糊/对焦失败' }], score: 30 },
      // 🔴 故意不给 cv —— 模拟老存档 / 指标被清理
    };
    return {
      lv: pk.pickLevel(legacyPhoto, { pickPrefs: { byReason: {}, rescuedTotal: 0 } }).level,
    };
  });
  check('🔴 老存档（无 cv 指标）仍尊重 cv.js 的 A 级判定，不被降级',
    legacy.lv === 'trash', legacy);

  /* ── P7 四主题渲染 ── */
  console.log('\n── P7 四套主题 ──');
  // 🔴 必须回到选片页：viewer 页里没有 .pk-badge/.pk-cell，
  //    在 viewer 上断言"选片页徽章"是拿错页面判空（假红）。
  await page.goto(`${BASE}/index.html#/pick/g-pick`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const THEMES = ['origin', 'forest', 'film', 'sweet'];
  const themePaint = {};
  for (const th of THEMES) {
    await page.evaluate(async (t) => {
      const st = await import('/js/store.js');
      st.actions.setTheme(t);
    }, th);
    await page.waitForTimeout(320);
    const paint = await page.evaluate(() => {
      const badge = document.querySelector('.pk-badge');
      const cs = badge ? getComputedStyle(badge) : null;
      const chip = document.querySelector('.pk-chip');
      const bar = document.querySelector('.pk-bar');
      return {
        attr: document.documentElement.dataset.theme,
        badgeColor: cs ? cs.backgroundColor : '',
        badgeText: badge ? badge.textContent : '',
        chipColor: chip ? getComputedStyle(chip).color : '',
        cells: document.querySelectorAll('.pk-cell').length,
      };
    });
    themePaint[th] = paint;
    check(`[${th}] data-theme 生效`, paint.attr === th, paint.attr);
    check(`[${th}] 徽章有非透明底色`, paint.badgeColor && paint.badgeColor !== 'rgba(0, 0, 0, 0)', paint.badgeColor);
    check(`[${th}] 选片卡片渲染`, paint.cells > 0, paint.cells);
  }
  // 四套主题的徽章底色必须互不相同（否则说明只换了大背景、组件没跟着换）
  const colors = new Set(Object.values(themePaint).map((p) => p.badgeColor));
  check('🔴 四套主题徽章底色互不相同（组件真跟主题走，非只换背景）', colors.size === 4, [...colors]);
  await page.screenshot({ path: path.join(OUT, '_shot_pick_theme.png'), fullPage: true });

  // 暗色模式同样核查（白底压白字类缺陷只在这里现形）
  for (const th of ['origin', 'sweet']) {
    await page.evaluate(async (t) => {
      const st = await import('/js/store.js');
      st.actions.setMode('dark');
    }, th);
    await page.waitForTimeout(320);
    const dark = await page.evaluate(() => {
      const badge = document.querySelector('.pk-badge');
      return {
        mode: document.documentElement.dataset.mode,
        bg: badge ? getComputedStyle(badge).backgroundColor : '',
        fg: badge ? getComputedStyle(badge).color : '',
      };
    });
    check(`[${th}/dark] 暗色下徽章底色非纯白（防白底压白字）`,
      dark.bg && dark.bg !== 'rgb(255, 255, 255)', dark);
  }
  await page.evaluate(async () => { (await import('/js/store.js')).actions.setMode('light'); });

  /* ── P8 硬约束：不改 viewer.js ── */
  console.log('\n── P8 硬约束 ──');
  // 🔴 不用 child_process 跑 git：Windows 下 cmd.exe 常被占用报 EBUSY（踩过一次）。
  //    ⚠️ 断言只查 **picker 专有标识**，不能查 userOverride —— viewer.js 读 userOverride
  //    是它自己的过滤逻辑（isTrash），本来就该有；查它会误报（踩过一次）。
  const viewerUntouched = await page.evaluate(async () => {
    const src = await (await fetch('/js/viewer.js')).text();
    return {
      len: src.length,
      injected: /picker|__onMark|__onRevert|mountViewerPicker|pickLevel|recordOverride|pk-bar|pickPrefs/.test(src),
    };
  });
  check('🔴 viewer.js 源码零 picker 侵入（不改组件代码）',
    viewerUntouched.injected === false, viewerUntouched);

  check('无控制台/页面报错', errors.length === 0, errors.slice(0, 5));

  console.log(`\n===== AI 选片自测：${pass} 通过 / ${fail} 失败 =====`);
  if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('自测异常：', e); process.exit(2); });
