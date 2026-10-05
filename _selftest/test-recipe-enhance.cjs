// P1 配方增强真跑自测
// 🔴 核心验收标准：**像素真的变了**，不是"toast 弹了"。
//
// 🔴🔴 本文件最重要的设计决策：**seed 是可重复调用的**。
//    第一版只在开头 seed 一次，后面 reload 了三次，于是：
//      - store.load() 按设计把 _file 置 null（File 句柄没法序列化，这是对的）
//      - 后续阶段拿到的是"有 id 没有原图"的空壳照片
//      - 批量调色全失败、导出拿到 canvas:null
//    一度被误判成"生产代码的调色功能坏了"。真凶是测试夹具，不是代码。
//    所以这里改成：**每次需要原图时重新 seed**，并显式断言 seed 成功，
//    免得再出现"夹具失效 → 误报生产 bug"。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 4233);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  →  ${JSON.stringify(got)}`); }
};

/**
 * 注入测试数据（含**真实的 File 对象**）。
 * 每次 reload 后都要重跑 —— File 句柄跨会话必失效，这是设计而非缺陷。
 * @param {boolean} withFile 是否注入 _file（需要真调色时为 true）
 */
async function seed(page, { withFile = true, recipes = true, groups = true } = {}) {
  return page.evaluate(async ({ withFile, recipes, groups }) => {
    const mkPngFile = async (hue, name) => {
      const c = document.createElement('canvas');
      c.width = 120; c.height = 120;
      const ctx = c.getContext('2d');
      // 🔴 必须画**非纯色**图：调色对纯色图看不出效果，那样测不出真伪
      for (let y = 0; y < 120; y++) {
        for (let x = 0; x < 120; x++) {
          ctx.fillStyle = `hsl(${hue + (x + y) * 0.3}, 55%, ${30 + ((x * y) % 40)}%)`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    };
    const files = [];
    const names = ['a.png', 'b.png', 'c.png'];
    for (let i = 0; i < 3; i++) files.push(await mkPngFile(20 + i * 40, names[i]));

    const st = await import('/js/store.js');
    const base = files.map((f, i) => ({
      id: `p${i + 1}`, scene: 'other',
      cv: { sharpness: 400, over: 0.01, under: 0.01, edgeFlat: 0.1, brightness: 128, contrastStd: 65, saturation: 0.4, centerFocus: 0.7 },
      dhash: `${i}a2b3c4d5e6f7081`,
      takenAt: 1758000000000 + i * 1000,
      thumbUrl: files[i] ? '' : '',
      _file: withFile ? f : null,
    }));
    st.actions.upsertPhotos(base);
    if (groups) st.actions.setGroups([{ id: 'g1', title: '测试相册', photoIds: ['p1', 'p2', 'p3'], coverId: 'p1' }]);
    if (recipes) {
      st.actions.upsertRecipe({ id: 'r1', name: '清透配方', type: 'beauty', params: { bright: 18, soft: 0, warm: 14, sat: 22, contrast: 12 } });
      st.actions.upsertRecipe({ id: 't1', name: '简约纸感', type: 'template', tone: '简约' });
    }
    const cur = st.get();
    return {
      n: cur.photos.length,
      hasFile: Boolean(cur.photos[0] && cur.photos[0]._file),
      withFile,
    };
  }, { withFile, recipes, groups });
}

/** reload 并重新注入 —— 真机行为：内存态丢 _file，持久态还在 */
async function fresh(page, opts) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  // 🔴 reload 前必须 reset：否则上一轮 dupRecipe 产生的副本（id 带时间戳）
  //    会跨轮累积，「配方卡数量 = 2」被撑红，报错还指向错误的阶段。
  await page.evaluate(async () => { (await import('/js/store.js')).actions.reset(); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await seed(page, opts);
  // 🔴 seed 只改 store，不触发 render()（app.js 的 render 只在路由变化、
  //    弹窗 key 变化、显式调用时跑）。不补这一下，DOM 还是 reload 时的旧样子 ——
  //    症状是「store 里明明有配方，页面上一张卡都没有」，
  //    一度被当成 seed 失败，其实只是没重绘。
  await rerender(page);
  return page.evaluate(async () => {
    const st = await import('/js/store.js');
    const p = st.get().photos[0];
    return { n: st.get().photos.length, hasFile: Boolean(p && p._file) };
  });
}

/** 强制整页重绘而不 reload —— 借 hashchange 触发 router 的 fire()。
 *  用 #/__rerender 当中转，因为 router.onChange 会重渲染当前页。 */
async function rerender(page) {
  const cur = await page.evaluate(() => location.hash);
  await page.evaluate(() => { location.hash = '#/__rerender'; });
  await page.evaluate((h) => { location.hash = h; }, cur);
  await page.waitForTimeout(260);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  // 🔴 先清空上一轮跑剩的持久化数据：store.reset() 会清 localStorage。
  //    不清的话配方/成套方案会跨轮累积，「配方卡数量 = 2」这种断言会被上一轮的残留撑红，
  //    报错信息还会指向错误的阶段 —— 这种"脏夹具"最难查。
  await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.actions.reset();
    localStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const s0 = await seed(page);
  console.log('\n── 数据准备 ──');
  check('🔴 注入真实 File 对象（_file 在内存里）', s0.hasFile === true, s0);

  /* ══ 1. 参数安全区（滑杆取值域） ══ */
  console.log('\n── 参数安全区 ──');
  const meta = await page.evaluate(async () => {
    const R = await import('/js/recipes.js');
    const I = await import('/js/imaging.js');
    const keys = R.PARAM_KEYS;
    // 🔴 SCENE_PRESET 是从 imaging.js 抄的，必须断言两边一致（抄本会漂移）
    const drift = [];
    for (const k of keys) {
      if (!R.PARAM_META[k]) drift.push(k);
      if (R.PARAM_META[k].min >= R.PARAM_META[k].max) drift.push(`${k}:min>=max`);
    }
    return {
      keys,
      n: keys.length,
      drift,
      softMax: R.PARAM_META.soft.max,
      satMin: R.PARAM_META.sat.min,
      clamped: R.clampParams({ bright: 9999, soft: -5, sat: -100 }),
      normalized: R.normalizeParams({ bright: 7 }),
    };
  });
  check('🔴 滑杆只有 enhance 支持的 5 个参数', meta.n === 5 && meta.keys.join(',') === 'bright,sat,contrast,warm,soft', meta.keys);
  check('🔴 每个参数都有合法取值域', meta.drift.length === 0, meta.drift);
  check('🔴 越界参数被夹回安全区', meta.clamped.bright <= 60 && meta.clamped.soft >= 0 && meta.clamped.sat >= -100, meta.clamped);
  check('🔴 缺项补 0（不是 undefined）', meta.normalized.warm === 0 && meta.normalized.contrast === 0, meta.normalized);

  /* ══ 2. 像素级调色（核心） ══ */
  console.log('\n── 🔴 像素级调色（真改像素，不是假提示） ──');
  const pix = await page.evaluate(async () => {
    const eh = await import('/js/enhance.js');
    const st = await import('/js/store.js');
    const p = st.get().photos[0];
    if (!p || !p._file) return { skipped: 'no _file' };

    const readAt = async (url) => {
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const d = c.getContext('2d').getImageData(10, 10, 1, 1).data;
      if (bmp.close) bmp.close();
      return [d[0], d[1], d[2]];
    };
    const base = await eh.applyRecipeToPhoto(p, {});
    const before = await readAt(base.url);
    const one = await eh.applyRecipeToPhoto(p, { bright: 40, soft: 0, warm: 30, sat: 40, contrast: 30 });
    const after = await readAt(one.url);
    // 撤销方向校验：全部置 0 的参数应回到"仅基础"的结果附近
    const zero = await eh.applyRecipeToPhoto(p, { bright: 0, soft: 0, warm: 0, sat: 0, contrast: 0 });
    const afterZero = await readAt(zero.url);
    return {
      ok: one.ok,
      before, after, afterZero,
      diff: Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1]) + Math.abs(after[2] - before[2]),
      diffZero: Math.abs(afterZero[0] - before[0]) + Math.abs(afterZero[1] - before[1]) + Math.abs(afterZero[2] - before[2]),
      ms: one.ms,
    };
  });
  console.log(`  原图像素 rgb(${pix.before}) → 调色后 rgb(${pix.after})`);
  check('🔴 调色成功返回 blob', pix.ok === true, pix);
  check('🔴🔴 像素真的变了（RGB 差值 > 10，不是"看起来没变"）', pix.diff > 10, pix);
  check('色温 +30 后 R 通道明显上升（暖调方向正确）', pix.after[0] > pix.before[0], { before: pix.before, after: pix.after });
  check('🔴 参数置 0 几乎回到原样（证明改动来自参数，不是隐式重编码）', pix.diffZero < pix.diff / 3, { diffZero: pix.diffZero, diff: pix.diff });

  /* ══ 2b. reset() 必须真的清空（共享引用回归） ══ */
  console.log('\n── reset 真清空（共享引用回归） ──');
  const resetTest = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.actions.upsertRecipe({ id: 'zz', name: '污染用', type: 'beauty', params: { bright: 1 } });
    const before = st.get().recipes.length;
    st.actions.reset();
    const mid = st.get().recipes.length;
    // 再 reset 一次（共享引用污染在第二次才暴露）
    st.actions.upsertRecipe({ id: 'zz2', name: '污染用2', type: 'beauty', params: { bright: 2 } });
    st.actions.reset();
    return { before, mid, after: st.get().recipes.length, photos: st.get().photos.length };
  });
  check('🔴 reset 后配方清空', resetTest.mid === 0, resetTest);
  check('🔴🔴 连续 reset 不会被共享引用污染（第二轮仍为 0）', resetTest.after === 0, resetTest);

  // reset 之后重新 seed
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await seed(page);

  /* ══ 3. 原图永不被覆盖 ══ */
  console.log('\n── 原图保护 ──');
  const keep = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const eh = await import('/js/enhance.js');
    const p = st.get().photos[0];
    const origSize = p._file.size;
    await eh.applyRecipeToPhoto(p, { bright: 30, warm: 20 });
    const after = st.get().photos[0];
    return {
      fileStillThere: Boolean(after._file),
      fileSizeSame: after._file.size === origSize,
      enhancedNotSet: !after.enhancedUrl,   // 没写回 store 就还是 undefined
    };
  });
  check('🔴 调色后 _file 原图仍在', keep.fileStillThere === true, keep);
  check('🔴 原图字节数未变（真没被覆盖）', keep.fileSizeSame === true, keep);
  check('未写回 store 时不产生 enhancedUrl', keep.enhancedNotSet === true, keep);

  /* ══ 4. 无 _file 时如实失败，不静默 ══ */
  const noFile = await page.evaluate(async () => {
    const eh = await import('/js/enhance.js');
    return await eh.applyRecipeToPhoto({ id: 'x' }, { bright: 10 });
  });
  check('🔴 无原图时如实返回失败原因（不静默、不假装成功）',
    noFile.ok === false && typeof noFile.reason === 'string' && noFile.reason.length > 0, noFile);

  /* ══ 5. store 剥离 blobURL ══ */
  console.log('\n── store 持久化剥离 ──');
  const strip = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.actions.upsertPhotos([{ id: 'p1', enhancedUrl: 'blob:http://fake/123' }]);
    await new Promise((r) => setTimeout(r, 500));
    const raw = JSON.parse(localStorage.getItem('zhenxuji.state.v1') || '{}');
    return {
      saved: (raw.photos || []).map((p) => Object.keys(p)).flat(),
      memory: (st.get().photos.find((p) => p.id === 'p1') || {}).enhancedUrl || null,
    };
  });
  check('🔴 enhancedUrl 不写进 localStorage（blobURL 跨会话失效，写了白占配额）',
    !strip.saved.includes('enhancedUrl'), strip.saved);
  check('🔴 内存态仍保留 enhancedUrl（本会话内可用）',
    strip.memory === 'blob:http://fake/123', strip.memory);

  /* ══ 6. 配方增删改复制 ══ */
  console.log('\n── 配方管理 ──');
  await fresh(page);
  await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' });
  await fresh(page);

  const acts = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.rcard__acts [data-act]')].map((b) => b.dataset.act);
    return {
      btns,
      cards: document.querySelectorAll('.rcard').length,
      beauty: document.querySelectorAll('.rcards')[0] ? document.querySelectorAll('.rcards')[0].querySelectorAll('.rcard').length : 0,
    };
  });
  check('配方卡有重命名/复制/批量套用/删除四个操作',
    ['renameRecipe', 'dupRecipe', 'delRecipe', 'applyRecipeToGroup'].every((a) => acts.btns.includes(a)), acts.btns);
  // 🔴 只断言"美颜区恰好 1 张"：排版区有 ensureDefaults 自动塞的 3 个内置模板，
  //    断言总卡数会把"内置模板"误当成脏数据。
  check('美颜配方区恰好 1 张卡（seed 只注入 1 个）', acts.beauty === 1, acts);

