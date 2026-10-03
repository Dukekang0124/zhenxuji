/**
 * 帧叙集 · 两段式真跑自测
 *
 * 第一段：浏览器内 import() 直接跑真实业务模块（多模块架构的红利）——
 *         cv 纯函数、契约校验、排序、本地文案、扫描管线。
 * 第二段：UI 流程断言 —— 真路由、真渲染、真导出，断言"行为/数值"而非"没报错"。
 *
 * 跑法（playwright 装在受管 workspace，必须带 NODE_PATH）：
 *   NODE_PATH=<受管 workspace>/node_modules node _selftest/selftest.cjs
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4188';
const ROOT = path.join(__dirname, '..');
const SHOT = path.join(ROOT, '_selftest', 'shots');

const results = [];
const sections = [];
const sec = (name) => { sections.push({ name, n: results.length }); console.log(`\n===== 分区 ${name} =====`); };
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  ← ' + JSON.stringify(detail)}`);
}

/* ==================== 合成照片生成（浏览器内） ==================== */

const MAKE_FILES = `
async function makeFiles() {
  // ⚠️ 纹理必须用**固定种子**：真实照片有丰富高频细节，纯色块会让拉普拉斯方差
  //    失真地低（实测：纯色块 30~51，带纹理 100~800）——曾因此导致"所有照片都被
  //    判成模糊废片"的假缺陷。种子固定还保证"相似对"的纹理一致，否则随机噪点
  //    会把 dhash 距离撑大，测不出相似聚类。
  let seed = 20261003;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const tex = (x, n = 900) => {
    for (let i = 0; i < n; i++) {
      x.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.5)';
      x.fillRect((rnd() * 400) | 0, (rnd() * 400) | 0, 2, 2);
    }
  };
  const mk = async (draw, name, lastModified) => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    const x = c.getContext('2d');
    x.fillStyle = '#8FA8B8'; x.fillRect(0, 0, 400, 400);
    seed = 20261003;
    draw(x);
    tex(x);               // 统一在 draw 之后叠纹理（模糊图此时 filter 仍生效 → 纹理也被糊掉）
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    return new File([blob], name, { type: 'image/jpeg', lastModified });
  };
  const D = 86400000;
  const t0 = Date.now() - 30 * D;
  const files = [];
  // 1) 清晰风景（绿植为主）— 第 1 天
  files.push(await mk(x => {
    x.fillStyle = '#3E7A4A'; x.fillRect(0, 240, 400, 160);
    x.fillStyle = '#9FD3E8'; x.fillRect(0, 0, 400, 240);
    x.fillStyle = '#FFFFFF'; x.beginPath(); x.arc(320, 80, 42, 0, 7); x.fill();
  }, 'trip_a1.jpg', t0));
  files.push(await mk(x => {
    x.fillStyle = '#356B42'; x.fillRect(0, 260, 400, 140);
    x.fillStyle = '#B4D4C8'; x.fillRect(0, 0, 400, 260);
    x.fillStyle = '#2F4A42'; x.fillRect(60, 150, 90, 110);
  }, 'trip_a2.jpg', t0 + 3600000));
  // 2) 模糊废片（同组，应被判 A 级模糊）
  //    ⚠️ 末尾**不重置** filter：纹理必须在 blur 生效期间绘制，否则纹理清晰、
  //    方差被拉高，测不出"模糊"。
  files.push(await mk(x => {
    x.filter = 'blur(9px)';
    x.fillStyle = '#3E7A4A'; x.fillRect(0, 240, 400, 160);
    x.fillStyle = '#DCE6EC'; x.fillRect(0, 0, 400, 240);
  }, 'trip_blur.jpg', t0 + 7200000));
  // 3) 过曝废片
  files.push(await mk(x => {
    x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, 400, 400);
  }, 'trip_over.jpg', t0 + 10800000));
  // 4) 相似对：构图与纹理一致、仅微差（偏移 4px / 色调 +6）→ dhash 距离小但 exactHash 不同
  files.push(await mk(x => {
    x.fillStyle = '#C8A46A'; x.fillRect(40, 40, 320, 320);
    x.fillStyle = '#8B5E3C'; x.beginPath(); x.arc(200, 200, 90, 0, 7); x.fill();
  }, 'food_1.jpg', t0 + 5 * D));
  files.push(await mk(x => {
    x.fillStyle = '#CEAC72'; x.fillRect(44, 44, 316, 316);
    x.fillStyle = '#8B5E3C'; x.beginPath(); x.arc(203, 203, 88, 0, 7); x.fill();
  }, 'food_2.jpg', t0 + 5 * D + 60000));
  // 5) 人像（肤色块，另起一天，间隔 > 36h）
  files.push(await mk(x => {
    x.fillStyle = '#F0DCC8'; x.fillRect(0, 0, 400, 400);
    x.fillStyle = '#E8C0A0'; x.beginPath(); x.arc(200, 190, 96, 0, 7); x.fill();
    x.fillStyle = '#3A2A20'; x.beginPath(); x.arc(170, 175, 11, 0, 7); x.fill();
    x.beginPath(); x.arc(230, 175, 11, 0, 7); x.fill();
  }, 'portrait_1.jpg', t0 + 20 * D));
  return files;
}
`;

/* ==================== 主流程 ==================== */

(async () => {
  if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

  // ⚠️ 环境里有 HTTP_PROXY（本机 64971），Chromium 默认会走系统代理 → 必须显式关闭，
  //    否则 127.0.0.1 的请求被代理劫持，表现为莫名其妙的 404。
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 🔴 资源加载失败（网络探测、未监端口）不是代码缺陷 —— 方案 §2.9.6 明确要求
    //    离线/弱网时静默容错，端侧 fetch 失败本就会产生这类日志。
    //    把它计入"代码有错"会让离线容错测试永远假红。
    if (/Failed to load resource|net::ERR_|ERR_UNSAFE_PORT|ERR_CONNECTION_REFUSED/i.test(t)) return;
    pageErrors.push('console: ' + t);
  });

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  /* ---------------- 第一段：契约与单元断言 ---------------- */
  sec('A. 端侧CV纯函数');

  const cv = await page.evaluate(async () => {
    const m = await import('/js/cv.js');
    // 造两块像素：清晰（棋盘，高频丰富） vs 模糊（纯色，无高频）
    const W = 64, H = 64;
    const sharp = new Uint8ClampedArray(W * H * 4);
    const blur = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = ((x + y) % 2 === 0) ? 240 : 20;   // 棋盘 = 强高频
      sharp[i] = sharp[i + 1] = sharp[i + 2] = v; sharp[i + 3] = 255;
      blur[i] = blur[i + 1] = blur[i + 2] = 128; blur[i + 3] = 255;
    }
    const over = new Uint8ClampedArray(W * H * 4).fill(255);
    const dark = new Uint8ClampedArray(W * H * 4).fill(3);
    const aSharp = m.analyze(sharp, W, H);
    const aBlur = m.analyze(blur, W, H);
    const aOver = m.analyze(over, W, H);
    const aDark = m.analyze(dark, W, H);
    return {
      sharpVar: aSharp.sharpness, blurVar: aBlur.sharpness,
      overRatio: aOver.over, darkRatio: aDark.under,
      vSharp: m.verdict(aSharp), vBlur: m.verdict(aBlur),
      vOver: m.verdict(aOver), vDark: m.verdict(aDark),
      hamSame: m.hamming(aSharp.dhash, aSharp.dhash),
      hamDiff: m.hamming(aSharp.dhash, aBlur.dhash),
      sceneA: m.classifyScene({ skinRatio: 0.4, greenRatio: 0.05, warmRatio: 0.1, saturation: 0.3, centerFocus: 0.1 }),
      sceneB: m.classifyScene({ skinRatio: 0.02, greenRatio: 0.5, warmRatio: 0.05, saturation: 0.3, centerFocus: 0.1 }),
      sceneC: m.classifyScene({ skinRatio: 0.05, greenRatio: 0.05, warmRatio: 0.4, saturation: 0.5, centerFocus: 0.2 }),
    };
  });

  check('清晰图拉普拉斯方差 >> 模糊图', cv.sharpVar > cv.blurVar * 100 + 100, cv);
  check('模糊图被判 A 级废片', cv.vBlur.level === 'A', cv.vBlur);
  check('模糊废片带可视化理由(code=blur)', cv.vBlur.reasons.some((r) => r.code === 'blur'), cv.vBlur.reasons);
  check('清晰图不判废', cv.vSharp.level === null, cv.vSharp);
  check('过曝图 over 占比 > 0.9 且判 A 级', cv.overRatio > 0.9 && cv.vOver.level === 'A', { o: cv.overRatio, v: cv.vOver.level });
  check('死黑图 under 占比 > 0.9 且判 A 级', cv.darkRatio > 0.9 && cv.vDark.level === 'A', { u: cv.darkRatio, v: cv.vDark.level });
  check('dHash 自身汉明距离 = 0', cv.hamSame === 0, cv.hamSame);
  check('dHash 差异图汉明距离 > 0', cv.hamDiff > 0, cv.hamDiff);
  check('场景分类：肤色占优 → 人像', cv.sceneA === 'portrait', cv.sceneA);
  check('场景分类：绿植占优 → 风景', cv.sceneB === 'landscape', cv.sceneB);
  check('场景分类：暖色高饱和 → 美食', cv.sceneC === 'food', cv.sceneC);

  sec('B. 契约校验与排序');

  const contract = await page.evaluate(async () => {
    const ai = await import('/js/ai.js');
    const api = await import('/js/api.js');
    const pr = await import('/js/prompts.js');
    const mk = (scene, t) => ({ id: scene + t, scene, takenAt: t, score: 50 });
    const photos = [mk('food', 3), mk('landscape', 1), mk('portrait', 2), mk('other', 4)];
    return {
      emptyShape: ai.validateShape('story', {}),
      nullShape: ai.validateShape('story', null),
      badJson: ai.safeJsonParse('{oops', 'story'),
      goodJson: ai.safeJsonParse('{"cover":"标题","captions":["a","b"],"body":"正文","hook":"问句"}', 'story'),
      truncated: ai.tolerantParse('{"cover":"标题","captions":["a"],"body":"正', 'story'),
      narrative: ai.narrativeOrder(photos).map((p) => p.scene),
      time: ai.timeOrder(photos).map((p) => p.takenAt),
      forbiddenHit: pr.findForbidden('这家绝绝子好吃').length,
      forbiddenMiss: pr.findForbidden('这家很好吃，很安静。').length,
      scrub: pr.scrubForbidden('绝绝子好吃'),
      structural: api.isStructural('provider_disabled'),
      notStructural: api.isStructural('network_timeout'),
      retryable: api.isRetryable('gateway_error'),
      notRetryable: api.isRetryable('auth_rejected'),
      // 🔴 端点不可达必须「不重试」：重试同一个不可达地址物理上不可能成功，
      //    只会把用户拿到本地文案的时间翻倍（0.6.0 首测实测 14.6s → 14.9s，最坏近 29s）。
      noRetryOnUnreachable: api.isRetryable('network_error') === false,
      // 而「对方还在想」这种可能自己好的情况，仍要保留重试
      retryOnTimeout: api.isRetryable('network_timeout') === true,
      sys: pr.SYSTEM_TEXT.includes('极简生活故事文案助手'),
    };
  });

  check('空对象补全默认值不抛错', contract.emptyShape.cover !== '' && Array.isArray(contract.emptyShape.captions), contract.emptyShape);
  check('null 输入不抛错', contract.nullShape.cover !== '', contract.nullShape);
  check('非法 JSON 兜底 ok=false', contract.badJson.ok === false, contract.badJson);
  check('合法 JSON 解析正确', contract.goodJson.ok && contract.goodJson.data.cover === '标题', contract.goodJson);
  check('截断 JSON 可修复', contract.truncated.ok === true, contract.truncated);
  check('叙事排序 = 风景→人像→细节→美食', JSON.stringify(contract.narrative) === JSON.stringify(['landscape', 'portrait', 'other', 'food']), contract.narrative);
  check('时间排序按 takenAt 升序', JSON.stringify(contract.time) === JSON.stringify([1, 2, 3, 4]), contract.time);
  check('禁词命中：绝绝子', contract.forbiddenHit > 0, contract.forbiddenHit);
  check('正常文案不误伤', contract.forbiddenMiss === 0, contract.forbiddenMiss);
  check('禁词自动改写', !contract.scrub.includes('绝绝子'), contract.scrub);
  check('结构性不可用判定正确', contract.structural === true && contract.notStructural === false, contract);
  check('错误码可重试分类正确', contract.retryable === true && contract.notRetryable === false, contract);
  check('🔴 端点不可达（network_error）不重试——重试同一地址不可能成功，只会把等待翻倍',
    contract.noRetryOnUnreachable === true, contract);
  check('对方还在想（network_timeout）仍保留重试', contract.retryOnTimeout === true, contract);
  check('GLM 系统提示词按方案定稿', contract.sys === true, contract.sys);

  /* ---------------- 第二段：扫描管线（真实业务模块） ---------------- */
  sec('C. 相册扫描管线（真实模块 import）');

  const scan = await page.evaluate(async (mkSrc) => {
    eval(mkSrc);
    const files = await makeFiles();
    const { scanFiles } = await import('/js/scan.js');
    const store = await import('/js/store.js');
    store.actions.reset();
    const res = await scanFiles(files, { existing: [], batchSize: 3, thumbSize: 96, onProgress: () => {} });
    store.actions.upsertPhotos(res.photos);
    store.actions.setGroups(res.groups);
    const byName = {};
    res.photos.forEach((p) => { byName[p.name] = p; });
    return {
      total: res.photos.length,
      failed: res.stats.failed,
      groups: res.groups.map((g) => ({ title: g.title, n: g.photoIds.length, scene: g.sceneTag })),
      blurLevel: byName['trip_blur.jpg']?.verdict?.level,
      blurReasons: (byName['trip_blur.jpg']?.verdict?.reasons || []).map((r) => r.code),
      overLevel: byName['trip_over.jpg']?.verdict?.level,
      similarFlags: [byName['food_1.jpg']?.isSimilar, byName['food_2.jpg']?.isSimilar],
      hasThumb: Boolean(byName['trip_a1.jpg']?.thumbUrl),
      scenes: {
        a1: byName['trip_a1.jpg']?.scene,
        p1: byName['portrait_1.jpg']?.scene,
        f1: byName['food_1.jpg']?.scene,
      },
    };
  }, MAKE_FILES);

  check('7 张合成照片全部扫描成功', scan.total === 7 && scan.failed === 0, scan);
  check('生成缩略图（降采样生效）', scan.hasThumb === true, scan.hasThumb);
  check('模糊图判 A 级且理由含 blur', scan.blurLevel === 'A' && scan.blurReasons.includes('blur'), scan);
  check('过曝图判 A 级', scan.overLevel === 'A', scan.overLevel);
  check('相似对被标记 B 级候选（不判废）', scan.similarFlags.every(Boolean), scan.similarFlags);
  check('场景识别：绿植→风景', scan.scenes.a1 === 'landscape', scan.scenes);
  check('场景识别：肤色→人像', scan.scenes.p1 === 'portrait', scan.scenes);
  check('场景识别：暖色→美食', scan.scenes.f1 === 'food', scan.scenes);
  check('时间聚类切出多个事件分组', scan.groups.length >= 2, scan.groups);

  /* ---------------- UI 流程断言 ---------------- */
  sec('D. UI 流程（真路由 / 真渲染）');

  await page.evaluate(() => { location.hash = '#/album'; });
  await page.waitForTimeout(300);
  // ⚠️ 类名已随分组卡改版更新：旧断言查 `.card .group`（小方图版），
  //    新结构是 `.gcard`（大封面版）。断言不跟着改就会假红——这类"测试腐烂"
  //    和代码缺陷一样危险，因为它会让人去改本来正确的页面。
  check('相册页渲染出分组卡片', (await page.locator('.gcard').count()) > 0, await page.locator('.view').innerText().catch(() => ''));
  check('分组卡封面叠加雾棕半透文字（规范六.2）',
    (await page.locator('.gcard__cover img').count()) > 0
    && (await page.locator('.gcard__veil').count()) > 0,
    await page.locator('.gcard').first().innerText().catch(() => ''));

  await page.evaluate(() => { location.hash = '#/create'; });
  await page.waitForTimeout(300);
  const createTxt = await page.locator('.view').innerText();
  check('新建页含两大入口', createTxt.includes('从手机相册批量整理') && createTxt.includes('手动选择照片'), createTxt.slice(0, 80));
  check('新建页展示隐私承诺（原图不上传）', createTxt.includes('原图不会上传'), createTxt.slice(-120));

  // 进入选片页
  const gid = await page.evaluate(async () => {
    const st = (await import('/js/store.js')).get();
    return st.groups[0].id;
  });
  await page.evaluate((id) => { location.hash = '#/pick/' + id; }, gid);
  await page.waitForTimeout(300);
  const pickTxt = await page.locator('.view').innerText();
  check('选片页展示信任文案', pickTxt.includes('最终选择权在你'), pickTxt.slice(0, 100));
  check('选片页有折叠的硬废片区', (await page.locator('#foldTrash').count()) === 1, pickTxt.slice(0, 60));

  // 展开折叠区
  await page.click('[data-act="toggleFold"]');
  await page.waitForTimeout(150);
  check('折叠区可展开', await page.locator('#foldTrash').evaluate((el) => el.classList.contains('fold--open')), '');

  // 推翻 AI 判定：点一张废片恢复
  const before = await page.evaluate(async () => {
    const st = (await import('/js/store.js')).get();
    return st.photos.filter((p) => p.verdict?.level === 'A').length;
  });
  const trashEl = page.locator('#foldTrash .ph').first();
  if (await trashEl.count()) {
    await trashEl.click();
    await page.waitForTimeout(200);
    const after = await page.evaluate(async () => {
      const st = (await import('/js/store.js')).get();
      return st.photos.filter((p) => p.userOverride === 'keep').length;
    });
    check('用户可推翻 AI 判定（废片恢复）', after >= 1, { before, after });
  } else {
    check('用户可推翻 AI 判定（废片恢复）', false, 'no trash element');
  }

  // 文案生成（后端不可达 → 本地引擎兜底，不阻塞）
  // 🔴 0.6.0 起内置了真实 Worker 地址，这条断言原先「能不能过」取决于沙箱
  //    到 workers.dev 的连通性（实测 ERR_CONNECTION_REFUSED 还要挂 14.6s 才失败，
  //    两次重试 ≈ 29s，于是只等 1200ms 的断言读到空串）。
  //    真正要守的不变量是「后端拿不到时用户照样能出文案」，所以这里用 route 把
  //    不可达**确定化**（不依赖真实网络），再断言结果 + 只打一次。
  await page.route('**/api/story', (r) => r.abort('connectionrefused'));
  await page.evaluate((id) => { location.hash = '#/compose/' + id; }, gid);
  await page.waitForTimeout(300);
  await page.click('[data-act="genText"]');
  await page.waitForTimeout(1200);
  const coverVal = await page.locator('#fCover').inputValue();
  check('🔴 后端不可达也能出文案（本地兜底，不阻塞）', coverVal.length > 0, coverVal);
  const unreachAttempts = await page.evaluate(async () => {
    const api = await import('/js/api.js');
    return api.debug().trace.filter((t) => t.code === 'network_error' && t.attempt !== undefined).map((t) => t.attempt);
  });
  check('🔴 端点不可达只打 1 次（重试同一地址零收益，只会拖长等待）',
    unreachAttempts.length === 1 && unreachAttempts[0] === 0, unreachAttempts);
  await page.unroute('**/api/story');
  const genMsg = await page.locator('#genMsg').innerText();
  // 🔴 这条断言原来写的是 `includes('本地') || includes('GLM') || includes('完成')` ——
  //    它把「GLM 出现在普通用户可见文案里」当成了可接受项，和 §J「普通用户可见区域
  //    无技术术语」自相矛盾。真机截图里的「未配置模型服务地址，使用本地文案（0ms）」
  //    就是被这条松断言放过去的。现在改成：必须是人话，且不得出现任何技术词。
  check('🔴 文案生成结果提示是用户语言（无技术词、不暴露实现细节）',
    genMsg.length > 0 && !/GLM|Worker|API|密钥|降级|llm|endpoint|json|SDK|调试|服务地址|模型|\d+ms/i.test(genMsg),
    genMsg);

  // 完成并归档
  await page.click('[data-act="finishStory"]');
  await page.waitForTimeout(500);
  const storyCount = await page.evaluate(async () => (await import('/js/store.js')).get().stories.length);
  check('完成手记并归档到作品集', storyCount === 1, storyCount);
  check('跳转到分享页', page.url().includes('#/share'), page.url());

  // 导出九宫格（不触发下载对话框崩溃即可）
  const exportOk = await page.evaluate(async () => {
    const ex = await import('/js/export.js');
    const st = (await import('/js/store.js')).get();
    const s = st.stories[0];
    const photos = s.photoIds.map((i) => st.photos.find((p) => p.id === i)).filter(Boolean);
    const c = await ex.makeNineGrid(photos, 200);
    const html = ex.buildShareHTML(s, photos);
    return { w: c.width, h: c.height, htmlLen: html.length, hasTitle: html.includes('帧叙集') };
  });
  check('九宫格画布生成（3×3 尺寸正确）', exportOk.w === exportOk.h && exportOk.w > 0, exportOk);
  check('H5 分享页生成成功', exportOk.htmlLen > 500 && exportOk.hasTitle, exportOk);

  // 作品集持久化（重载后不丢）
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const persisted = await page.evaluate(async () => {
    const st = (await import('/js/store.js')).get();
    return { stories: st.stories.length, photos: st.photos.length };
  });
  check('重启后数据不丢失（localStorage 持久化）', persisted.stories === 1 && persisted.photos === 7, persisted);

  await page.evaluate(() => { location.hash = '#/gallery'; });
  await page.waitForTimeout(300);
  check('作品集页展示已归档手记', (await page.locator('.scard').count()) > 0, '');

  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(300);
  const setTxt = await page.locator('.view').innerText();
  check('设置页含智能文案开关与缓存说明', setTxt.includes('智能文案') && setTxt.includes('不会删除你手机相册里的原图'), setTxt.slice(0, 100));

  /* ---------------- 视觉规范：计算值断言 ---------------- */
  // 🔴 视觉缺陷的最高危族是「类名/变量名写错但语法合法」——grep、语法检查、控制台
  //    全部静默通过，只有取 **计算值** 与期望值比对才能抓到。
  /* ── F/G/L 区的期望值基准：当前生效的外观（主题 + 明暗） ──
     🔴 不再写死 rgb(122,111,101) 这种常量：默认主题已从 paper 换成 origin，
        写死的结果就是「代码完全正确、断言却一片红」，逼人往错误方向改（测试腐烂）。
        断言该盯的是「界面有没有跟随主题」，而不是「是不是某个固定 hex」。 */
  const rgbOf = (hex) => {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  const curApp = await page.evaluate(async () => {
    const A = await import('/js/appearance.js');
    const st = await import('/js/store.js');
    const T = await import('/js/theme.js');
    const { theme, mode } = A.currentAppearance(st.get().settings);
    return { theme, mode, hex: T.tokens(theme, mode), meta: T.themeMeta(theme) };
  });

  sec('F. 品牌视觉规范（计算值断言）');

  // ⚠️ .card / .btn 在**首页并不存在**（首页只有 .entry / .privacy）。
  //    断言前必须先确认「该选择器在当前状态下一定存在」，否则 getComputedStyle(null)
  //    → null，整条断言假红，还会逼人往错误方向修。故这两个去设置页测。
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(320);
  const visB = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
    };
    return {
      cardBg: cs('.card', 'background-color'),
      cardRadius: cs('.card', 'border-radius'),
      cardShadow: cs('.card', 'box-shadow'),
      btnBg: cs('.btn', 'background-color'),
      btnRadius: cs('.btn', 'border-radius'),
      btnColor: cs('.btn', 'color'),
    };
  });

  await page.evaluate(() => { location.hash = '#/create'; });
  await page.waitForTimeout(320);

  const vis = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
    };
    const path = document.querySelector('.brand__mark svg path');
    return {
      bodyBg: cs('body', 'background-color'),
      cardBg: cs('.card', 'background-color'),
      cardRadius: cs('.card', 'border-radius'),
      entryRadius: cs('.entry', 'border-radius'),
      entryBg: cs('.entry', 'background-color'),
      titleWeight: cs('.page-title', 'font-weight'),
      titleColor: cs('.page-title', 'color'),
      subColor: cs('.page-sub', 'color'),
      privBg: cs('.privacy', 'background-color'),
      privRadius: cs('.privacy', 'border-radius'),
      btnBg: cs('.btn', 'background-color'),
      btnRadius: cs('.btn', 'border-radius'),
      brandColor: cs('.brand__name', 'color'),
      logoStroke: path ? getComputedStyle(path).stroke : null,
      bodyLineHeight: cs('body', 'line-height'),
      tabIconCount: document.querySelectorAll('.tab__i').length,
      entryCount: document.querySelectorAll('.entry').length,
      arrowCount: document.querySelectorAll('.entry__arrow').length,
      hasPrivacy: Boolean(document.querySelector('.privacy')),
      privacyText: (document.querySelector('.privacy__t')?.textContent || '').trim(),
      hasSlogan: Boolean(document.querySelector('.brand__slogan')),
    };
  });

  check('页面底色 = 当前主题纸底（非纯白）', vis.bodyBg === rgbOf(curApp.hex.paper), [vis.bodyBg, curApp.hex.paper]);
  check('卡片底色 = 当前主题卡白', visB.cardBg === rgbOf(curApp.hex.card), visB.cardBg);
  check('卡片圆角 = 主题圆角档位（禁止直角）', visB.cardRadius === curApp.hex.r, [visB.cardRadius, curApp.hex.r]);
  check('卡片阴影极淡（纸张轻微浮起，非厚重立体）',
    /rgba\(\d+,\s*\d+,\s*\d+,\s*0?\.\d+\)/.test(visB.cardShadow || '')
    && !/0\.[3-9]/.test(visB.cardShadow || ''), visB.cardShadow);
  check('入口大卡片圆角 = 主题圆角档位', vis.entryRadius === curApp.hex.r, vis.entryRadius);
  check('入口卡片是卡白底（纸感轻量化，非厚重填充）', vis.entryBg === rgbOf(curApp.hex.card), vis.entryBg);
  check('🔴 主标题字重跟随主题字体包（走 --font-w-title，不是写死 300）',
    Number(vis.titleWeight) === Number(curApp.hex['font-w-title']) && Number(vis.titleWeight) <= 500,
    [vis.titleWeight, curApp.hex['font-w-title']]);
  check('主标题 = 当前主题主色', vis.titleColor === rgbOf(curApp.hex.brand), [vis.titleColor, curApp.hex.brand]);
  check('副标题 = 当前主题次要文字色', vis.subColor === rgbOf(curApp.hex['ink-2']), [vis.subColor, curApp.hex['ink-2']]);
  check('隐私提示条底色 = 主题隐私条色', vis.privBg === rgbOf(curApp.hex['privacy-bg']), [vis.privBg, curApp.hex['privacy-bg']]);
  check('隐私提示条圆角 = 主题小圆角档位', vis.privRadius === curApp.hex['r-sm'], vis.privRadius);
  check('按钮卡白底 + 小圆角 + 主题主色文字（非厚重填充色块）',
    visB.btnBg === rgbOf(curApp.hex.card) && visB.btnRadius === curApp.hex['r-sm']
    && visB.btnColor === rgbOf(curApp.hex.brand), visB);
  check('品牌文字 = 当前主题主色', vis.brandColor === rgbOf(curApp.hex.brand), [vis.brandColor, curApp.hex.brand]);
  check('Logo 描边 = 当前主题主色（纤细单线）', vis.logoStroke === rgbOf(curApp.hex.brand), [vis.logoStroke, curApp.hex.brand]);
  check('正文行高 1.6（15px × 1.6 = 24px）', vis.bodyLineHeight === '24px', vis.bodyLineHeight);
  check('底部导航 4 个 Tab 且图标为线性 SVG', vis.tabIconCount === 4, vis.tabIconCount);
  check('首页两大入口卡片就位', vis.entryCount >= 2, vis.entryCount);
  check('入口卡片带引导箭头（整卡可点）', vis.arrowCount >= 2, vis.arrowCount);
  check('隐私提示条存在且文案正确',
    vis.hasPrivacy && vis.privacyText.includes('原图不会上传'), vis.privacyText);
  check('Header 含副标题（图形+文字一行，不分两行）', vis.hasSlogan === true, vis.hasSlogan);

  /* ---------------- G. 作品集封面卡 + 空状态（本轮核心改造） ---------------- */
  sec('G. 作品集封面卡与空状态引导');

  // 先看作品集（有手记）——验证封面卡
  await page.evaluate(() => { location.hash = '#/gallery'; });
  await page.waitForTimeout(360);
  const gal = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
    };
    const cover = document.querySelector('.scard__cover');
    const body = document.querySelector('.scard__body');
    const tag = document.querySelector('.scard__tag');
    const coverRect = cover ? cover.getBoundingClientRect() : null;
    const bodyRect = body ? body.getBoundingClientRect() : null;
    return {
      hasCard: Boolean(document.querySelector('.scard')),
      hasCoverImg: Boolean(document.querySelector('.scard__cover img')),
      coverAspect: coverRect ? Math.round((coverRect.width / coverRect.height) * 100) / 100 : null,
      coverRatio: coverRect && bodyRect
        ? Math.round((coverRect.height / (coverRect.height + bodyRect.height)) * 100) : null,
      coverOverflow: cover ? getComputedStyle(cover).overflow : null,
      coverRadius: cs('.scard', 'border-radius'),
      coverVignette: cover ? getComputedStyle(cover, '::after').backgroundImage : null,
      tagRadius: cs('.scard__tag', 'border-radius'),
      tagBg: cs('.scard__tag', 'background-color'),
      tagText: (document.querySelector('.scard__tag')?.textContent || '').trim(),
      tagColor: cs('.scard__tag', 'color'),
      titleColor: cs('.scard__t', 'color'),
      titleSize: cs('.scard__t', 'font-size'),
      metaText: (document.querySelector('.scard__m')?.textContent || '').trim(),
      btnCount: document.querySelectorAll('.scard__acts .btn').length,
      btnText: [...document.querySelectorAll('.scard__acts .btn')].map((b) => b.textContent.trim()),
      subText: (document.querySelector('.page-sub')?.textContent || '').trim(),
      hasLegacyCard: Boolean(document.querySelector('.card .group__t')),
    };
  });

  check('作品集渲染为手记封面卡（非旧版 .card 列表）', gal.hasCard && !gal.hasLegacyCard, gal.hasCard);
  check('卡片封面自动取到第一张照片', gal.hasCoverImg === true, gal.hasCoverImg);
  check('封面比例为 3:2（占卡高约 2/3）',
    gal.coverAspect === 1.5 && gal.coverRatio >= 55 && gal.coverRatio <= 70,
    { aspect: gal.coverAspect, coverPct: gal.coverRatio });
  check('封面圆角裁切（overflow:hidden，照片不越界）', gal.coverOverflow === 'hidden', gal.coverOverflow);
  check('封面卡片圆角 16px（禁止直角）', gal.coverRadius === '16px', gal.coverRadius);
  check('封面有轻微暗角（提升故事氛围）',
    typeof gal.coverVignette === 'string' && gal.coverVignette.includes('radial-gradient'),
    gal.coverVignette);
  // 允许 0.9~1 的半透底：压在照片上的标签需要自带透明度才在亮照片上可读，
  // 但色相必须严格是规范指定的薄荷 rgb(180,212,200)。
  const tagRGB = (gal.tagBg || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  const accentRGB = rgbOf(curApp.hex.mint).match(/\d+/g);
  check('「已归档」标签 = 当前主题辅助色（允许半透）',
    Boolean(tagRGB) && tagRGB[1] === accentRGB[0] && tagRGB[2] === accentRGB[1] && tagRGB[3] === accentRGB[2],
    [gal.tagBg, curApp.hex.mint]);
  check('归档标签圆角 = 主题小圆角 + 文案为「已归档」',
    gal.tagRadius === curApp.hex['r-sm'] && gal.tagText === '已归档', { r: gal.tagRadius, t: gal.tagText });
  check('手记标题为当前主题一级正文色（非纯黑）',
    gal.titleColor === rgbOf(curApp.hex.ink), [gal.titleColor, curApp.hex.ink]);
  check('副标题精简为「N篇手记」（删冗余 slogan）',
    /^\d+篇手记$/.test(gal.subText), gal.subText);
  check('卡片底部保留查看/分享两按钮',
    gal.btnCount === 2 && gal.btnText.join('/') === '查看/分享', gal.btnText);
  check('日期与张数信息在位', /\d{4}年/.test(gal.metaText) && /张/.test(gal.metaText), gal.metaText);

  // 排序 + 标签可辨识度（本轮看截图发现的两处问题，必须锁死）
  const order = await page.evaluate(() => {
    const tags = [...document.querySelectorAll('.scard')].map((c) => ({
      tag: c.querySelector('.scard__tag')?.textContent.trim(),
      // 标签压在照片上：自身背景必须半透（否则亮照片上消失）
      tagAlpha: (() => {
        const t = c.querySelector('.scard__tag');
        if (!t) return null;
        const m = getComputedStyle(t).backgroundColor.match(/[\d.]+/g);
        return m ? Number(m[3]) : null;
      })(),
      tagShadow: (() => {
        const t = c.querySelector('.scard__tag');
        return t ? getComputedStyle(t).boxShadow : null;
      })(),
    }));
    return { tags, firstTag: tags[0]?.tag };
  });
  check('作品集排序：已归档排在草稿之前',
    order.firstTag === '已归档', order.tags);
  check('归档标签自带半透底 + 轻投影（亮照片上也可读）',
    order.tags.every((t) => (t.tagAlpha === null || t.tagAlpha >= 0.9)
      && (t.tagShadow === null || t.tagShadow !== 'none')),
    order.tags);

  // 再看空状态：清空数据后应出现插画+引导，绝不是空洞文字
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.actions.reset();
  });
  await page.evaluate(() => { location.hash = '#/create'; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#/gallery'; });
  await page.waitForTimeout(360);
  const blank = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
    };
    const art = document.querySelector('.blank__art svg path');
    return {
      hasBlank: Boolean(document.querySelector('.blank')),
      hasArt: Boolean(document.querySelector('.blank__art svg')),
      artStroke: art ? getComputedStyle(art).stroke : null,
      artStrokeWidth: art ? getComputedStyle(art).strokeWidth : null,
      artFill: art ? getComputedStyle(art).fill : null,
      mainText: (document.querySelector('.blank__t')?.textContent || '').trim(),
      subText: (document.querySelector('.blank__d')?.textContent || '').trim(),
      align: cs('.blank', 'text-align'),
      noLegacyEmpty: !document.querySelector('.empty'),
    };
  });

  check('空状态页存在（不再是空洞一句话）', blank.hasBlank === true, blank.hasBlank);
  check('空状态含细线册页 SVG 插画', blank.hasArt === true, blank.hasArt);
  check('插画为当前主题主色单线（无填充块）',
    blank.artStroke === rgbOf(curApp.hex.brand) && blank.artFill === 'none', [blank.artStroke, curApp.hex.brand]);
  check('插画描边纤细（≤1.2px，非粗线条）',
    parseFloat(blank.artStrokeWidth) <= 1.2, blank.artStrokeWidth);
  check('空状态主文案正确', blank.mainText === '你的故事手记会在这里展示', blank.mainText);
  check('空状态引导指向底部新建', blank.subText.includes('点击底部「新建」'), blank.subText);
  check('空状态居中排布', blank.align === 'center', blank.align);
  check('旧版空洞文案已移除', blank.noLegacyEmpty === true, blank.noLegacyEmpty);

  // AI 选片页：废片标签必须是柔和浅底，不能是大红强警示
  sec('H. 废片标签柔和化（规范六.1）');
  const pickVis = await page.evaluate(async () => {
    // 复用刚才清空前的数据不现实，这里直接构造一个可判定的最小场景
    const mod = await import('/js/pages.js');
    const st = {
      photos: [
        { id: 'p1', score: 40, verdict: { level: 'A', reasons: [{ code: 'blur', label: '模糊' }] }, thumbUrl: '' },
        { id: 'p2', score: 88, verdict: { level: 'B', reasons: [] }, thumbUrl: '' },
      ],
      groups: [{ id: 'g1', title: '测试', photoIds: ['p1', 'p2'] }],
    };
    document.querySelector('.view').innerHTML = mod.pagePick({ state: st, param: 'g1' });
    const tag = document.querySelector('.ph__tag');
    const cs = tag ? getComputedStyle(tag) : null;
    return {
      tagText: (tag?.textContent || '').trim(),
      tagBg: cs ? cs.backgroundColor : null,
      tagColor: cs ? cs.color : null,
      foldText: (document.querySelector('.fold__h span')?.textContent || '').trim(),
      outline: (() => {
        const a = document.querySelector('.ph--a');
        return a ? getComputedStyle(a).outlineColor : null;
      })(),
    };
  });
  check('废片标签文案柔和化（不再写"废片"）',
    pickVis.tagText === '建议不用', pickVis.tagText);
  check('废片标签为浅色底（半透白，非大红块）',
    pickVis.tagBg === 'rgba(255, 255, 255, 0.86)' || pickVis.tagBg === 'rgb(255, 255, 255)',
    pickVis.tagBg);
  check('废片描边弱化（砖红透明度 ≤ .5）',
    /rgba\(200,\s*123,\s*110,\s*0\.\d+\)/.test(pickVis.outline || '')
    && parseFloat((pickVis.outline.match(/([\d.]+)\)$/) || [])[1] || '1') <= 0.5,
    pickVis.outline);
  check('折叠区标题同步改口径（AI 建议不用 N 张）',
    pickVis.foldText.includes('AI 建议不用'), pickVis.foldText);

  /* ---------------- I. 版本更新系统（V1.2 新增，方案 §2.9） ---------------- */
  sec('I. 版本更新系统（24h 冷却 / 双弹窗 / 静默失败）');

  const upd = await page.evaluate(async () => {
    const U = await import('/js/update.js');
    return {
      cmp: [
        U.compareVersion('0.3.1', '0.3.0'),
        U.compareVersion('0.3.0', '0.3.0'),
        U.compareVersion('0.2.9', '0.3.0'),
        U.compareVersion('1.0', '0.9.9'),
        U.compareVersion('0.3', '0.3.0'),
      ],
      hasUpd: [U.hasUpdate('0.3.0', '0.3.1'), U.hasUpdate('0.3.1', '0.3.0'), U.hasUpdate('1.0.0', '1.0.0')],
      // 冷却：24h 内应 false，超时应 true
      coolIn: U.shouldAutoPrompt({ now: 1000000, snoozeAt: 1000000 - 1000 }),
      coolOut: U.shouldAutoPrompt({ now: 1000000 + U.COOLDOWN_MS, snoozeAt: 1000000 }),
      coolNone: U.shouldAutoPrompt({ now: 1000000, snoozeAt: 0 }),
      // 🔴 强制更新不受冷却限制（被 24h 挡住等于形同虚设）
      forceIgnoresCooldown: U.shouldAutoPrompt({ now: 1000000, snoozeAt: 999999999, isForce: true }),
      // snoozeAt 必须早于 now 才是「已提醒过、还在冷却中」
      leftMs: U.cooldownLeft(1000000 + 3600000, 1000000),
      human: [U.humanizeCooldown(3600000 * 5), U.humanizeCooldown(3600000 * 50), U.humanizeCooldown(0)],
      cooldownConst: U.COOLDOWN_MS,
      // 配置归一：脏数据必须被挡掉
      norm: {
        ok: U.normalizeConfig({ latest_version: '0.3.1', is_force: false, update_content: '修了一些小问题' }),
        badVer: U.normalizeConfig({ latest_version: 'abc' }),
        noVer: U.normalizeConfig({}),
        nullIn: U.normalizeConfig(null),
        forceTruthy: U.normalizeConfig({ latest_version: '9.9.9', is_force: 'true' }),
      },
      // 技术术语清洗（方案 §2.9.5）
      jargon: U.sanitizeChangelog('修复 API 超时 500 的 crash，增加 token 缓存'),
      injection: U.sanitizeChangelog('<script>alert(1)</script> 优化体验'),
      long: U.sanitizeChangelog('长'.repeat(400)).length,
    };
  });

  check('版本比较：patch/主/次/跨位/位数不足 五种都判对',
    JSON.stringify(upd.cmp) === JSON.stringify([1, 0, -1, 1, 0]), upd.cmp);
  check('是否需要更新：三种情形都正确',
    JSON.stringify(upd.hasUpd) === JSON.stringify([true, false, false]), upd.hasUpd);
  check('冷却窗口常量 = 24 小时', upd.cooldownConst === 86400000, upd.cooldownConst);
  check('24h 内不自动弹窗（防骚扰）', upd.coolIn === false, upd.coolIn);
  check('满 24h 后恢复自动弹窗', upd.coolOut === true, upd.coolOut);
  check('无提醒记录时直接可弹', upd.coolNone === true, upd.coolNone);
  check('🔴 强制更新不受 24h 冷却限制', upd.forceIgnoresCooldown === true, upd.forceIgnoresCooldown);
  check('剩余冷却时长计算正确（1 小时前提醒过 → 还剩 23 小时）',
    upd.leftMs === 23 * 3600000, upd.leftMs);
  check('冷却时长说成人话（小时/天/空）',
    JSON.stringify(upd.human) === JSON.stringify(['5 小时', '3 天', '']), upd.human);
  check('合法配置被正常归一', upd.norm.ok && upd.norm.ok.latestVersion === '0.3.1', upd.norm.ok);
  check('非法版本号/缺失/空配置一律拒绝（不喂脏数据给 UI）',
    upd.norm.badVer === null && upd.norm.noVer === null && upd.norm.nullIn === null, upd.norm);
  check('is_force 只认布尔 true（字符串 "true" 不生效）',
    upd.norm.forceTruthy && upd.norm.forceTruthy.isForce === false, upd.norm.forceTruthy);
  // 只断言黑名单里的**词**（api/crash/token/timeout 等），不拦纯数字 ——
  // "500 错误码"这类具体数字不在方案 §2.9.5 的禁列范围内。
  check('更新文案技术术语被替换（api/crash/token/timeout）',
    !/\bapi\b|\bcrash\b|\btoken\b|\btimeout\b|\bdebug\b|\bworker\b/i.test(upd.jargon)
    && upd.jargon.includes('优化'), upd.jargon);
  check('文案里的 HTML 注入被清洗（防 XSS）',
    !upd.injection.includes('<script') && !upd.injection.includes('</script>'), upd.injection);
  check('超长文案被截断', upd.long <= 301, upd.long);

  /* ---- I2. 版本源解析 + update_url 解析（纯函数，P0-1） ----
     🔴 这一组是整个 P0-1 修复的地基：「检查更新没反应」的根因是版本源被绑在
        用户手填的地址上。源解析错了，后面所有网络断言都是假的。 */
  const updSrc = await page.evaluate(async () => {
    const U = await import('/js/update.js');
    return {
      none: U.resolveVersionSources({ origin: '', baseUrl: '' }),
      same: U.resolveVersionSources({ origin: 'https://zhenxuji.pages.dev', baseUrl: '' }),
      both: U.resolveVersionSources({ origin: 'https://zhenxuji.pages.dev', baseUrl: 'https://api.example.workers.dev' }),
      dedup: U.resolveVersionSources({ origin: 'https://a.com', baseUrl: 'https://a.com/' }),
      badOrigin: U.resolveVersionSources({ origin: 'file:///d:/x/index.html', baseUrl: '' }),
      badBase: U.resolveVersionSources({ origin: 'https://a.com', baseUrl: 'javascript:alert(1)' }),
      origin: [
        U.siteOrigin('https://a.com/x/y?z=1'),
        U.siteOrigin('http://127.0.0.1:4188'),
        U.siteOrigin('file:///d:/x/index.html'),
        U.siteOrigin(''),
        U.siteOrigin('not a url'),
      ],
      shell: [
        U.isLocalShellOrigin('https://localhost'),
        U.isLocalShellOrigin('http://localhost:8080'),
        U.isLocalShellOrigin('https://127.0.0.1'),
        U.isLocalShellOrigin('https://zhenxuji.pages.dev'),
        U.isLocalShellOrigin('https://localhost.evil.com'),
      ],
      // 🔴 APK：同源是包内自己，必须跳过、改问包外远端
      apkSources: U.resolveVersionSources({ origin: 'https://localhost', baseUrl: '', isApk: true }),
      apkWithCfg: U.resolveVersionSources({ origin: 'https://localhost', baseUrl: 'https://api.x.dev', isApk: true }),
      webOnLocalhost: U.resolveVersionSources({ origin: 'https://localhost', baseUrl: '', isApk: false }),
      builtin: U.BUILTIN_REMOTE_ORIGIN,
      up: [
        U.resolveUpdateUrl('https://cdn.x/a.apk', 'https://a.com/version.json'),
        U.resolveUpdateUrl('/apk/z.apk', 'https://a.com/version.json'),
        U.resolveUpdateUrl('/apk/z.apk', 'https://a.com/sub/version.json'),
        U.resolveUpdateUrl('//evil.com/a.apk', 'https://a.com/version.json'),
        U.resolveUpdateUrl('apk/z.apk', 'https://a.com/version.json'),
        U.resolveUpdateUrl('', 'https://a.com/version.json'),
      ],
    };
  });
  check('🔴 没填服务地址也能拿到版本源（同源就是默认源）',
    updSrc.same.length === 1 && updSrc.same[0] === 'https://zhenxuji.pages.dev/version.json', updSrc.same);
  check('填了服务地址 → 同源仍是第一优先，配置源只作兜底',
    JSON.stringify(updSrc.both) === JSON.stringify([
      'https://zhenxuji.pages.dev/version.json',
      'https://api.example.workers.dev/api/version',
      'https://api.example.workers.dev/version.json',
    ]), updSrc.both);
  check('配置地址与同源相同时去重（不对同一 URL 发两次）',
    JSON.stringify(updSrc.dedup) === JSON.stringify(['https://a.com/version.json', 'https://a.com/api/version']),
    updSrc.dedup);
  check('origin / baseUrl 都为空 → 无源可查（不硬编一个假地址）',
    updSrc.none.length === 0, updSrc.none);
  check('file:// 等非 http(s) 的 origin 被丢弃（fetch 必然失败，留着只会白等超时）',
    updSrc.badOrigin.length === 0, updSrc.badOrigin);
  check('非法 baseUrl（javascript:）被丢弃，同源源不受影响',
    updSrc.badBase.length === 1, updSrc.badBase);
  check('站点根归一：带路径/端口/非 http 都能正确取 origin',
    JSON.stringify(updSrc.origin) === JSON.stringify(['https://a.com', 'http://127.0.0.1:4188', '', '', '']),
    updSrc.origin);
  check('update_url 绝对地址直通', updSrc.up[0] === 'https://cdn.x/a.apk', updSrc.up[0]);
  check('🔴 update_url 站点根相对路径 → 用版本源自己的域名补齐',
    updSrc.up[1] === 'https://a.com/apk/z.apk' && updSrc.up[2] === 'https://a.com/apk/z.apk', updSrc.up.slice(1, 3));
  check('🔴 protocol-relative（//evil.com/…）被拒绝，绝不生成外站链接',
    updSrc.up[3] === '', updSrc.up[3]);
  check('非站点根的相对写法（apk/z.apk）被拒绝', updSrc.up[4] === '', updSrc.up[4]);
  check('空 update_url → 空（不是 undefined/相对残串）', updSrc.up[5] === '', updSrc.up[5]);
  check('APK 本地壳 origin 识别（含端口 / 含 ::1 / 反例）',
    JSON.stringify(updSrc.shell) === JSON.stringify([true, true, true, false, false]), updSrc.shell);
  check('🔴 APK 跳过包内同源，改问内置远端源（否则永远报"已是最新"）',
    JSON.stringify(updSrc.apkSources) === JSON.stringify([updSrc.builtin + '/version.json']), updSrc.apkSources);
  check('APK 下用户配置的地址仍是兜底源（排在远端源之后）',
    JSON.stringify(updSrc.apkWithCfg) === JSON.stringify([
      updSrc.builtin + '/version.json', 'https://api.x.dev/api/version', 'https://api.x.dev/version.json',
    ]), updSrc.apkWithCfg);
  check('Web 端跑在 localhost（本地开发）时仍用同源，不被 APK 规则误伤',
    JSON.stringify(updSrc.webOnLocalhost) === JSON.stringify(['https://localhost/version.json']),
    updSrc.webOnLocalhost);

  /* ---- I3. 真 route mock：同源权威 / 配置兜底 / 三分支文案 ----
     ⚠️ route 是**后注册优先**：通用规则必须先注册、具体 mock 后注册，
        否则通用规则会抢走请求。这里每个用例都只注册自己需要的具体 URL。 */
  const ALT = 'http://127.0.0.1:45998';      // 「用户在高级设置里填的服务地址」
  const ORIGIN_VJ = BASE + '/version.json';
  const ALT_API = ALT + '/api/version';
  const ALT_VJ = ALT + '/version.json';
  const mkBody = (o) => JSON.stringify({
    latest_version: '0.5.0', is_force: false, update_url: '', update_content: '一次小小的整理。', update_time: '2026-10',
    ...o,
  });
  const mock = (url, status, body) => page.route(url, (r) => r.fulfill({
    status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

  // ① 同源高版本 vs 配置源低版本 → 必须取同源（同源 = 与 App 同一次部署的发布真相）
  await mock(ORIGIN_VJ, 200, mkBody({ latest_version: '9.9.9', update_url: '/apk/z.apk' }));
  await mock(ALT_API, 200, mkBody({ latest_version: '0.0.1' }));
  await mock(ALT_VJ, 200, mkBody({ latest_version: '0.0.1' }));
  const pref = await page.evaluate(async ([alt]) => {
    const U = await import('/js/update.js');
    return U.checkUpdate({ origin: location.origin, baseUrl: alt, current: '0.5.0', manual: true });
  }, [ALT]);
  check('🔴 同源与配置源都有响应时，取同源（配置源只是兜底，不是权威）',
    pref.ok === true && pref.config.latestVersion === '9.9.9', pref.config && pref.config.latestVersion);
  check('相对 update_url 被同源域名补齐成可直接打开的地址',
    pref.config.updateUrl === BASE + '/apk/z.apk', pref.config.updateUrl);
  await page.unroute(ORIGIN_VJ); await page.unroute(ALT_API); await page.unroute(ALT_VJ);

  // ② 同源挂了（500）→ 配置源仍能兜底成功
  await mock(ORIGIN_VJ, 500, '');
  await mock(ALT_API, 200, mkBody({ latest_version: '9.9.9' }));
  const fallback = await page.evaluate(async ([alt]) => {
    const U = await import('/js/update.js');
    return U.checkUpdate({ origin: location.origin, baseUrl: alt, current: '0.5.0', manual: true });
  }, [ALT]);
  check('同源不可达时，配置的服务地址仍能查到更新（兜底源真的兜得住）',
    fallback.ok === true && fallback.needUpdate === true, fallback.code);
  await page.unroute(ORIGIN_VJ); await page.unroute(ALT_API);

  // ③ 全部失败：自动模式静默、手动模式必须给交代（方案 §2.9.4 / §2.9.6）
  await mock(ORIGIN_VJ, 500, '');
  await mock(ALT_API, 500, '');
  await mock(ALT_VJ, 500, '');
  const allFail = await page.evaluate(async ([alt]) => {
    const U = await import('/js/update.js');
    const auto = await U.checkUpdate({ origin: location.origin, baseUrl: alt, current: '0.5.0', manual: false });
    const man = await U.checkUpdate({ origin: location.origin, baseUrl: alt, current: '0.5.0', manual: true });
    return { auto, man };
  }, [ALT]);
  check('全部源失败 → 自动检测静默（一个字都不弹）',
    allFail.auto.ok === false && allFail.auto.silent === true && !allFail.auto.msg, allFail.auto.msg);
  check('🔴 全部源失败 → 手动检测文案是「网络暂时无法获取版本信息，请稍后重试」',
    allFail.man.ok === false && allFail.man.silent === false
    && allFail.man.msg === '网络暂时无法获取版本信息，请稍后重试', allFail.man.msg);
  await page.unroute(ORIGIN_VJ); await page.unroute(ALT_API); await page.unroute(ALT_VJ);

  // ④ 已是最新 → 「已是最新版本✨」；⑤ 强制但无地址 → 降级为可选
  await mock(ORIGIN_VJ, 200, mkBody({}));
  const latest = await page.evaluate(async () => {
    const U = await import('/js/update.js');
    return U.checkUpdate({ origin: location.origin, current: '0.5.0', manual: true });
  });
  check('🔴 已是最新 → 文案「已是最新版本✨」',
    latest.ok === true && latest.needUpdate === false && latest.msg === '已是最新版本✨', latest.msg);
  await page.unroute(ORIGIN_VJ);

  await mock(ORIGIN_VJ, 200, mkBody({ latest_version: '9.9.9', is_force: true, update_url: '' }));
  const forceNoUrl = await page.evaluate(async () => {
    const U = await import('/js/update.js');
    return U.checkUpdate({ origin: location.origin, current: '0.5.0', manual: true });
  });
  check('强制更新但没有下载地址 → 降级为可选（不给用户一个点不动的强制弹窗）',
    forceNoUrl.isForce === false && forceNoUrl.needUpdate === true, forceNoUrl.isForce);
  await page.unroute(ORIGIN_VJ);

  /* ---- I3b. APK 场景 A/B 对照：同源是「包内自己」vs 改问「包外远端」 ----
     🔴 这一组是本轮抓到的第二个真缺陷的证据。APK 里 origin 恒为 https://localhost，
        同源 /version.json 读的是包内自带的那一份 —— 永远等于当前版本。
        不做 A/B 对照，光看"APK 上点了没报错"是发现不了的（它就回一句「已是最新」）。 */
  const APK_ORIGIN = 'https://localhost';
  const SELF_VJ = APK_ORIGIN + '/version.json';        // 包内自带的那份（= 当前版本）
  const REMOTE_VJ = 'https://zhenxuji.pages.dev/version.json';
  await mock(SELF_VJ, 200, mkBody({}));
  await mock(REMOTE_VJ, 200, mkBody({ latest_version: '9.9.9', update_url: '/apk/zhenxuji-latest.apk' }));
  const apkAB = await page.evaluate(async ([o]) => {
    const U = await import('/js/update.js');
    const before = await U.checkUpdate({ origin: o, current: '0.5.0', manual: true, isApk: false });
    const after = await U.checkUpdate({ origin: o, current: '0.5.0', manual: true, isApk: true });
    return { before, after };
  }, [APK_ORIGIN]);
  check('🔴 A/B·修复前：APK 问包内同源 → 永远「已是最新」（更新系统形同失效）',
    apkAB.before.ok === true && apkAB.before.needUpdate === false, apkAB.before.msg);
  check('🔴 A/B·修复后：APK 问包外远端 → 真的发现 9.9.9 新版本',
    apkAB.after.ok === true && apkAB.after.needUpdate === true
    && apkAB.after.config.latestVersion === '9.9.9', apkAB.after.config && apkAB.after.config.latestVersion);
  check('APK 拿到的相对下载地址用远端域名补齐（不是 localhost）',
    apkAB.after.config.updateUrl === 'https://zhenxuji.pages.dev/apk/zhenxuji-latest.apk',
    apkAB.after.config.updateUrl);
  await page.unroute(SELF_VJ); await page.unroute(REMOTE_VJ);

  /* ---- I4. 端到端：设置页点「检查版本更新」三分支真有反馈 ----
     🔴 这组是 P0-1 的验收核心：只测模块函数不算数，必须真的点按钮、
        真的看到弹窗/提示。旧代码在这里必然失败 —— 它读的是用户手填的空地址。 */
  const clickCheck = async () => {
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      document.querySelector('[data-act="checkUpdate"]').click();
    });
    await page.waitForTimeout(900);
    return page.evaluate(() => ({
      msg: (document.getElementById('updateMsg') || {}).textContent || '',
      modal: Boolean(document.querySelector('.umodal')),
      modalTitle: (document.querySelector('.umodal__t') || {}).textContent || '',
    }));
  };

  // 分支一：有新版本 → 弹窗
  await mock(ORIGIN_VJ, 200, mkBody({ latest_version: '9.9.9', update_url: '/apk/z.apk', update_content: '主题更好看了。' }));
  const uiNew = await clickCheck();
  check('🔴 点检查更新·有新版本 → 真弹出更新弹窗',
    uiNew.modal === true, uiNew);
  check('弹窗标题含新版本语义', /新版本/.test(uiNew.modalTitle), uiNew.modalTitle);
  check('设置页就地显示「发现新版本 9.9.9」',
    /发现新版本\s*9\.9\.9/.test(uiNew.msg), uiNew.msg);
  // 🔴 回归护栏：结果文案必须扛得住「弹窗引起的整页重渲染」。
  //    旧实现是 el.textContent 直接写 DOM，setUI({updateModal}) 同步触发 render 后
  //    那行字当场变空（就是这个断言最初抓到的真缺陷）。
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.setUI({ updateModal: null });     // 关弹窗 → 再重渲染一次
  });
  await page.waitForTimeout(240);
  const msgAfterRerender = await page.evaluate(
    () => (document.getElementById('updateMsg') || {}).textContent || '');
  check('🔴 关闭弹窗（重渲染）后结果文案仍在 —— 文案走渲染，不是写死 DOM',
    /发现新版本\s*9\.9\.9/.test(msgAfterRerender), msgAfterRerender);
  await page.waitForTimeout(200);
  await page.unroute(ORIGIN_VJ);

  // 分支二：已是最新 → 轻提示
  await mock(ORIGIN_VJ, 200, mkBody({}));
  const uiLatest = await clickCheck();
  check('🔴 点检查更新·已是最新 → 「已是最新版本✨」且不弹窗',
    uiLatest.msg.includes('已是最新版本✨') && uiLatest.modal === false, uiLatest);
  await page.unroute(ORIGIN_VJ);

  // 分支三：网络异常 → 友好文案（不是生硬技术提示）
  await mock(ORIGIN_VJ, 500, '');
  const uiFail = await clickCheck();
  check('🔴 点检查更新·网络异常 → 「网络暂时无法获取版本信息，请稍后重试」',
    uiFail.msg.includes('网络暂时无法获取版本信息，请稍后重试') && uiFail.modal === false, uiFail);
  check('异常文案不含技术术语', !/HTTP|api|API|500|超时|error/i.test(uiFail.msg), uiFail.msg);
  await page.unroute(ORIGIN_VJ);

  // 清掉可能残留的 toast，别污染后续截图
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(420);

  /* ---- I5. 离线兜底：不能抛错、不能让启动挂掉 ---- */
  const updNet = await page.evaluate(async () => {
    const U = await import('/js/update.js');
    // 用 127.0.0.1:9（discard 端口）会触发浏览器 ERR_UNSAFE_PORT 警告，
    // 污染「全程无 console.error」判定；改用未监听的 45999。
    const r1 = await U.checkUpdate({ origin: '', baseUrl: 'http://127.0.0.1:45999/nope', current: '0.3.0', manual: false });
    const r2 = await U.checkUpdate({ origins: [] , sources: [], current: '0.3.0', manual: true });
    return {
      offlineOk: r1.ok === false,
      offlineSilent: r1.silent === true,
      noSourceManual: r2.ok === false && r2.silent === false && typeof r2.msg === 'string',
    };
  });
  check('离线/弱网：检测静默失败、不抛错', updNet.offlineOk && updNet.offlineSilent, updNet);
  check('手动点检查：一个源都没有也必须给交代（不能静默）', updNet.noSourceManual, updNet);

  /* ---------------- J. 设置页分层 + 技术术语隐藏（方案 §5.4） ---------------- */
  sec('J. 设置页分层与技术术语隐藏');

  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(340);
  const setLayer = await page.evaluate(() => {
    const adv = document.querySelector('#advPanel');
    // 统计「普通用户首屏可见区域」里有没有技术词
    const visible = [...document.querySelectorAll('.view h1, .view h2, .view .switch__t, .view .switch__d, .view .btn, .view .note, .view .muted')]
      .filter((el) => !el.closest('#advPanel'))
      .map((el) => el.textContent)
      .join(' | ');
    const inAdv = adv ? adv.textContent : '';
    const tech = /GLM|Worker|API|密钥|降级|llm|endpoint|json|SDK|调试/i;
    return {
      hasAdv: Boolean(adv),
      advClosed: adv ? !adv.open : null,
      hasBasicCheck: document.querySelectorAll('[data-act="checkUpdate"]').length,
      versionShown: (document.querySelector('.view')?.innerText || '').match(/当前版本\s*[\d.]+/)?.[0] || '',
      visibleText: visible,
      advText: inAdv,
      visibleHasTech: tech.test(visible),
      advHasTech: tech.test(inAdv),
      endpointInAdv: Boolean(adv && adv.querySelector('#endpoint')),
    };
  });
  check('高级设置面板存在且默认折叠', setLayer.hasAdv && setLayer.advClosed === true, setLayer);
  check('服务地址/批次数收在高级面板内', setLayer.endpointInAdv === true, setLayer.endpointInAdv);
  check('🔴 普通用户可见区域无技术术语（方案 §5.4）',
    setLayer.visibleHasTech === false, setLayer.visibleText.slice(0, 120));
  check('基础层含「检查版本更新」入口', setLayer.hasBasicCheck === 1, setLayer.hasBasicCheck);
  check('设置页展示当前版本号', /当前版本\s*[\d.]+/.test(setLayer.versionShown), setLayer.versionShown);

  // 空状态引导（方案 §5.3）
  sec('K. 空状态引导（禁止冰冷报错）');
  const emptyCheck = await page.evaluate(async () => {
    const P = await import('/js/pages.js');
    const bad = P.pagePick({ state: { photos: [], groups: [] }, param: 'nope' })
      + P.pageEdit({ state: { photos: [], groups: [], recipes: [] }, param: 'nope' })
      + P.pageCompose({ state: { photos: [], groups: [], recipes: [], stories: [] }, param: 'nope' })
      + P.pageShare({ state: { photos: [], stories: [] }, param: 'nope' })
      + P.pageDetail({ state: { photos: [], stories: [] }, param: 'nope' });
    const coldWords = /不存在|未识别出|暂未|暂无|出错|error/i;
    return {
      hasBlank: (bad.match(/class="blank"/g) || []).length,
      hasGoCreate: bad.includes('data-act="goCreate"'),
      hasCold: coldWords.test(bad),
      hasIcon: bad.includes('blank__art'),
    };
  });
  check('五个页面的空状态都用了引导组件', emptyCheck.hasBlank === 5, emptyCheck.hasBlank);
  check('空状态带册页插画 + 回首页按钮',
    emptyCheck.hasIcon && emptyCheck.hasGoCreate, emptyCheck);
  check('🔴 全站无「不存在/暂未/暂无」等冰冷报错字样',
    emptyCheck.hasCold === false, emptyCheck.hasCold);

  /* ============ V1.3 阶段0：专属图标 / 顶栏 Slogan / 导航反馈 ============ */
  sec('L. V1.3 阶段0（图标 / 顶栏 Slogan / 导航反馈）');

  /* L1. 桌面图标必须是真 PNG，且 IHDR 尺寸与 manifest 声明对得上。
        （"文件能下载"和"图标真的换了"是两件事 —— 这里直接读 PNG 头，不靠肉眼） */
  const ICON_PNG = [['/icons/icon-192.png', 192], ['/icons/icon-512.png', 512],
    ['/icons/icon-maskable-192.png', 192], ['/icons/icon-maskable-512.png', 512]];
  const iconInfo = await page.evaluate(async (list) => {
    const rd32 = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
    const out = [];
    for (const [p, want] of list) {
      const res = await fetch(p);
      const buf = new Uint8Array(await res.arrayBuffer());
      const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      out.push({
        p, want, status: res.status,
        type: (res.headers.get('content-type') || '').split(';')[0],
        w: png ? rd32(buf, 16) : -1,
      });
    }
    return out;
  }, ICON_PNG);
  iconInfo.forEach((i) => check(`图标 ${i.p} 可取且为 ${i.want}² 真 PNG`,
    i.status === 200 && i.w === i.want && i.type === 'image/png', i));

  const mfRaw = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).text());
  const mfIcons = JSON.parse(mfRaw).icons || [];
  check('manifest 声明了 maskable 用途的图标',
    mfIcons.some((i) => /maskable/.test(i.purpose || '') && /\.png$/.test(i.src)), mfIcons);
  check('manifest 已无「发布前需补 PNG」的过期批注',
    !mfRaw.includes('_iconNote'));

  /* L2. Slogan 完整且与常量同源 —— 旧病：index.html 手敲时漏了「朋友圈」三个字 */
  const slog = await page.evaluate(async () => {
    const P = await import('/js/prompts.js');
    const el = document.querySelector('.brand__slogan');
    return { dom: el ? el.textContent.trim() : null, copy: P.COPY.slogan };
  });
  check('顶栏 Slogan 为完整文案（含「朋友圈」）',
    slog.dom === '把一堆零散照片，整理成你的朋友圈生活故事', slog.dom);
  check('🔴 顶栏 Slogan 与 COPY.slogan 同源（不许两处各改各的）',
    slog.dom === slog.copy, slog);

  /* L3. 窄屏（默认视口 420 就是窄屏）不出现省略号，Slogan 整条折到第二行 */
  const measureTop = () => {
    const el = document.querySelector('.brand__slogan');
    const cs = getComputedStyle(el);
    const brand = document.querySelector('.brand').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const help = document.querySelector('.help').getBoundingClientRect();
    return {
      overflowX: el.scrollWidth - el.clientWidth,
      textOverflow: cs.textOverflow,
      wrappedToOwnLine: r.top >= brand.bottom - 1,
      barH: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
      helpRightGap: Math.round(window.innerWidth - help.right),
      sloganH: Math.round(r.height),
    };
  };
  const n420 = await page.evaluate(measureTop);
  check('窄屏 Slogan 未出现省略号截断',
    n420.textOverflow !== 'ellipsis' && n420.overflowX <= 1, n420);
  check('窄屏 Slogan 整条折到第二行独占一行', n420.wrappedToOwnLine === true, n420);
  check('Slogan 折行后顶栏高度仍克制（≤120px）', n420.barH <= 120, n420);
  check('帮助按钮仍贴最右端（缝隙 12–24px）',
    n420.helpRightGap >= 12 && n420.helpRightGap <= 24, n420.helpRightGap);

  /* L4. 宽屏必须回到同一行 —— 只有窄屏折行，别搞成永远两行 */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);
  const w1280 = await page.evaluate(measureTop);
  check('宽屏（1280）Slogan 回到与标题同一行', w1280.wrappedToOwnLine === false, w1280);
  check('宽屏 Slogan 也不截断', w1280.overflowX <= 1, w1280);
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(200);

  /* L5. 页头内联 Logo 与 icons/logo-mini.svg 必须同源（防止两处图形各走各的） */
  const logoParity = await page.evaluate(async () => {
    const inline = [...document.querySelectorAll('.brand__mark svg path')]
      .map((p) => p.getAttribute('d')).sort();
    const txt = await (await fetch('/icons/logo-mini.svg')).text();
    const file = [...txt.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).sort();
    return { inline, file, same: JSON.stringify(inline) === JSON.stringify(file) };
  });
  check('🔴 页头内联 Logo 与 icons/logo-mini.svg 路径完全一致', logoParity.same, logoParity);

  /* L6. 导航：点跳转 + 选中雾棕 / 未选浅灰棕 / 有按压反馈 */
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(360);
  const nav = await page.evaluate(() => {
    const on = document.querySelector('.tab--on');
    const off = [...document.querySelectorAll('.tab')].find((t) => !t.classList.contains('tab--on'));
    const g = (el) => (el ? getComputedStyle(el) : null);
    return {
      onTab: on ? on.dataset.tab : null,
      onColor: g(on) ? g(on).color : null,
      offTab: off ? off.dataset.tab : null,
      offColor: g(off) ? g(off).color : null,
      tabbarBg: g(document.querySelector('.tabbar')) ? g(document.querySelector('.tabbar')).backgroundColor : null,
      // 导航样式有三种：solid（rgba 底）/ gradient（渐变在 backgroundImage 里，backgroundColor 会是透明）
      // —— 所以必须两个都收，只收 backgroundColor 会把渐变主题误判成"没上色"（已踩）
      tabbarImage: g(document.querySelector('.tabbar')) ? g(document.querySelector('.tabbar')).backgroundImage : null,
      tabbarChip: g(on) ? g(on).backgroundColor : null,
      tabStroke: (() => { const i = document.querySelector('.tab__i'); return i ? getComputedStyle(i).strokeWidth : null; })(),
    };
  });
  check('选中态落在 settings Tab（点击真的跳过去了）', nav.onTab === 'settings', nav);
  // ⚠️ 不能断言「选中色 = 主色」：导航前景色由导航样式决定（磨砂深底/渐变底上
  //    主色会掉到 1.3~3.9:1），必须按 --nav-fg / --nav-fg-2 取
  check('选中态文字/图标色 = 该导航样式的前景色（--nav-fg，非写死主色）',
    nav.onColor === rgbOf(curApp.hex['nav-fg']), [nav.onColor, curApp.hex['nav-fg']]);
  check('未选中 = 该导航样式的次级前景色（--nav-fg-2）',
    nav.offColor === rgbOf(curApp.hex['nav-fg-2']), [nav.offColor, curApp.hex['nav-fg-2']]);
  // 选中态色块：渐变/磨砂导航的选中与未选中前景色相同，全靠这块底色区分
  const chipRGB = rgbOf(curApp.hex['nav-fg']).match(/\d+/g);
  const chipNums = ((nav.tabbarChip || '').match(/[\d.]+/g) || []);
  check('选中态有可感知的底色块（--nav-fg 按 --nav-chip-a 着色）',
    chipNums.length >= 4 && chipNums[0] === chipRGB[0] && chipNums[1] === chipRGB[1] && chipNums[2] === chipRGB[2]
    && parseFloat(chipNums[3]) === parseFloat(curApp.hex['nav-chip-a']),
    { chip: nav.tabbarChip, want: `rgba(${chipRGB.join(', ')}, ${curApp.hex['nav-chip-a']})` });
  // 导航底色：solid 主题看 backgroundColor，gradient 主题看 backgroundImage（两者都算「跟随主题」）
  const navNums = (nav.tabbarBg || '').match(/\d+/g) || [];
  const paperNums = curApp.hex['paper-rgb'].split(',');
  check('底部导航底色跟随主题（半透纸底 或 主题渐变）',
    (navNums.length >= 3 && navNums[0] === paperNums[0] && navNums[1] === paperNums[1] && navNums[2] === paperNums[2])
    || /gradient/.test(nav.tabbarImage || ''), { bg: nav.tabbarBg, img: nav.tabbarImage });
  check('导航图标线宽 = 主题定义的线稿风格',
    parseFloat(nav.tabStroke) === parseFloat(curApp.hex['icon-stroke']), [nav.tabStroke, curApp.hex['icon-stroke']]);

  const hasPress = await page.evaluate(() => {
    let found = false;
    const scan = (rules) => {
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes('.tab:active')) found = true;
        if (!found && r.cssRules) scan(r.cssRules);
      }
    };
    for (const s of document.styleSheets) { try { scan(s.cssRules); } catch { /* 跨域跳过 */ } }
    return found;
  });
  check('Tab 有按压反馈（.tab:active 规则存在）', hasPress === true);

  /* ============ V1.5 主题皮肤系统（四套气质 / 全局联动 / 存档兼容 / 导出联动） ============ */
  sec('M. V1.5 主题皮肤系统');

  /* M1. 先测模型再测渲染：色值表错了，后面渲染再绿也是假的 */
  const themeModel = await page.evaluate(async () => {
    const T = await import('/js/theme.js');
    const need = ['paper', 'brand', 'mint', 'ink', 'ink-2', 'line', 'card'];
    const bad = [];
    const darkBad = [];
    for (const t of T.THEMES) {
      for (const k of need) if (!t.tokens[k]) bad.push(`${t.key}.${k} 缺失`);
      for (const [k, v] of Object.entries(t.tokens)) {
        if (/^#/.test(v) && !/^#[0-9A-Fa-f]{6}$/.test(v)) bad.push(`${t.key}.${k}=${v} 非法色值`);
        if (k.endsWith('-rgb') && !/^\d{1,3},\d{1,3},\d{1,3}$/.test(v)) bad.push(`${t.key}.${k}=${v} 非法通道`);
      }
      // 明暗是每套主题**内部**的子选项（方案硬约束）：每套都必须有实质不同的暗色版，
      // 不允许「把浅色复制一份当深色」交差
      if (!t.tokensDark) { darkBad.push(`${t.key} 缺暗色版`); continue; }
      for (const k of need) if (!t.tokensDark[k]) darkBad.push(`${t.key}.dark.${k} 缺失`);
      if (t.tokensDark.paper === t.tokens.paper || t.tokensDark.ink === t.tokens.ink) darkBad.push(`${t.key} 暗色与亮色实质相同`);
    }
    return {
      keys: T.THEMES.map((t) => t.key), n: T.THEMES.length, bad, darkBad,
      groups: [...new Set(T.THEMES.map((t) => t.group || 'scene'))].sort(),
      papers: T.THEMES.map((t) => ({ key: t.key, paper: t.tokens.paper })),
      papersDark: T.THEMES.map((t) => ({ key: t.key, paper: t.tokensDark.paper })),
      def: T.DEFAULT_THEME, defMode: T.DEFAULT_MODE,
    };
  });
  const paperOf = Object.fromEntries(themeModel.papers.map((p) => [p.key, p.paper]));
  const paperOfDark = Object.fromEntries(themeModel.papersDark.map((p) => [p.key, p.paper]));
  const themeKeys = themeModel.keys;        // 8 套主题 key（按主题表顺序）
  const defaultTheme = themeModel.def;      // 不写死：默认主题是可配置项
  check('内置 8 套主题（scene 场景组 4 + classic 经典组 4），顺序稳定',
    themeModel.n === 8
    && JSON.stringify(themeModel.keys) === JSON.stringify(['origin', 'forest', 'film', 'sweet', 'paper', 'cream', 'magazine', 'retro'])
    && themeKeys.includes(defaultTheme), [themeModel.keys, defaultTheme]);
  check('两套分组都在（场景主题 / 经典主题）',
    JSON.stringify(themeModel.groups) === JSON.stringify(['classic', 'scene']), themeModel.groups);
  check('每套主题 7 个核心色齐全，且色值格式全部合法', themeModel.bad.length === 0, themeModel.bad);
  check('🔴 每套主题都有实质不同的暗色版（明暗是主题内部子选项，非并列第二套皮肤）',
    themeModel.darkBad.length === 0, themeModel.darkBad);

  /* M2. CSS 顺序闸门：主题块必须排在 :root 之后。
        两者特异性同为 (0,1,0)，只靠源码顺序取胜 —— 放前面会「主题切了但界面纹丝不动」，
        而且这种 bug 肉眼极难发现（界面本来就长那样），必须卡死在这里。 */
  const cssOrder = await page.evaluate(async () => {
    const txt = await (await fetch('/styles.css')).text();
    const iRoot = txt.indexOf('\n:root{');
    const keys = ['origin', 'forest', 'film', 'sweet', 'paper', 'cream', 'magazine', 'retro'];
    const lightIdx = keys.map((k) => txt.indexOf(`[data-theme='${k}']{`));
    const darkIdx = keys.map((k) => txt.indexOf(`[data-theme='${k}'][data-mode='dark']{`));
    return {
      iRoot,
      lightOK: lightIdx.filter((i) => i > iRoot).length,
      darkOK: darkIdx.filter((i) => i > iRoot).length,
      lightMissing: lightIdx.filter((i) => i < 0).length,
      darkMissing: darkIdx.filter((i) => i < 0).length,
    };
  });
  check('🔴 8 套浅色块 + 8 套暗色块全部排在 :root 之后（否则主题根本不生效）',
    cssOrder.iRoot > 0 && cssOrder.lightOK === 8 && cssOrder.darkOK === 8
    && cssOrder.lightMissing === 0 && cssOrder.darkMissing === 0, cssOrder);

  /* M3. 全局联动：切一套主题，页头 Logo / 底部导航 / 页面底色 / 状态栏色必须一起变 */
  // rgbOf 已在 F 区之前定义（本区原先重复定义了一份，已删）
  const probes = [];
  for (const key of ['cream', 'magazine', 'retro', 'forest', 'film', 'sweet']) {
    // 全程不 reload —— 这本身就是「即时生效」的证据
    await page.evaluate(async (k) => {
      location.hash = '#/settings';
      const st = await import('/js/store.js');
      st.actions.setTheme(k);
    }, key);
    // 🔴 必须等过 0.3s 配色过渡：body 有 transition，240ms 采样会拿到过渡中间帧
    //    （实测 magazine 拿到 rgb(48,52,49) 而终值是 rgb(47,52,49)，差 1 个色阶）
    await page.waitForTimeout(520);
    const r = await page.evaluate(async (k) => {
      const T = await import('/js/theme.js');
      const d = getComputedStyle(document.documentElement);
      const hex = (v) => v.trim().toUpperCase();
      const mark = document.querySelector('.brand__mark svg path');
      const on = document.querySelector('.tab--on');
      const tb = document.querySelector('.tabbar');
      const meta = document.querySelector('meta[name="theme-color"]');
      return {
        attr: document.documentElement.dataset.theme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        brandVar: hex(d.getPropertyValue('--brand')),
        mintVar: hex(d.getPropertyValue('--mint')),
        markStroke: mark ? getComputedStyle(mark).stroke : null,
        onTab: on ? getComputedStyle(on).color : null,
        tabbarBg: tb ? getComputedStyle(tb).backgroundColor : null,
        tabbarImage: tb ? getComputedStyle(tb).backgroundImage : null,
        tabStroke: (() => { const i = document.querySelector('.tab__i'); return i ? getComputedStyle(i).strokeWidth : null; })(),
        metaColor: meta ? meta.content : null,
        want: {
          paper: hex(T.tokens(k).paper), brand: hex(T.tokens(k).brand),
          mint: hex(T.tokens(k).mint), ink: hex(T.tokens(k).ink),
          navKind: T.tokens(k)['nav-kind'], iconStroke: T.tokens(k)['icon-stroke'],
          navFg: hex(T.tokens(k)['nav-fg']), navFg2: hex(T.tokens(k)['nav-fg-2']),
        },
      };
    }, key);
    probes.push({ key, ...r });
  }
  probes.forEach((p) => {
    const pNums = (p.tabbarBg || '').match(/\d+/g) || [];
    const wantPaper = rgbOf(p.want.paper).match(/\d+/g);
    check(`[${p.key}] data-theme 已切换`, p.attr === p.key, p.attr);
    check(`[${p.key}] 页面底色 = 主题纸底`, p.bodyBg === rgbOf(p.want.paper), p.bodyBg);
    check(`[${p.key}] 一级文字色 = 主题 ink`, p.bodyColor === rgbOf(p.want.ink), p.bodyColor);
    check(`[${p.key}] --brand / --mint 变量已覆盖`,
      p.brandVar === p.want.brand && p.mintVar === p.want.mint, [p.brandVar, p.mintVar]);
    check(`[${p.key}] 🔴 页头 Logo 线条跟随主色（currentColor 联动）`, p.markStroke === rgbOf(p.want.brand), p.markStroke);
    check(`[${p.key}] 底部导航选中色跟随主题（取导航前景色，不是页面主色）`, p.onTab === rgbOf(p.want.navFg), [p.onTab, p.want.navFg]);
    // 导航样式三态：solid=半透纸底 / gradient=渐变写在 backgroundImage / blur=半透深底
    check(`[${p.key}] 导航栏样式跟随主题（solid 半透纸底 / gradient 渐变 / blur 深底）`,
      p.want.navKind === 'gradient'
        ? /gradient/.test(p.tabbarImage || '')
        : (pNums.length >= 3 && (
          p.want.navKind === 'solid'
            ? (pNums[0] === wantPaper[0] && pNums[1] === wantPaper[1] && pNums[2] === wantPaper[2])
            : true)),
      { kind: p.want.navKind, bg: p.tabbarBg, img: (p.tabbarImage || '').slice(0, 60) });
    check(`[${p.key}] 图标线宽跟随主题线稿风格`,
      parseFloat(p.tabStroke) === parseFloat(p.want.iconStroke), [p.tabStroke, p.want.iconStroke]);
    check(`[${p.key}] PWA 状态栏色跟随主题`, p.metaColor === p.want.paper, p.metaColor);
  });

  /* M4. 持久化 + 重启记忆 */
  await page.evaluate(async () => {
    location.hash = '#/settings';
    const st = await import('/js/store.js');
    st.actions.setTheme('retro');
  });
  await page.waitForTimeout(420);   // save() 节流 300ms，等它落盘再读
  const themeSaved = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('zhenxuji.state.v1') || '{}');
    return { theme: raw.settings && raw.settings.theme, keys: Object.keys(raw.settings || {}).sort() };
  });
  check('主题已落盘 localStorage（settings.theme）', themeSaved.theme === 'retro', themeSaved);
  check('🔴 存档结构不变：老字段仍在，只是多一个 theme',
    themeSaved.keys.includes('aiTextEnabled')
    && themeSaved.keys.includes('autoDowngrade')
    && themeSaved.keys.includes('thumbSize')
    && themeSaved.keys.includes('theme'), themeSaved.keys);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const afterReload = await page.evaluate(() => (document.documentElement.dataset.theme || ''));
  check('重启后记住上次选择（仍是 retro）', afterReload === 'retro', afterReload);

  /* M5. 脏数据 / 老存档兼容 —— 升级系统最容易翻车的地方 */
  const dirty = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const T = await import('/js/theme.js');
    const k = st.actions.setTheme('nope-not-a-theme');
    return {
      k, attr: document.documentElement.dataset.theme, def: T.DEFAULT_THEME,
      norm: T.normalizeTheme('nope'), nullIn: T.normalizeTheme(null), undefIn: T.normalizeTheme(undefined),
    };
  });
  await page.waitForTimeout(420);   // 等 save 节流落盘，才能验证"脏值没被写进存档"
  const dirtySaved = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('zhenxuji.state.v1') || '{}');
    return raw.settings && raw.settings.theme;
  });
  // ⚠️ 归一目标必须读 T.DEFAULT_THEME，不能写死 —— 默认主题是可配置项
  //    （V1.5 是 paper，全界面换肤后是 origin），写死会在换默认主题时变成假红。
  check('🔴 非法主题值 → 归一为默认主题，且不让脏值写进存档',
    dirty.k === dirty.def && dirty.attr === dirty.def
    && dirty.norm === dirty.def && dirty.nullIn === dirty.def && dirty.undefIn === dirty.def
    && dirtySaved === dirty.def, { ...dirty, dirtySaved });

  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('zhenxuji.state.v1') || '{}');
    delete raw.settings.theme;              // 模拟 V1.4 及更早的存档：根本没有 theme 字段
    raw.settings.aiTextEnabled = false;
    localStorage.setItem('zhenxuji.state.v1', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const legacySave = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const T = await import('/js/theme.js');
    return {
      attr: document.documentElement.dataset.theme,
      theme: st.get().settings.theme,
      ai: st.get().settings.aiTextEnabled,
      mode: st.get().settings.mode,
      def: T.DEFAULT_THEME, defMode: T.DEFAULT_MODE,
    };
  });
  check('🔴 老存档（无 theme/mode 字段）自动回落默认主题+默认明暗，且老设置不丢',
    legacySave.attr === legacySave.def && legacySave.theme === legacySave.def
    && legacySave.ai === false
    && legacySave.mode === legacySave.defMode
    && ['light', 'dark', 'auto'].includes(legacySave.mode), legacySave);

  /* M6. 主题选择页 UI */
  // 明暗先钉到 light：色条取的是「当前实际明暗」的 token（auto 会解析成系统明暗），
  // 不钉死的话同一份代码在 CI（浅色）与本地（深色）会给出不同结果 → 假红。
  await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.actions.setMode('light');
  });
  await page.evaluate(() => { location.hash = '#/theme'; });
  await page.waitForTimeout(320);
  const themePageUI = await page.evaluate(async () => {
    const T = await import('/js/theme.js');
    const cards = [...document.querySelectorAll('.theme')];
    const on = document.querySelector('.theme--on');
    const segOn = document.querySelector('.seg__i--on');
    const first = T.THEME_KEYS[0];
    const t0 = T.tokens(first, 'light');
    const groups = [...document.querySelectorAll('h2')].map((h) => h.textContent);
    return {
      n: cards.length,
      ids: cards.map((c) => c.dataset.id),
      wantKeys: T.THEME_KEYS,
      onCount: document.querySelectorAll('.theme--on').length,
      onId: on ? on.dataset.id : null,
      onPressed: on ? on.getAttribute('aria-pressed') : null,
      checks: document.querySelectorAll('.theme__ck svg').length,
      swFirst: [...document.querySelectorAll(`.theme[data-id="${first}"] .theme__sw i`)]
        .map((i) => getComputedStyle(i).backgroundColor),
      swWantHex: [t0.paper, t0.brand, t0.mint, t0.ink],
      segCount: document.querySelectorAll('.seg__i').length,
      segOn: segOn ? segOn.dataset.id : null,
      segPressed: segOn ? segOn.getAttribute('aria-pressed') : null,
      def: T.DEFAULT_THEME,
      groups, title: (document.querySelector('.page-title') || {}).textContent,
      tech: /GLM|Worker|降级|缓存|API|token/.test(document.getElementById('view').textContent),
    };
  });
  check('主题页渲染全部 8 张主题卡（scene 4 + classic 4），顺序与主题表一致',
    themePageUI.n === 8
    && JSON.stringify(themePageUI.ids) === JSON.stringify(themePageUI.wantKeys)
    && JSON.stringify(themePageUI.ids) === JSON.stringify(['origin', 'forest', 'film', 'sweet', 'paper', 'cream', 'magazine', 'retro']),
    themePageUI.ids);
  check('主题页按分组分区（场景主题 / 经典主题 两个小标题都在）',
    themePageUI.groups.filter((g) => /主题/.test(g)).length >= 2, themePageUI.groups);
  check('当前主题有且只有一张高亮 + 勾选标记',
    themePageUI.onCount === 1 && themePageUI.onId === themePageUI.def
    && themePageUI.onPressed === 'true' && themePageUI.checks === 1, themePageUI);
  check('🔴 明暗是主题页内的三选子选项（亮色/暗色/跟随系统），当前项有高亮',
    themePageUI.segCount === 3 && ['light', 'dark', 'auto'].includes(themePageUI.segOn)
    && themePageUI.segPressed === 'true', [themePageUI.segCount, themePageUI.segOn, themePageUI.segPressed]);
  check('主题页无技术词（与设置页分层一致）', themePageUI.tech === false);
  check('🔴 主题页预览色条取自主题 token（与 CSS 同源，不另抄色值）',
    JSON.stringify(themePageUI.swFirst) === JSON.stringify(themePageUI.swWantHex.map(rgbOf)),
    { got: themePageUI.swFirst, want: themePageUI.swWantHex });

  /* M7. 真点一张卡：行为断言（不是只调 action 看返回值） */
  await page.click('.theme[data-id="magazine"]');
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(420);
  const clicked = await page.evaluate(async () => {
    const T = await import('/js/theme.js');
    return {
      attr: document.documentElement.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      wantBg: T.tokens('magazine', 'light').paper,   // 不写死 hex：色值是可配置项
      mode: document.documentElement.dataset.mode,
      onId: (document.querySelector('.theme--on') || {}).dataset ? document.querySelector('.theme--on').dataset.id : null,
      checks: document.querySelectorAll('.theme__ck svg').length,
    };
  });
  check('点主题卡 → 立刻换色、勾选跟着走（未重启、未跳页）',
    clicked.attr === 'magazine' && clicked.bodyBg === rgbOf(clicked.wantBg)
    && clicked.onId === 'magazine' && clicked.checks === 1, clicked);
  check('🔴 换主题不串明暗（明暗是主题内部子选项，不是第二套并列皮肤）',
    clicked.mode === 'light', clicked.mode);

  /* M7b. 真点「暗色」：同一套主题下底色/文字色换成暗色版，主题本身不动 */
  await page.click('.seg__i[data-id="dark"]');
  await page.waitForTimeout(520);   // body 有 0.3s 配色过渡，采样早了会拿到中间帧
  const darkOn = await page.evaluate(async () => {
    const T = await import('/js/theme.js');
    const tb = document.querySelector('.tabbar');
    return {
      mode: document.documentElement.dataset.mode,
      theme: document.documentElement.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      tabBg: tb ? getComputedStyle(tb).backgroundColor : null,
      wantBg: T.tokens('magazine', 'dark').paper,
      wantInk: T.tokens('magazine', 'dark').ink,
      wantNavBg: T.tokens('magazine', 'dark')['nav-bg'],
      lightBg: T.tokens('magazine', 'light').paper,
      segOn: (document.querySelector('.seg__i--on') || {}).dataset ? document.querySelector('.seg__i--on').dataset.id : null,
    };
  });
  // ⚠️ 归一化空白再比：token 里写 rgba(27,26,24,.94)，计算值返回 rgba(27, 26, 24, 0.94)
  const rgbaNorm = (s) => String(s).replace(/\s+/g, '').replace(/(^|[,\(])0\./, '$1.');
  check('🔴 切暗色 → 底色与一级文字色换成该主题暗色版，主题本身不变',
    darkOn.mode === 'dark' && darkOn.theme === 'magazine' && darkOn.segOn === 'dark'
    && darkOn.bodyBg === rgbOf(darkOn.wantBg) && darkOn.bodyColor === rgbOf(darkOn.wantInk)
    && darkOn.wantBg !== darkOn.lightBg, darkOn);
  // 底部导航是最容易「只跟主题、不跟明暗」的地方（fixed 层，肉眼也容易看岔）——单独立一条
  check('🔴 底部导航底色跟随明暗（暗色下不是浅色纸底）',
    rgbaNorm(darkOn.tabBg) === rgbaNorm(darkOn.wantNavBg), [darkOn.tabBg, darkOn.wantNavBg]);
  // 验完钉回亮色：后续 M9/M10 的断言与证据图都基于亮色，避免结果随系统主题漂移
  await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.actions.setMode('light');
  });
  await page.waitForTimeout(420);

  /* M8. 设置页入口 */
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(320);
  const themeEntry = await page.evaluate(async () => {
    const T = await import('/js/theme.js');
    const st = await import('/js/store.js');
    const b = document.querySelector('[data-act="goTheme"]');
    return {
      has: !!b,
      text: b ? b.textContent.replace(/\s+/g, ' ').trim() : '',
      now: T.themeName(st.get().settings.theme),   // 上一步点的是 magazine，这里必须是「杂志冷调」
    };
  });
  check('设置页有「外观主题」入口，且标出的名字 = 当前实际主题（不是写死的）',
    themeEntry.has && /外观主题/.test(themeEntry.text)
    && themeEntry.text.includes(themeEntry.now), themeEntry);

  /* M9. 导出联动：H5 分享页必须跟着「当前外观」走（主题 + 明暗都要跟） */
  const expTheme = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    const ex = await import('/js/export.js');
    const T = await import('/js/theme.js');
    const story = { text: { cover: '周末', body: '正文', hook: '', captions: ['图注'] }, dateText: '2026-10-10' };
    st.actions.setTheme('retro');
    st.actions.setMode('light');
    const html = ex.buildShareHTML(story, []);
    // 同一套主题切暗色再导一次：导出必须跟随「外观」而不是只跟随主题名
    st.actions.setMode('dark');
    const htmlDark = ex.buildShareHTML(story, []);
    st.actions.setMode('light');
    return {
      html, htmlDark, len: html.length,
      want: T.tokens('retro', 'light'), wantDark: T.tokens('retro', 'dark'),
    };
  });
  check('🔴 导出 H5 内联的是当前主题色，不是写死的雾棕',
    expTheme.html.includes(`--brand:${expTheme.want.brand}`)
    && expTheme.html.includes(`--paper:${expTheme.want.paper}`)
    && expTheme.html.includes(`--ink:${expTheme.want.ink}`), expTheme.html.slice(0, 220));
  check('🔴 导出 H5 跟随明暗：切暗色后内联的是该主题的暗色版（导出不是只认主题名）',
    expTheme.htmlDark.includes(`--brand:${expTheme.wantDark.brand}`)
    && expTheme.htmlDark.includes(`--paper:${expTheme.wantDark.paper}`)
    && expTheme.wantDark.paper !== expTheme.want.paper, expTheme.htmlDark.slice(0, 220));

  check('导出 H5 不再出现旧的雾棕/米白硬编码',
    !expTheme.html.includes('#7A6F65') && !expTheme.html.includes('#F7F4F0'), expTheme.html.slice(0, 220));
  check('导出 H5 正文/日期都读主题变量（不再写死 #4A453F/#8A8279）',
    !expTheme.html.includes('#4A453F') && !expTheme.html.includes('#8A8279') && expTheme.html.includes('color:var(--ink-2)'), '');

  // 硬编码闸门（源码级）：退回旧版这里必红。
  //  ⚠️ 必须先剥注释：注释里写「不许硬编码 #7A6F65」这句本身就会命中扫描（已踩）。
  //  ⚠️ CSS 只扫「token 表之后」的 UI 规则 —— :root 与各 [data-theme] 块本来就是
  //     色值真相源，里面出现字面量是天经地义的。
  const expSrc = fs.readFileSync(path.join(ROOT, 'js', 'export.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const leaked = ['#7A6F65', '#F7F4F0', '#8A8279', '#4A453F', '#A39C93', '#B4D4C8'].filter((c) => expSrc.includes(c));
  check('🔴 export.js 已无硬编码品牌色（导出必然跟随主题）', leaked.length === 0, leaked);

  const cssRaw = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const cssAll = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  // UI 规则区 = 主题变量层之后的一切。用生成器写的 END 哨兵定位，而不是
  // 「最后一个 [data-theme] 块」—— 后者在新增主题排到 retro 之后时会失效（哨兵不会）。
  const iEndMark = cssRaw.indexOf('<<< THEME-PACKS:END');
  let iTail = -1;
  if (iEndMark > 0) {
    const close = cssRaw.indexOf('*/', iEndMark);
    iTail = close > 0 ? cssRaw.indexOf('\n', close) : -1;
  }
  // ⚠️ 先切区再剥注释：哨兵本身是注释，若先剥注释就找不到它了
  const tail = iTail > 0 ? cssRaw.slice(iTail + 1).replace(/\/\*[\s\S]*?\*\//g, '') : '';
  // 照片叠层（压暗/暗角/照片上的标签）刻意用中性暗色：照片本身什么色都可能，
  // 跟着主题走反而会在某些照片上糊成一团 —— 这些规则从闸门里豁免。
  const OVERLAY = ['.gcard__veil', '.gcard__t', '.gcard__txt', '.scard__cover::after',
    '.scard__tag', '.ph__tag', '.scard__ph'];
  const cssUi = OVERLAY.reduce((t, s) => t.replace(new RegExp('[ \\t]*' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[^}]*\\}', 'g'), ''), tail);
  const cssLeak = ['rgba(247,244,240', 'rgba(122,111,101', 'rgba(180,212,200', 'rgba(58,56,53', '#E2DCD5']
    .filter((c) => cssUi.includes(c));
  check('styles.css 的 UI 规则已无写死的主题色（顶栏/导航/开关都走变量）',
    cssLeak.length === 0 && iTail > 0, { cssLeak, tailFrom: iTail });

  // 正向断言：关键界面面（不是全部）必须引用 CSS 变量 —— 只测颜色太容易被
  // 「换个选择器照样写死」绕过去，这里要求结构性依赖变量存在。
  const ruleBody = (sel) => {
    // 规则之间可能隔空行（\n\n.note{），所以 "行首" 要允许吞掉若干空行
    // 🔴 转义必须包含 { }：`.note{` 不转义时，`{` 会成为字面量大括号，
    //    后面正则里那个 \\{ 就变成要匹配**两个**大括号，规则体永远扑空（已踩）。
    const re = new RegExp('(?:^|\\n)[ \\t]*(?:\\n[ \\t]*)*'
      + sel.replace(/[.*+?^${}()|[\]\\{}]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}');
    const m = cssAll.match(re);
    return m ? m[1] : null;
  };
  // ⚠️ 选择器**不要带结尾的 `{`**：模式里已经写了 \\{ 去匹配大括号，
  //    选择器再带一个会被转义成大括号字面量，变成「要两个大括号」（已踩）。
  const mustVar = ['.topbar', '.tabbar', '.tab--on', '.tgl', '.toast', '.umask',
    '.help:active', '.note', '.progress', '.btn', '.entry__i',
    '.page-title', '.seg', '.seg__i', '.seg__i--on', '.theme__t'];
  const noVar = mustVar.filter((s) => { const b = ruleBody(s); return !b || !b.includes('var(--'); });
  check('🔴 顶栏/导航/开关/Toast/按钮 全部结构性依赖 CSS 变量', noVar.length === 0, noVar);

  /* M10. 截图证据：8 套主题各拍一张 + 一张暗色版
     🔴 必须**真点卡片**而不是直接调 action：action 只触发 store 订阅（换底色），
        不会重绘主题页（勾选描边要 render 才更新）—— 直接调拍出来的是「底色是 A、
        勾选停在 B」的假证据图（已踩）。
     🔴 主题证据图用**视口截图**，不用 fullPage：底部导航是 position:fixed +
        backdrop-filter，Chromium 在 fullPage（captureBeyondViewport）模式下会把它的
        底backdrop 算错 —— 实测暗色主题下拍出来的导航条是**浅色**的，而
        getComputedStyle 量到的确是暗色。即产品没问题、图是假的。导航样式本来就是
        主题的一个维度，证据图必须诚实（已踩，详见工作日志）。 */
  for (const key of themeKeys) {
    await page.evaluate(() => { location.hash = '#/theme'; });
    await page.waitForTimeout(280);
    await page.click(`.theme[data-id="${key}"]`);
    await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(460);
    // 先自证「此刻界面确实是这套主题」，再截图 —— 否则证据图可能是上一套底色（已踩）
    const shotOK = await page.evaluate((k) => ({
      on: (document.querySelector('.theme--on') || {}).dataset
        ? document.querySelector('.theme--on').dataset.id : null,
      bg: getComputedStyle(document.body).backgroundColor,
      ok: document.documentElement.dataset.theme === k,
      mode: document.documentElement.dataset.mode,
      tabBg: getComputedStyle(document.querySelector('.tabbar')).backgroundColor,
    }), key);
    check(`[${key}] 截图拍到的确实是这套主题（勾选 + 底色 + 明暗都对得上）`,
      shotOK.ok && shotOK.on === key && shotOK.mode === 'light' && shotOK.bg === rgbOf(paperOf[key]),
      shotOK);
    await page.screenshot({ path: path.join(SHOT, `theme-${key}.png`) });
  }

  // 暗色版单独留一张证据：明暗不是「滤镜」，是主题包内的第二套完整色板
  await page.evaluate(() => { location.hash = '#/theme'; });
  await page.waitForTimeout(280);
  await page.click('.theme[data-id="origin"]');
  await page.waitForTimeout(300);
  await page.click('.seg__i[data-id="dark"]');
  // 🔴 必须等 Toast 退场再截图：setMode 会弹「外观已切换为暗色」，
  //    不等就会把 toast 的中间帧拍进证据图（已踩过一整轮）。
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(520);
  const darkShot = await page.evaluate((want) => ({
    mode: document.documentElement.dataset.mode,
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    tabBg: getComputedStyle(document.querySelector('.tabbar')).backgroundColor,
    want,
  }), rgbOf(paperOfDark.origin));
  check('🔴 暗色证据图拍到的确实是暗色版（data-mode=dark 且底色 = 该主题暗色 paper）',
    darkShot.mode === 'dark' && darkShot.theme === 'origin' && darkShot.bg === darkShot.want, darkShot);
  await page.screenshot({ path: path.join(SHOT, 'theme-origin-dark.png') });

  // 收尾复位：后面 E 区之后还要拍常规证据图，必须回到默认主题 + 亮色
  await page.evaluate(async (def) => {
    const st = await import('/js/store.js');
    st.actions.setMode('light');
    st.actions.setTheme(def);
    location.hash = '#/create';
  }, defaultTheme);
  await page.waitForTimeout(400);

  /* ---------------- M2. P0-3 主题三件套：肌理 / 卡片形态 / 动效 ----------------
     🔴 为什么必须量**计算值**，而不是读配置：
        这三样都是「配置 → 生成器 → CSS 变量 → 具体规则」四级链路，任何一级断了，
        界面都只是"看着还行"，静态检查一个字都看不出来。实测踩到的两个真例：
          · 配置写 delta=0.03（听着很克制），生成器却烘了 opacity=0.5 的 multiply 噪声，
            真渲染的等效偏移是 0.31 —— 二级文字从 4.5 掉到 3.0，而当时的闸门全绿；
          · .chip 的圆角硬编码 8px，而 --r-chip 在 8 套主题里全都有值却没有任何元素读它，
            于是"换主题 chip 也跟着变"这句话是假的。
        并且一律跨三套主题对比：只有"两套主题量出来**不一样**"，才能证明它真跟着配置走，
        而不是碰巧等于某个硬编码常量（这是本区最重要的鉴别力来源）。 */
  sec('M2. P0-3 主题三件套（肌理 / 卡片形态 / 动效）');

  const packsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'theme', 'packs.json'), 'utf8'));
  const packByKey = (k) => packsJson.packs.find((p) => p.key === k);
  const easeNorm = (s) => String(s).replace(/\s+/g, '').replace(/0\./g, '.');

  /** 量三件套的计算值。临时造 .card / .chip 节点，不依赖当前页面恰好有这些元素 */
  const probeTriple = () => page.evaluate(() => {
    const mk = (cls) => { const e = document.createElement('div'); e.className = cls; document.body.appendChild(e); return e; };
    const c = mk('card'); const ch = mk('chip');
    const b = getComputedStyle(document.body);
    const v = getComputedStyle(document.getElementById('view'));
    const out = {
      tex: b.backgroundImage === 'none' ? 'none' : 'has-image',
      blend: b.backgroundBlendMode,
      size: b.backgroundSize,
      cardBorderW: getComputedStyle(c).borderTopWidth,
      cardDeco: getComputedStyle(c).backgroundImage === 'none' ? 'none' : 'has-image',
      chipR: getComputedStyle(ch).borderRadius,
      viewDur: v.animationDuration,
      // ⚠️ 属性名是 animationTimingFunction（CSS 名 animation-timing-function 的驼峰），
      //    写成 animationEase 会静默拿到 undefined → JSON 里变成 null，断言必然假红（已踩）
      viewEase: v.animationTimingFunction,
    };
    c.remove(); ch.remove();
    return out;
  });

  const setThemeKey = async (k) => {
    await page.evaluate(async (key) => {
      const st = await import('/js/store.js');
      st.actions.setTheme(key);
      st.actions.setMode('light');
    }, k);
    await page.waitForTimeout(280);
  };

  const tripleSeen = [];
  for (const key of ['origin', 'forest', 'film']) {
    const pk = packByKey(key);
    const tex = packsJson.textures[pk.texture];
    const card = packsJson.cardStyles[pk.cardStyle];
    const mo = packsJson.motions[pk.motion];
    const chipPx = `${packsJson.radiusScales[pk.radiusScale].chip}px`;
    await setThemeKey(key);
    const r = await probeTriple();
    tripleSeen.push({ key, ...r });

    const wantTex = tex.kind === 'none' ? 'none' : 'has-image';
    const wantSize = tex.kind === 'noise' ? `${tex.tile}px ${tex.tile}px` : 'auto';
    const wantDeco = card.deco === 'none' ? 'none' : 'has-image';
    check(`[${key}] 纸肌理落到 body 背景层（kind=${tex.kind} blend=${tex.blend}）`,
      r.tex === wantTex && r.blend === tex.blend && r.size === wantSize,
      { got: r, want: { tex: wantTex, blend: tex.blend, size: wantSize } });
    check(`[${key}] 卡片形态落到 .card（${card.label}：描边 ${card.borderWidth}px / 装饰 ${card.deco}）`,
      r.cardBorderW === `${card.borderWidth}px` && r.cardDeco === wantDeco,
      { got: [r.cardBorderW, r.cardDeco], want: [`${card.borderWidth}px`, wantDeco] });
    check(`[${key}] 页面进场动效跟随主题（${mo.label}：${mo.duration}）`,
      r.viewDur === mo.duration && easeNorm(r.viewEase) === easeNorm(mo.ease),
      { got: [r.viewDur, r.viewEase], want: [mo.duration, mo.ease] });
    // 🔴 chip 圆角必须等于本主题 radiusScale.chip —— 这条卡的是"token 有值但没人读"
    check(`[${key}] 🔴 .chip 圆角 = 本主题的 --r-chip（${chipPx}，不是硬编码 8px）`,
      r.chipR === chipPx, { got: r.chipR, want: chipPx });

    // 卡片形态的证据图必须拍**有 .card 的页面**（设置页）：
    // 主题页那张（theme-<key>.png）用的是 .theme 卡片，压根没有 .card，
    // 拿它当"卡片形态"的证据等于拍错了对象（这类"证据拍的不是要证的东西"最容易被忽略）。
    //
    // 🔴 还必须先绕一圈再回来（#/create → #/settings）：路由只在 hashchange 时重渲染，
    //    循环里第二次写同一个 '#/settings' 不会触发事件 → 页面停在上一次的 HTML 上，
    //    于是出现"配色已经是山野信笺、那行字却还写着 原初·清简"的**自相矛盾证据图**。
    //    （只有 html 上的 data-theme 靠 CSS 变量立刻变色，文字是渲染出来的、不会自己更新。）
    await page.evaluate(() => { location.hash = '#/create'; });
    await page.waitForTimeout(120);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForTimeout(340);
    const cardShot = await page.evaluate((k) => {
      const c = document.querySelector('.card');
      const label = document.querySelector('button.mini[data-act="goTheme"] .entry__d');
      return {
        theme: document.documentElement.dataset.theme,
        cards: document.querySelectorAll('.card').length,
        border: c ? getComputedStyle(c).borderTopWidth : null,
        deco: c ? (getComputedStyle(c).backgroundImage === 'none' ? 'none' : 'has-image') : null,
        label: label ? label.textContent : null,
        want: k,
      };
    }, key);
    check(`[${key}] 设置页卡片证据图的拍摄前提成立（页面有 .card、主题已切换）`,
      cardShot.cards > 0 && cardShot.theme === key, cardShot);
    // 证据图里的那行「当前：XX」必须真的是这套主题 —— 否则图本身就在说反话
    check(`[${key}] 🔴 证据图上的主题名与所选主题一致（页面已重渲染，不是上一轮的残留 HTML）`,
      typeof cardShot.label === 'string' && cardShot.label.includes(pk.name), cardShot.label);
    await page.screenshot({ path: path.join(SHOT, `card-form-${key}.png`) });
  }

  // 跨主题必须真的不同 —— 这一条才是"跟随配置"的鉴别力所在
  const uniq = (f) => new Set(tripleSeen.map(f)).size;
  check('🔴 三件套跨主题各不相同（换主题真的换了一套设计语言，不是同一套换色）',
    uniq((t) => t.chipR) === 3 && uniq((t) => t.viewDur) === 3 && uniq((t) => t.tex) === 2
      && uniq((t) => t.cardBorderW) === 3,
    tripleSeen.map((t) => `${t.key}:chip=${t.chipR}/dur=${t.viewDur}/tex=${t.tex}/card=${t.cardBorderW}`));

  /* 更新弹窗的落点：必须挂在 body 级 #modalRoot，**不能**拼进 #view 的 innerHTML。
     🔴 这条是 P0-3 给 .view 加进场动效时暴露的结构性问题，它有物理层面的解释：
        .view 动画期间带非 none 的 transform，而 transform 会替 position:fixed 的后代
        **造出包含块** —— 弹窗会被锚到 .view 而不是视口，那几百毫秒里遮罩只盖住 main，
        顶栏和底栏是露出来的。A/B 两半都断言：现状必须覆盖满视口；把弹窗塞回 #view
        必须复现出"盖不满"（否则说明这个断言测不出东西，等于没测）。 */
  const modalHome = await page.evaluate(() => {
    const root = document.getElementById('modalRoot');
    return {
      hasRoot: Boolean(root),
      insideView: root ? Boolean(root.closest('#view')) : null,
      parent: root && root.parentElement ? root.parentElement.tagName : null,
    };
  });
  check('🔴 更新弹窗挂在 body 级 #modalRoot（不再寄生在 #view 里）',
    modalHome.hasRoot && modalHome.insideView === false, modalHome);

  const maskCover = await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.setUI({ updateModal: { config: { latestVersion: '9.9.9', content: 'x' }, isForce: true, inApk: false } });
    // 等弹窗真的挂上：弹窗要经过 store 订阅 → render() → #modalRoot.innerHTML 才出现，
    // 不等就直接量会拿到 null，报出来是"盖不满视口"这种误导性结论（已踩）
    for (let i = 0; i < 25 && !document.querySelector('.umask'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const view = document.getElementById('view');
    // 重启动画，保证"量的时候 .view 上确实有 transform 在跑"
    view.style.animation = 'none';
    void view.offsetWidth;
    view.style.animation = '';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const running = getComputedStyle(view).transform !== 'none';
    const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top) }; };
    const mask = document.querySelector('.umask');
    const out = {
      running,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      // ⚠️ rect 是同步函数，别写成 async/await —— 之前误把 Promise 直接塞进对象，
      //    序列化出来是空对象 {}，断言拿不到任何数值只能假红（已踩）
      normal: mask ? rect(mask) : null,
      moved: null,
    };
    // A/B 的 B 半场：把遮罩挪回 #view 内部，复现旧的错误结构
    if (mask) {
      const holder = document.getElementById('view');
      const parent = mask.parentElement;
      holder.appendChild(mask);
      out.moved = rect(mask);
      parent.appendChild(mask);
    }
    return out;
  });
  /** 遮罩是否真的覆盖住了整个视口：必须同时满足「顶到 0」和「高够、宽够」。
      只看高度是不够的 —— 实测把遮罩塞回 #view 后它的高度是 1255px（等于页面内容高），
      比 900 的视口还"高"，一眼看过去像覆盖住了；真正的破绽是 **top=74**：
      顶栏那一条（0~74px）露在外面。所以判据必须是矩形覆盖，不是单看尺寸。 */
  const coversViewport = (r, vp) => Boolean(r) && r.t <= 0 && r.h >= vp.h && r.w >= vp.w;
  check('🔴 .view 进场动画跑着时，遮罩依然覆盖满视口（包含块坑的回归护栏）',
    maskCover.running && coversViewport(maskCover.normal, maskCover.viewport), maskCover);
  check('🔴 A/B 对照：把遮罩挪回 #view 内部就盖不住视口（证明这条断言有鉴别力）',
    maskCover.moved && !coversViewport(maskCover.moved, maskCover.viewport), maskCover.moved);

  await page.evaluate(async () => {
    const st = await import('/js/store.js');
    st.setUI({ updateModal: null });
  });
  await page.waitForTimeout(200);

  /* ---------------- N. 服务地址解析：零配置可用（真机反馈第二现场） ----------------
     🔴 真机截图暴露的问题：装了 APK，点「生成 AI 文案」弹的是
        「未配置模型服务地址，使用本地文案」。根因和 P0-1 的「检查更新没反应」同一个：
        产品自有的服务地址被当成了"用户必须自己填的配置项"。
          · 版本清单 → 同源 /version.json 自动拿（已修）
          · API 后端 → 必须是**内置默认地址**（本区验证）
     不测这一区的话，"内置地址"写了也白写 —— 用户端依然只有本地文案。 */
  sec('N. 服务地址解析（零配置可用）');

  const rt = await page.evaluate(async () => {
    const R = await import('/js/runtime.js');
    const A = await import('/js/api.js');
    return {
      base: [
        R.resolveApiBase({ configured: '', builtin: '' }),                          // 都没有 → 空
        R.resolveApiBase({ configured: '', builtin: 'https://api.example.dev' }),   // 只有内置
        R.resolveApiBase({ configured: 'https://mine.dev', builtin: 'https://api.example.dev' }), // 用户填的优先
        R.resolveApiBase({ configured: 'https://mine.dev/', builtin: '' }),         // 尾斜杠归一
        R.resolveApiBase({ configured: 'javascript:alert(1)', builtin: 'https://api.example.dev' }), // 非法被拒
        R.resolveApiBase({ configured: 'https://mine.dev/zxj/', builtin: '' }),     // 子路径保留
      ],
      url: [R.apiUrl('https://a.dev', '/api/story'), R.apiUrl('https://a.dev/', 'api/story'), R.apiUrl('', '/api/story')],
      decl: R.BUILTIN_API_ORIGIN,
      // 无后端时：必须静默降级（不把"服务地址"甩给用户）
      silentLocal: await A.generateStory(
        { scene: '风景', dateText: '2026年10月3日', count: 1, keywords: [], mood: '', place: '' },
        { aiTextEnabled: true },
        { apiBase: '', storyId: 'n_silent' },
      ),
      // 关掉 AI：同样静默
      offLocal: await A.generateStory(
        { scene: '风景', dateText: '2026年10月3日', count: 1, keywords: [], mood: '', place: '' },
        { aiTextEnabled: false },
        { apiBase: 'https://api.example.dev', storyId: 'n_off' },
      ),
    };
  });
  check('地址解析：两者都没有 → 空（调用方据此走本地兜底）', rt.base[0] === '', rt.base[0]);
  check('🔴 地址解析：只给内置地址 → 就用内置（用户零配置也有后端）',
    rt.base[1] === 'https://api.example.dev', rt.base[1]);
  check('地址解析：用户显式填的优先于内置（改造自测/自建后端时才生效）',
    rt.base[2] === 'https://mine.dev', rt.base[2]);
  check('地址解析：尾斜杠归一，不产生 //api/story',
    rt.base[3] === 'https://mine.dev' && rt.url[1] === 'https://a.dev/api/story', [rt.base[3], rt.url[1]]);
  check('地址解析：非法协议（javascript:）被拒，不会降级成"可用的坏地址"',
    rt.base[4] === 'https://api.example.dev', rt.base[4]);
  check('地址解析：自建代理挂在子路径下也支持',
    rt.base[5] === 'https://mine.dev/zxj', rt.base[5]);
  check('地址拼接：空 base → 空地址（而不是拼出一个相对路径去打自己）',
    rt.url[0] === 'https://a.dev/api/story' && rt.url[2] === '', rt.url);
  check('🔴 结构性问题（没后端 / 用户关了 AI）→ 静默降级，degraded 为空串',
    rt.silentLocal.degraded === '' && rt.offLocal.degraded === ''
    && rt.silentLocal.source === 'local' && rt.silentLocal.ok === true,
    [rt.silentLocal.degraded, rt.offLocal.degraded, rt.silentLocal.source]);
  check('静默降级仍然给出可用的本地文案（功能没坏，只是不是 AI 写的）',
    Boolean(rt.silentLocal.data && rt.silentLocal.data.cover), rt.silentLocal.data);
  // 内置地址当前可能尚未部署 → 这里只钉"要么空、要么合法"，填错不会静默失效。
  // 为空这件事由 build:web 的醒目警告 + 交付清单兜住（见 06-产品规划 实施记录）。
  check('内置服务地址要么为空、要么是合法 http(s) 地址（填错不会静默失效）',
    rt.decl === '' || /^https?:\/\//i.test(rt.decl), rt.decl);

  // 端到端：给一个后端地址 → 真的 POST 过去并用返回的文案（证"内置地址"这条链路是通的）
  const API_MOCK = 'https://api.example.dev/api/story';
  const E2E_TAGS = { scene: '风景', dateText: '2026年10月3日', count: 2, keywords: ['树'], mood: '', place: '' };
  let storyHit = null;
  await page.route(API_MOCK, async (route) => {
    storyHit = {
      method: route.request().method(),
      body: route.request().postDataJSON(),
      auth: route.request().headers()['authorization'] || '',
    };
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, content: '{"cover":"后端写的标题","captions":["一"],"body":"后端写的正文","hook":"后端写的钩子"}', model: 'mock', ms: 12 }),
    });
  });
  const e2e = await page.evaluate(async (tags) => {
    const A = await import('/js/api.js');
    const remote = await A.generateStory(tags, { aiTextEnabled: true }, { apiBase: 'https://api.example.dev', storyId: 'n_e2e' });
    // 同一批标签走本地兜底做对照：断言"用的是后端内容"比单看 source 更有说服力
    const local = await A.generateStory(tags, { aiTextEnabled: true }, { apiBase: '', storyId: 'n_same' });
    return { remote, localCover: local.data.cover };
  }, E2E_TAGS);
  check('🔴 给了后端地址 → 真的走网络并采用返回内容（不再永远本地兜底）',
    e2e.remote.ok === true && e2e.remote.source === 'glm'
    && e2e.remote.data.cover === '后端写的标题' && e2e.remote.data.cover !== e2e.localCover,
    [e2e.remote.source, e2e.remote.data && e2e.remote.data.cover, e2e.localCover]);
  check('成功路径不显示任何降级提示（degraded 为空）', e2e.remote.degraded === '', e2e.remote.degraded);
  check('请求打到 /api/story，POST，且**不带任何鉴权头**（密钥只在服务端）',
    Boolean(storyHit) && storyHit.method === 'POST' && storyHit.auth === '', storyHit && { m: storyHit.method, auth: storyHit.auth });
  check('只传结构化标签，**绝不传图片二进制**',
    Boolean(storyHit) && typeof storyHit.body === 'object'
    && !('image' in storyHit.body) && !('photos' in storyHit.body) && !('dataUrl' in storyHit.body),
    storyHit && Object.keys(storyHit.body || {}));
  await page.unroute(API_MOCK);

  // 后端 500 → 用用户语言提示，且不暴露错误码
  await page.route(API_MOCK, (route) => route.fulfill({ status: 500, body: 'boom' }));
  const e2eFail = await page.evaluate(async (tags) => {
    const A = await import('/js/api.js');
    return A.generateStory(tags, { aiTextEnabled: true }, { apiBase: 'https://api.example.dev', storyId: 'n_fail' });
  }, E2E_TAGS);
  check('后端异常 → 如实提示但用用户语言（无 HTTP 码、无错误码、无 ms）',
    e2eFail.source === 'local' && e2eFail.degraded.length > 0
    && !/\d{3}|gateway|error|ms|超时|服务地址/i.test(e2eFail.degraded), e2eFail.degraded);
  await page.unroute(API_MOCK);

  sec('E. 无 JS 错误');
  check('全程无 pageerror / console.error', pageErrors.length === 0, pageErrors.slice(0, 5));

  /* ---------------- 截图证据 ---------------- */
  // 🔴 顺序陷阱：G 区为了验证空状态调了 store.actions.reset()，数据已被清空。
  //    若直接在此截图，拍到的全是空页面 —— 断言能过但证据图是废的（已踩）。
  //    故：先重建完整数据，拍有内容的页面，最后再清库拍空状态。
  const mkSrcBackup = MAKE_FILES;
  // H 区为测量 CSS 曾直接把 .view 换成手写 HTML，故先整页重载，
  // 让 app.js 的真实渲染重新接管，避免残留 DOM 混进截图。
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.evaluate(async (src) => {
    eval(src);
    const files = await makeFiles();
    const { scanFiles } = await import('/js/scan.js');
    const store = await import('/js/store.js');
    const res = await scanFiles(files, { existing: [], batchSize: 3, thumbSize: 96, onProgress: () => {} });
    store.actions.upsertPhotos(res.photos);
    store.actions.setGroups(res.groups);
    // 造一篇已归档手记 + 一篇草稿，覆盖封面卡两种标签态
    const gid = res.groups[0].id;
    store.actions.upsertStory({
      id: 'st_shot1', groupId: gid, photoIds: res.groups[0].photoIds,
      title: '没什么大事', dateText: '2026年9月3日', createdAt: Date.now() - 86400000,
      text: { cover: '没什么大事', body: '正文', hook: '钩子' },
      publishedAt: Date.now(), stats: {},
    });
    store.actions.upsertStory({
      id: 'st_shot2', groupId: res.groups[1]?.id || gid, photoIds: res.groups[1]?.photoIds || [],
      title: '还没做完', dateText: '2026年9月8日', createdAt: Date.now(),
      text: { cover: '还没做完' }, publishedAt: null, stats: {},
    });
  }, mkSrcBackup);
  await page.waitForTimeout(300);

  for (const [name, hash] of [['create', '#/create'], ['album', '#/album'], ['pick', '#/pick/' + gid], ['gallery', '#/gallery'], ['settings', '#/settings']]) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(460);
    await page.screenshot({ path: path.join(SHOT, `${name}.png`), fullPage: true });
  }

  // 空状态单独拍：清库后重进作品集
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.actions.reset();
  });
  await page.evaluate(() => { location.hash = '#/create'; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#/gallery'; });
  await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT, 'gallery-empty.png'), fullPage: true });

  // V1.2 新增：更新弹窗（可选态）+ 强制态 + 更新日志页
  const modalShots = {};
  for (const [name, force] of [['update-modal', false], ['update-force', true]]) {
    await page.evaluate(async (isForce) => {
      const store = await import('/js/store.js');
      store.setUI({
        updateModal: {
          isForce,
          inApk: false,
          config: {
            latestVersion: '0.3.1',
            updateTime: '2026-10',
            content: '这次主要是修了一些小问题，让用起来更顺手。',
          },
        },
      });
    }, force);
    await page.waitForFunction(() => !document.querySelector('.toast.toast--on'), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(460);
    modalShots[name] = await page.evaluate(() => {
      const m = document.querySelector('.umodal');
      return {
        title: (m && m.querySelector('.umodal__t') || {}).textContent || '',
        acts: [...document.querySelectorAll('.umodal__acts .btn')].map((b) => b.textContent),
      };
    });
    await page.screenshot({ path: path.join(SHOT, `${name}.png`), fullPage: false });
  }
  // 🔴 证据图护栏：本组两张图曾**字节完全相同**（md5 一致）——「强制更新」那张其实是
  //    可选态的照片。根因是弹窗订阅的 key 只记"开/关"，从可选切强制不触发重渲染。
  //    断言两只弹窗的标题与按钮集真的不同，杜绝"照片是假的还以为验过了"。
  check('🔴 可选弹窗与强制弹窗内容真的不同（否则证据图是同一张）',
    modalShots['update-modal'].title !== modalShots['update-force'].title
    && modalShots['update-modal'].acts.join('|') !== modalShots['update-force'].acts.join('|'),
    modalShots);
  check('强制弹窗不含「稍后提醒」（强制更新不该给逃避出口）',
    !modalShots['update-force'].acts.some((t) => t.includes('稍后提醒')), modalShots['update-force'].acts);
  check('可选弹窗含「稍后提醒」', 
    modalShots['update-modal'].acts.some((t) => t.includes('稍后提醒')), modalShots['update-modal'].acts);
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    store.setUI({
      updateModal: null,
      updateInfo: { isForce: false, config: { latestVersion: '0.3.1', updateTime: '2026-10', content: '这次主要是修了一些小问题，让用起来更顺手。' } },
    });
  });
  await page.evaluate(() => { location.hash = '#/changelog'; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT, 'changelog.png'), fullPage: true });

  await browser.close();

  /* ---------------- 汇总 ---------------- */
  const pass = results.filter((r) => r.ok).length;
  console.log('\n==== 分区条数 ====');
  sections.forEach((s, i) => {
    const n = (i + 1 < sections.length ? sections[i + 1].n : results.length) - s.n;
    console.log(`  ${String(s.name).padEnd(30)} ${String(n).padStart(4)}`);
  });
  console.log(`\n==== 结果：${pass}/${results.length} 通过 ====`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  ✗ ${f.name} ← ${JSON.stringify(f.detail)}`));
    process.exit(1);
  }
})().catch((e) => { console.error('[selftest] crashed:', e); process.exit(1); });