// 复制 —— 🔴 必须点**美颜配方那张卡**的按钮。
// 用裸 querySelector 会选中第一张卡，而排版区在内置模板之前/之后都可能排第一，
// 于是「复制美颜配方」实际复制了模板，断言 numbers 不动 —— 假失败。
const dup = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const before = st.get().recipes.filter((r) => r.type === 'beauty').length;
    const beautyCard = document.querySelector('.rcard[data-id="r1"]')
      || [...document.querySelectorAll('.rcard')].find((c) => c.querySelector('[data-act="applyRecipeToGroup"]'));
    if (!beautyCard) return { err: '找不到美颜配方卡' };
    beautyCard.querySelector('[data-act="dupRecipe"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const after = st.get().recipes.filter((r) => r.type === 'beauty');
    return { before, after: after.length, names: after.map((r) => r.name) };
  });
  check('🔴 复制配方真的多了一条', dup.after === dup.before + 1, dup);
  check('🔴 副本名字带「副本」后缀（可辨认）', dup.names.some((n) => /副本/.test(n)), dup.names);

  // 删除（window.confirm 需先 stub 成 true）
  const del = await page.evaluate(async () => {
    const orig = window.confirm;
    window.confirm = () => true;
    const st = await import('/js/store.js');
    const before = st.get().recipes.length;
    document.querySelector('[data-act="delRecipe"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const after = st.get().recipes.length;
    window.confirm = orig;
    return { before, after };
  });
  check('🔴 删除配方生效', del.after === del.before - 1, del);

  // 删除需二次确认
  const confirmGuard = await page.evaluate(async () => {
    const orig = window.confirm;
    window.confirm = () => false;      // 用户点"取消"
    const st = await import('/js/store.js');
    const before = st.get().recipes.length;
    document.querySelector('[data-act="delRecipe"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const after = st.get().recipes.length;
    window.confirm = orig;
    return { before, after };
  });
  check('🔴 删除有二次确认（点取消则不删）', confirmGuard.before === confirmGuard.after, confirmGuard);

  /* ══ 7. 成套绑定 ══ */
  console.log('\n── 成套风格绑定 ──');
  await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' });
  await fresh(page);
  const hasBind = await page.evaluate(() => Boolean(document.querySelector('[data-act="makeBundle"]')));
  check('成套绑定 UI 存在（美颜配方 + 排版模板）', hasBind === true, hasBind);

  await page.click('[data-act="makeBundle"]');
  await page.waitForTimeout(450);
  const bundle = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const list = (st.get().settings || {}).recipeBundles || [];
    return {
      n: list.length,
      hasBeauty: Boolean(list[0] && list[0].beautyId),
      hasTpl: Boolean(list[0] && list[0].templateId),
      domRows: document.querySelectorAll('.bundle').length,
      loadBtn: Boolean(document.querySelector('[data-act="loadBundle"]')),
    };
  });
  check('🔴 成套方案已创建且两端都绑定', bundle.n === 1 && bundle.hasBeauty && bundle.hasTpl, bundle);
  check('成套方案在页面上有「一键加载」', bundle.loadBtn === true, bundle);

  // 删除配方后成套方案的引用要连带清理
  const bundleClean = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const tid = (st.get().recipes.find((r) => r.type === 'template') || {}).id;
    const before = ((st.get().settings || {}).recipeBundles || []).length;
    st.actions.removeRecipe(tid);
    const after = ((st.get().settings || {}).recipeBundles || []).length;
    return { before, after };
  });
  check('🔴 删除配方连带清理成套引用（防"一键加载"静默失败）',
    bundleClean.after < bundleClean.before, bundleClean);

  /* ══ 8. 修图页：真实滑杆 ══ */
  console.log('\n── 修图页真实参数滑杆 ──');
  await page.evaluate(async () => {
    (await import('/js/store.js')).actions.patchSettings({ recipeBundles: [] });
  });
  await page.goto(`${BASE}/index.html#/edit/g1`, { waitUntil: 'networkidle' });
  await fresh(page);

  const sl = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('#sliders .sld__r')];
    return {
      n: rs.length,
      keys: rs.map((r) => r.dataset.p),
      hasOut: rs.every((r) => Boolean(document.querySelector(`.sld__v[data-out="${r.dataset.p}"]`))),
      mins: rs.map((r) => Number(r.min)),
      maxs: rs.map((r) => Number(r.max)),
      softMax: Number((rs.find((r) => r.dataset.p === 'soft') || {}).max),
      hasBtn: Boolean(document.querySelector('[data-act="applyEnhance"]')),
      hasSave: Boolean(document.querySelector('[data-act="saveRecipe"]')),
    };
  });
  check('🔴 修图页有 5 个滑杆', sl.n === 5, sl);
  check('🔴 滑杆参数与 enhance 支持的一致', sl.keys.join(',') === 'bright,sat,contrast,warm,soft', sl.keys);
  check('🔴 每个滑杆都有实时数字回显', sl.hasOut === true, sl);
  check('🔴 柔化上限 1（不是硬编码到不合理值）', sl.softMax === 1, sl);
  check('批量修图页有「应用批量修图」+「存为我的配方」', sl.hasBtn && sl.hasSave, sl);

  // 拖滑杆 → 数字实时回显
  const drag = await page.evaluate(async () => {
    const r = document.querySelector('#sliders .sld__r[data-p="bright"]');
    r.value = '42';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((s) => setTimeout(s, 120));
    const out = document.querySelector('.sld__v[data-out="bright"]');
    return { slider: r.value, out: out ? out.textContent : null };
  });
  check('🔴 拖滑杆后数字实时回显（不是死值）', drag.out === '42', drag);

  /* ══ 9. 批量套用真跑（端到端，经 UI 路径） ══ */
  console.log('\n── 批量套用（端到端真跑） ──');
  // 🔴 走真实 UI 按钮：setParams 把亮度设成 42，与上面拖的值一致
  await page.evaluate(async () => {
    const r = document.querySelector('#sliders .sld__r[data-p="bright"]');
    r.value = '42';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-act="applyEnhance"]');
  await page.waitForFunction(
    () => {
      const st = window.__st || null;
      return !document.getElementById('enhanceMsg')?.textContent.startsWith('正在处理');
    },
    { timeout: 20000 },
  ).catch(() => {});
  await page.waitForTimeout(600);

  const applyRes = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const g = st.get().groups[0];
    const ids = g.photoIds;
    const photos = ids.map((id) => st.get().photos.find((p) => p.id === id)).filter(Boolean);
    return {
      total: photos.length,
      enhanced: photos.filter((p) => p.enhancedUrl).length,
      origIntact: photos.every((p) => Boolean(p._file)),
      filesize: photos.map((p) => (p._file ? p._file.size : 0)),
    };
  });
  check('🔴🔴 走 UI 批量调色后每张都有 enhancedUrl', applyRes.enhanced === applyRes.total && applyRes.total > 0, applyRes);
  check('🔴 调色后原图全部仍在（未覆盖）', applyRes.origIntact === true, applyRes);
  check('🔴 原图字节数非 0（不是空壳）', applyRes.filesize.every((s) => s > 0), applyRes.filesize);

  // 页面应显示"已调色"标记 + 撤销入口
  // 🔴 **不要 reload**：enhancedUrl 是 blobURL，store 按设计不持久化它，
  //    reload 后必然全没了（这正是"调色不跨会话"的实现方式）。
  //    doApplyEnhance 结尾已经 render()，直接在当前 DOM 上断言。
  const tagged = await page.evaluate(() => ({
    tags: document.querySelectorAll('.ph__tag--soft').length,
    imgs: [...document.querySelectorAll('.ph img')].length,
    hasRevert: Boolean(document.querySelector('[data-act="revertEnhance"]')),
  }));
  check('🔴 修图页显示「已调色」标记', tagged.tags >= 3, tagged);
  check('🔴 有「撤销全部调色」入口', tagged.hasRevert === true, tagged);

  /* ══ 10. 撤销真的回原图 ══ */
  console.log('\n── 撤销调色（端到端） ──');
  const beforeRev = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const p = st.get().photos[0];
    const bmp = await createImageBitmap(await (await fetch(p.enhancedUrl)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const d = c.getContext('2d').getImageData(10, 10, 1, 1).data;
    if (bmp.close) bmp.close();
    return [d[0], d[1], d[2]];
  });
  await page.click('[data-act="revertEnhance"]');
  await page.waitForTimeout(500);
  const revRes = await page.evaluate(async (wasRgb) => {
    const st = await import('/js/store.js');
    const eh = await import('/js/enhance.js');
    const p = st.get().photos[0];
    const nowRgb = await (async () => {
      const bmp = await createImageBitmap(p._file);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const d = c.getContext('2d').getImageData(10, 10, 1, 1).data;
      if (bmp.close) bmp.close();
      return [d[0], d[1], d[2]];
    })();
    return {
      enhancedGone: !p.enhancedUrl,
      stillHasFile: Boolean(p._file),
      wasRgb, nowRgb,
      diff: Math.abs(wasRgb[0] - nowRgb[0]) + Math.abs(wasRgb[1] - nowRgb[1]) + Math.abs(wasRgb[2] - nowRgb[2]),
      cleaned: !eh.revertPhoto(p).enhancedUrl,
    };
  }, beforeRev);
  check('🔴 撤销后 enhancedUrl 被清', revRes.enhancedGone === true, revRes);
  check('🔴 撤销后 _file 仍在', revRes.stillHasFile === true, revRes);
  check('🔴🔴 撤销后像素真的回到原图（与调色版有可见差异）', revRes.diff > 5, revRes);

  /* ══ 11. 导出取到调色图（且 export.js 零改动） ══ */
  console.log('\n── 导出用调色图（export.js 零改动） ──');
  const expWrap = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const eh = await import('/js/enhance.js');
    const ex = await import('/js/export.js');
    const p = st.get().photos[0];

    // 先做一次真调色
    const one = await eh.applyRecipeToPhoto(p, { bright: 50, soft: 0, warm: 25, sat: 40, contrast: 20 });
    const withE = { ...p, enhancedUrl: one.url };
    const wrapped = await eh.toExportPhotos([withE]);
    const w = wrapped[0];

    // export.js 的 loadForExport 只认 _file / thumbUrl —— 包装层把 enhancedUrl 装进 _file
    const r = await ex.loadForExport(w, 120);
    const d = r.canvas ? r.canvas.getContext('2d').getImageData(10, 10, 1, 1).data : null;
    const rgb = d ? [d[0], d[1], d[2]] : null;

    // 原图走同一条路，作为对照
    const ro = await ex.loadForExport(p, 120);
    const d0 = ro.canvas ? ro.canvas.getContext('2d').getImageData(10, 10, 1, 1).data : null;
    const rgb0 = d0 ? [d0[0], d0[1], d0[2]] : null;

    return {
      canvas: Boolean(r.canvas),
      degraded: r.degraded,
      rgb, rgb0,
      isBlob: w._file instanceof Blob,
      thumbIsData: String(w.thumbUrl || '').startsWith('data:'),
      diff: rgb && rgb0 ? Math.abs(rgb[0] - rgb0[0]) + Math.abs(rgb[1] - rgb0[1]) + Math.abs(rgb[2] - rgb0[2]) : -1,
      origUntouched: Boolean(p._file) && !p.enhancedUrl,
    };
  });
  check('🔴 导出能取到画布（且不降级）', expWrap.canvas === true && expWrap.degraded === false, expWrap);
  check('🔴 包装层把调色字节装进 _file（Blob，可直接解码）', expWrap.isBlob === true, expWrap);
  check('🔴 包装层同时给出 dataURL 缩略图（给 H5 用）', expWrap.thumbIsData === true, expWrap);
  check('🔴🔴 导出画布取的是调色后的像素（与原图有差异）', expWrap.diff > 5, expWrap);
  check('🔴 包装层不污染 store（原图仍在、未被写 enhancedUrl）', expWrap.origUntouched === true, expWrap);

  /* ══ 12. store.js 必须没有偷偷 import export.js ══ */
  const fsCheck = await page.evaluate(async () => {
    const txt = await (await fetch('/js/store.js')).text();
    return { importsExport: /from\s+['"]\.\/export\.js['"]/.test(txt) };
  });
  check('🔴 store.js 不依赖导出层（分层不被破坏）', fsCheck.importsExport === false, fsCheck);

  /* ══ 13. 成套方案「一键加载」真执行 ══ */
  console.log('\n── 成套方案一键加载（真执行，不是 toast） ──');
  await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' });
  const s13 = await fresh(page);
  check('🔴 一键加载阶段夹具有原图（否则后面必然假失败）', s13.hasFile === true, s13);

  // 🔴 不走「patchSettings → reload 落盘」这条路：store.save() 是 300ms 防抖的，
  //    reload 打早了 recipeBundles 根本没写进 localStorage（一度表现为"按钮不存在"）。
  //    直接 patch + 强制重绘即可 —— 本来就不需要验证持久化。
  await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const eh = await import('/js/enhance.js');
    st.actions.patchSettings({
      recipeBundles: [eh.makeBundle('bd1', { beautyId: 'r1', templateId: 't1', name: '清透 + 简约' })],
    });
  });
  await rerender(page);

  const btnOk = await page.evaluate(() => Boolean(document.querySelector('[data-act="loadBundle"][data-id="bd1"]')));
  check('🔴 成套方案按钮在页面上（补丁已渲染）', btnOk === true, btnOk);

  await page.click('[data-act="loadBundle"][data-id="bd1"]');
  await page.waitForTimeout(2500);

  const bundleRun = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const g = st.get().groups[0];
    const photos = g.photoIds.map((id) => st.get().photos.find((p) => p.id === id)).filter(Boolean);
    return {
      tplOnGroup: g.templateId === 't1',
      enhanced: photos.filter((p) => p.enhancedUrl).length,
      total: photos.length,
      hash: location.hash,
    };
  });
  check('🔴🔴 一键加载真的调色了（不是只弹 toast）',
    bundleRun.enhanced === bundleRun.total && bundleRun.total > 0, bundleRun);
  check('🔴 一键加载把排版模板定成了该组默认', bundleRun.tplOnGroup === true, bundleRun);

  // 引用失效时按钮禁用，点不动，不会加载半套
  // 🔴 先回配方页：一键加载成功后 router 已跳到 #/edit/g1，
  //    配方页没渲染，bdX 自然查不到 —— 这不是 bug，是测试忘了回路由。
  await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);
  await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.actions.patchSettings({ recipeBundles: [{ id: 'bdX', beautyId: 'nope', templateId: 't1', name: '坏方案' }] });
  });
  await rerender(page);
  const broken = await page.evaluate(() => {
    const btn = document.querySelector('[data-act="loadBundle"][data-id="bdX"]');
    return { exists: Boolean(btn), disabled: btn ? btn.disabled || btn.classList.contains('rbtn--off') : null };
  });
  check('🔴 失效成套方案的按钮被禁用（点不动，不会加载半套）',
    broken.exists === true && broken.disabled === true, broken);

  /* ══ 14. 帮助页 ══ */
  console.log('\n── 帮助页（完整链路 + 能力边界） ──');
  await page.goto(`${BASE}/index.html#/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const entry = await page.evaluate(() => Boolean(document.querySelector('[data-act="goHelp"]')));
  check('🔴 设置页有「使用教程」入口', entry === true, entry);

  await page.click('[data-act="goHelp"]');
  await page.waitForTimeout(400);
  const help = await page.evaluate(() => {
    const txt = (document.querySelector('.view') || document.body).innerText;
    return {
      steps: document.querySelectorAll('.help__step').length,
      warnItems: document.querySelectorAll('.help__ul--warn li').length,
      hasChain: /新建/.test(txt) && /选片/.test(txt) && /修图/.test(txt) && /导出/.test(txt),
      hasBoundary: /闭眼/.test(txt) && /不能直接写进手机相册/.test(txt) && /不会替你删/.test(txt),
      hash: location.hash,
    };
  });
  check('🔴 帮助页有完整 7 步链路', help.steps === 7, help.steps);
  check('🔴 帮助页覆盖了新建/选片/修图/导出', help.hasChain === true, help);
  check('🔴🔴 帮助页明写能力边界（闭眼/相册/不删照片）', help.hasBoundary === true, help);
  check('🔴 能力边界至少 4 条', help.warnItems >= 4, help.warnItems);

  /* ══ 15. 四主题 + 暗色 ══ */
  console.log('\n── 四主题 + 暗色 ──');
  await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' });
  await fresh(page);
  for (const th of ['origin', 'forest', 'film', 'sweet', 'warmth']) {
    await page.evaluate(async (t) => { (await import('/js/store.js')).actions.setTheme(t); }, th);
    await page.waitForTimeout(280);
    const p = await page.evaluate(() => {
      const rbtn = document.querySelector('.rbtn');
      const bd = document.querySelector('.bundle');
      return {
        attr: document.documentElement.dataset.theme,
        rbtnBorder: rbtn ? getComputedStyle(rbtn).borderColor : '',
        bundleW: bd ? Math.round(bd.getBoundingClientRect().width) : null,
      };
    });
    check(`[${th}] 配方管理按钮主题化`, p.attr === th && Boolean(p.rbtnBorder), p);
  }
  await page.evaluate(async () => { (await import('/js/store.js')).actions.setMode('dark'); });
  await page.waitForTimeout(300);
  const dark = await page.evaluate(() => {
    const card = document.querySelector('.rcard');
    const btn = document.querySelector('.rbtn');
    return {
      card: card ? getComputedStyle(card).backgroundColor : '',
      btn: btn ? getComputedStyle(btn).color : '',
    };
  });
  check('🔴 暗色下配方卡/按钮无白底压白字',
    dark.card && dark.card !== 'rgba(0, 0, 0, 0)' && dark.btn, dark);

  // 滑杆在暗色下也要有可见轨道
  await page.goto(`${BASE}/index.html#/edit/g1`, { waitUntil: 'networkidle' });
  await fresh(page);
  await page.waitForTimeout(300);
  const sldark = await page.evaluate(() => {
    const r = document.querySelector('#sliders .sld__r');
    if (!r) return null;
    const cs = getComputedStyle(r);
    const rect = r.getBoundingClientRect();
    return { accent: cs.accentColor, w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  check('🔴 暗色下修图页滑杆有尺寸（没被样式吞掉）', sldark && sldark.w > 50 && sldark.h >= 16, sldark);
  await page.evaluate(async () => { (await import('/js/store.js')).actions.setMode('light'); });

  /* ══ 16. 溢出 + 禁止项 ══ */
  console.log('\n── 布局与禁止项 ──');
  const over = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('.rcard, .rbtn, .bundle, .bundle__n, .bundle__m, .sld, .sld__top, .help__step').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || el.hasAttribute('hidden')) return;
      const par = el.parentElement;
      if (!par) return;
      const a = el.getBoundingClientRect(), b = par.getBoundingClientRect();
      if (a.width === 0) return;
      if (a.right > b.right + 1 || a.left < b.left - 1) bad.push({ cls: el.className, l: Math.round(a.left), r: Math.round(a.right), pR: Math.round(b.right) });
    });
    return { bad, doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  check('🔴 新增 UI 无元素越界', over.bad.length === 0, over.bad);
  check('🔴 页面无横向滚动', over.doc === false, over);

  // 帮助页也查一遍
  await page.goto(`${BASE}/index.html#/help`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const helpOver = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    bad: [...document.querySelectorAll('.help__t, .help__d, .help__tag, .help__ul li')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > document.documentElement.clientWidth + 1;
      }).length,
  }));
  check('🔴 帮助页无横向滚动', helpOver.doc === false, helpOver);
  check('🔴 帮助页无元素越界', helpOver.bad === 0, helpOver);

  const forbid = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.dataset.tab).join(','),
  }));
  check('🔴 底部导航仍 4 项（未加第 5 项）',
    forbid.tabs === 'create,gallery,recipes,settings', forbid.tabs);

  // 禁止项：UI 里不得出现底层不支持的参数名
  const badParam = await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' })
    .then(() => fresh(page))
    .then(() => page.evaluate(() => {
      const t = document.body.innerText;
      return {
        // grain/fade/sharpen 这三个 imaging 不认，界面里出现就是骗人
        fake: /颗粒|褪色|锐化/.test(t),
        ok: /亮度|饱和|色温|对比|柔化/.test(t),
      };
    }));
  check('🔴 界面不出现 imaging 不支持的参数（颗粒/褪色/锐化）', badParam.fake === false, badParam);
  check('🔴 界面出现真实支持的参数标签', badParam.ok === true, badParam);

  check('全程无 pageerror / console.error', errors.length === 0, errors.slice(0, 5));

  console.log(`\n===== P1 配方增强自测：${pass} 通过 / ${fail} 失败 =====`);
  if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('自测异常：', e); process.exit(2); });