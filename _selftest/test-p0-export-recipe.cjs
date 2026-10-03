// P0 Bug 修复真跑自测：导出落点（Bug1）+ 配方 JSON 溢出（Bug2）
// 验收方式：本机 Chrome + http 服务，断言「行为」与「像素布局」，不只看有没有报错。
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

// 一条比 Bug2 描述更狠的配方：超长名字 + 5 个参数 + 自定义未知键
const RECIPES = [
  { id: 'r1', name: '我的配方 1', type: 'beauty', params: { bright: 6, soft: 0.3, warm: 8, sat: 6, contrast: 5 } },
  { id: 'r2', name: '这是一个特别特别长的配方名字用来测试换行和截断会不会溢出卡片边界啊喂', type: 'beauty',
    params: { bright: 12, soft: 0.85, warm: -20, sat: 30, contrast: 18, weirdUnknownKey: 999 } },
  { id: 't1', name: '简约纸感', type: 'template', tone: '简约' },
];

const PHOTOS = [
  { id: 'p1', cv: { sharpness: 900, over: 0.01, under: 0.01, edgeFlat: 0.1, brightness: 128, contrastStd: 65, saturation: 0.4, centerFocus: 0.7 } },
  { id: 'p2', cv: { sharpness: 800, over: 0.02, under: 0.02, edgeFlat: 0.1, brightness: 130, contrastStd: 64, saturation: 0.42, centerFocus: 0.75 } },
  { id: 'p3', cv: { sharpness: 20, over: 0.62, under: 0.05, edgeFlat: 0.81, brightness: 240, contrastStd: 20, saturation: 0.1, centerFocus: 0.15 } },
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 捕获下载：导出走 <a download>，Playwright 默认会拦下并丢弃，
  // 不接的话会静默失败 → 断言就变成在测"没报错"，而不是在测"真导出"
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ recipes, photos }) => {
    const cv = await import('/js/cv.js');
    const mk = (n) => 'data:image/svg+xml;base64,' + btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${n}"/></svg>`);
    const built = photos.map((p, i) => ({
      id: p.id, scene: 'other', cv: p.cv, thumbUrl: mk(['#456', '#789', '#abc'][i]),
      takenAt: 1758000000000 + i * 1000,
    }));
    for (const b of built) b.verdict = cv.verdict(b.cv);
    const raw = JSON.parse(localStorage.getItem('zhenxuji.state.v1') || '{}');
    raw.photos = built;
    raw.recipes = recipes;
    raw.groups = [{ id: 'g1', title: '测试相册', photoIds: built.map((b) => b.id), coverId: built[0].id }];
    raw.stories = [{
      id: 's1', title: '周末的山野', text: { cover: '周末的山野', captions: ['出发'] },
      photoIds: built.map((b) => b.id), dateText: '2026.10.01', stats: { views: 12, likes: 3, comments: 1 },
      visitors: [{ name: '小林', at: 1758001000000 }, { name: '阿May', at: 1758002000000 }],
    }];
    localStorage.setItem('zhenxuji.state.v1', JSON.stringify(raw));
  }, { recipes: RECIPES, photos: PHOTOS });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  /* ══════════ Bug2：素材配方 JSON 溢出 ══════════ */
  console.log('\n── P0-Bug2：素材配方不再吐 JSON、不溢出 ──');
  await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const r1 = await page.evaluate(() => ({
    html: document.querySelector('#view').innerHTML,
    cards: document.querySelectorAll('.rcard').length,
    tags: [...document.querySelectorAll('.rtag')].map((e) => e.textContent.trim()),
    bodyText: (document.querySelector('#view') || {}).textContent || '',
  }));
  console.log('  标签:', r1.tags.join(' / '));
  check('配方卡渲染出 rcard', r1.cards >= 2, r1.cards);
  check('🔴 页面里不再出现 JSON 字面量（无 { 与 "key":）',
    !/["']\w+["']\s*:/.test(r1.bodyText) && !/\{\s*"?\w+"?\s*:/.test(r1.bodyText),
    r1.bodyText.slice(0, 200));
  check('展示的是中文参数标签（亮度/饱和/色温…）',
    r1.tags.some((t) => t.includes('亮度')) && r1.tags.some((t) => t.includes('色温')), r1.tags);
  // 展开表里必须覆盖全部 5 个真实参数键（含被折叠掉的 soft）
  check('🔴 展开表覆盖全部真实参数（含被折叠的「柔化」）',
    await page.evaluate(async () => {
      const dl = await import('/js/recipes.js');
      return dl.paramTags({ bright: 6, soft: 0.3, warm: 8, sat: 6, contrast: 5 })
        .map((t) => t.key).join(',');
    }) === 'bright,sat,contrast,warm,soft', null);
  check('🔴 原始 JSON 不在 innerHTML 里（防"藏起来但仍在 DOM"）',
    !r1.html.includes('&quot;bright&quot;') && !r1.html.includes('"bright"'), null);

  // 🔴 真跑核心：横向溢出判定。
  //    ⚠️ 口径踩过一次坑：直接判 `el.scrollWidth > el.clientWidth` 会**误报** ——
  //    `text-overflow:ellipsis` 生效时，元素宽度已被正确裁到 292px，
  //    但 scrollWidth 依然报告原始内容宽（541），这是规范内的实现细节，不是 bug。
  //    真正该断言的是：① 元素渲染宽度不超过容器 ② 页面不产生横向滚动。
  const overflow = await page.evaluate(() => {
    const bad = [];
    const cards = [...document.querySelectorAll('.rcard')];
    for (const card of cards) {
      const cb = card.getBoundingClientRect();
      card.querySelectorAll('*').forEach((el) => {
        // ⚠️ 必须跳过不可见元素：折叠状态的 .rcard__more 及其子表，
        //    getBoundingClientRect() 全返回 0/0，不跳过就会把"全 0"误判成"越界"。
        //    （踩过一次：判据是 r.right > cb.right || r.left < cb.left，0 恰好越界。）
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || el.hasAttribute('hidden')) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;   // 未渲染，无从谈越界
        // 越出卡片内容区（留 1px 容差给边框）才算真溢出
        if (r.right > cb.right + 1 || r.left < cb.left - 1) {
          bad.push({ cls: el.className, left: Math.round(r.left), right: Math.round(r.right), cardRight: Math.round(cb.right), text: (el.textContent || '').slice(0, 30) });
        }
      });
    }
    return {
      bad,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      docSW: document.documentElement.scrollWidth,
      docCW: document.documentElement.clientWidth,
      nameW: (() => { const n = document.querySelector('.rcard__name'); return n ? Math.round(n.getBoundingClientRect().width) : null; })(),
      cardW: (() => { const c = document.querySelector('.rcard'); return c ? Math.round(c.getBoundingClientRect().width) : null; })(),
      ellipsis: (() => {
        const n = document.querySelector('.rcard__name');
        return n ? getComputedStyle(n).textOverflow === 'ellipsis' : null;
      })(),
    };
  });
  check('🔴 超长配方名被裁剪而非撑破（text-overflow=ellipsis 且宽于名字容器）',
    overflow.ellipsis === true && overflow.nameW < overflow.cardW, overflow);
  check('🔴 配方卡内无可见元素越出卡片边界', overflow.bad.length === 0, overflow.bad);
  check('🔴 页面无横向滚动（手机上不能左右拖出白边）', overflow.docOverflow === false, overflow);

  // 展开后再查一遍（折叠态通过 ≠ 展开态也通过，参数表最容易撑破）
  await page.click('.rcard');
  await page.waitForTimeout(320);
  const overflowOpen = await page.evaluate(() => {
    const bad = [];
    for (const card of document.querySelectorAll('.rcard')) {
      const cb = card.getBoundingClientRect();
      card.querySelectorAll('.rcard__more *').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || el.hasAttribute('hidden')) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.right > cb.right + 1 || r.left < cb.left - 1) {
          bad.push({ cls: el.className, left: Math.round(r.left), right: Math.round(r.right), cardRight: Math.round(cb.right) });
        }
      });
    }
    return bad;
  });
  check('🔴 展开参数表后仍无元素越出卡片边界', overflowOpen.length === 0, overflowOpen);

  // 展开交互
  const exp = await page.evaluate(() => {
    const c = document.querySelector('.rcard');
    const more = c.querySelector('.rcard__more');
    return { hasToggle: Boolean(c.querySelector('.rcard__toggle')), hidden: more ? more.hasAttribute('hidden') : null };
  });
  check('超过 4 个参数的卡片有「查看全部参数」', exp.hasToggle === true, exp);
  // 上面那次点击已把卡片展开，直接验展开态，不再重复点（点了反而会收回去）
  const exp2 = await page.evaluate(() => {
    const c = document.querySelector('.rcard');
    const more = c.querySelector('.rcard__more');
    const tg = c.querySelector('.rcard__toggle');
    const rows = [...c.querySelectorAll('.rtable tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    return { hidden: more.hasAttribute('hidden'), toggleText: tg ? tg.textContent : '', rows };
  });
  check('🔴 点击可展开参数表', exp2.hidden === false, exp2);
  check('展开后按钮文案变「收起参数」', exp2.toggleText === '收起参数', exp2.toggleText);
  check('🔴 参数表含「键 + 中文标签 + 值」，不是原始 JSON',
    exp2.rows.length > 0 && exp2.rows.some((r) => /bright\s*亮度/.test(r)), exp2.rows.slice(0, 3));
  await page.screenshot({ path: path.join(OUT, '_shot_p0_recipes.png'), fullPage: true });

  // 版式模板空态：造数据时给了 1 个模板，所以这里**另外**造一份"零模板"的空态场景
  const emptyCopy = await page.evaluate(async () => {
    const mod = await import('/js/pages.js');
    const html = mod.pageRecipes({
      state: { recipes: [{ id: 'x', name: '只有美颜配方', type: 'beauty', params: { bright: 6, soft: 0.3, warm: 8, sat: 6, contrast: 5 } }] },
    });
    const box = document.createElement('div');
    box.innerHTML = html;
    return box.textContent.replace(/\s+/g, ' ');
  });
  check('版式模板空态文案改为「暂无自定义版式模板」',
    emptyCopy.includes('暂无自定义版式模板'), emptyCopy.slice(0, 90));
  check('🔴 空态不再出现旧文案「还没有版式模板」', !emptyCopy.includes('还没有版式模板'), emptyCopy.slice(0, 90));

  /* ══════════ Bug1：导出落点 ══════════ */
  console.log('\n── P0-Bug1：导出后能看到文件去向 ──');
  await page.goto(`${BASE}/index.html#/share/s1`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const share = await page.evaluate(() => ({
    txt: (document.querySelector('#view').textContent || ''),
    hasHist: Boolean(document.querySelector('[data-act="goExportHistory"]')),
    visitors: document.querySelectorAll('.vchip').length,
    backText: [...document.querySelectorAll('[data-act="goGallery"]')].map((e) => e.textContent.trim()),
  }));
  check('🔴 按钮文案「回到作品集」已改「返回作品集」', share.backText.some((t) => t.includes('返回作品集')) && !share.backText.some((t) => t.includes('回到作品集')), share.backText);
  check('分享页有【导出历史】入口', share.hasHist === true, share.hasHist);
  check('P1 访客头像渲染（本地）', share.visitors === 2, share.visitors);

  // 真的点导出九宫格
  downloads.length = 0;
  await page.click('[data-act="expGrid"]');
  await page.waitForTimeout(1600);

  const afterExp = await page.evaluate(() => {
    const m = document.querySelector('.umodal');
    const raw = document.querySelector('#modalRoot').textContent || '';
    return {
      modal: Boolean(m),
      title: m ? (m.querySelector('.umodal__t') || {}).textContent || '' : '',
      text: raw.replace(/\s+/g, ' ').trim().slice(0, 300),
      acts: m ? [...m.querySelectorAll('[data-act]')].map((e) => e.dataset.act) : [],
      // 🔴 关键断言：不能出现谎称"已保存到相册"的话
      lies: /已保存到【?相册|已存入相册|相册 - 帧叙集/.test(raw),
    };
  });
  check('🔴 导出后弹模态弹窗（不是一闪而过的 toast）', afterExp.modal === true, afterExp.modal);
  check('弹窗标题含导出类型', afterExp.title.includes('九宫格'), afterExp.title);
  check('🔴 弹窗给出可执行动作', afterExp.acts.includes('closeExport') && afterExp.acts.includes('copyExportName') && afterExp.acts.includes('goExportHistory'), afterExp.acts);
  check('🔴 不谎称"已保存到相册"（当前环境真做不到）', afterExp.lies === false, afterExp.text);
  check('🔴 弹窗说清文件去哪了', /文件名|下载/.test(afterExp.text), afterExp.text);
  check('浏览器确实收到了下载', downloads.length >= 1, downloads);
  await page.screenshot({ path: path.join(OUT, '_shot_p0_export_modal.png') });

  // 复制文件名（clipboard 权限可能失败，必须走兜底也不能崩）
  // 🔴 选择器必须限定在**弹窗内**：分享页也有一个 [data-act="goExportHistory"] 按钮，
  //    不限定就会点到被遮罩挡住的页面上那个 → 报 "intercepts pointer events"。
  await page.click('.umodal [data-act="copyExportName"]');
  await page.waitForTimeout(500);
  const afterCopy = await page.evaluate(() => ({
    toast: (document.getElementById('toast') || {}).textContent || '',
    hasFallbackInput: Boolean(document.querySelector('input[readonly]')),
    err: null,
  }));
  check('🔴 点「复制文件名」不崩溃（clipboard 不可用时有兜底）',
    errors.length === 0, errors.slice(0, 3));
  check('复制有反馈（toast 或兜底输入框）',
    afterCopy.toast.includes('复制') || afterCopy.hasFallbackInput, afterCopy);

  await page.click('.umodal [data-act="goExportHistory"]');
  await page.waitForTimeout(700);
  const hist = await page.evaluate(() => ({
    hash: location.hash,
    title: (document.querySelector('.page-title') || {}).textContent || '',
    items: document.querySelectorAll('.exh').length,
    fn: (document.querySelector('.exh__fn') || {}).textContent || '',
    hasThumb: Boolean(document.querySelector('.exh__thumb')),
  }));
  check('🔴 跳转到导出历史页', hist.hash.includes('/exphistory') && hist.title.includes('导出历史'), hist);
  check('历史里有记录', hist.items >= 1, hist.items);
  check('记录含文件名', hist.fn.includes('帧叙集'), hist.fn);
  check('记录含缩略图', hist.hasThumb === true, hist.hasThumb);

  // 继续导出一个 H5，验证多条历史
  // 🔴 导出历史是**运行态**（刻意不持久化：缩略图 blobURL 跨会话必然失效，
  //    持久化还会往 localStorage 塞 base64 图片撑爆配额），
  //    所以这里绝不能中途 reload —— reload 就等于清空历史，测不出"可累积"。
  await page.goto(`${BASE}/index.html#/share/s1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
  await page.click('[data-act="expH5"]');
  await page.waitForTimeout(1400);
  await page.click('.umodal [data-act="goExportHistory"]');
  await page.waitForTimeout(700);
  const hist2 = await page.evaluate(() => ({
    items: document.querySelectorAll('.exh').length,
    kinds: [...document.querySelectorAll('.exh__t')].map((e) => e.textContent.trim()),
  }));
  check('🔴 导出历史可累积多条（同一次会话内）', hist2.items >= 2, hist2.items);
  console.log('  历史条目:', hist2.kinds.join(' | '));

  // 顺带把"重启清空"这条设计如实记进断言，别让它以后悄悄变
  await page.reload({ waitUntil: 'networkidle' });
  await page.goto(`${BASE}/index.html#/exphistory`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(() => document.querySelectorAll('.exh').length);
  check('导出历史为运行态（刷新后清空，属如实设计而非缺陷）',
    afterReload === 0, afterReload);

  /* ══════════ 环境文案诚实性 ══════════ */
  console.log('\n── 导出落点文案按环境区分 ──');
  const hints = await page.evaluate(async () => {
    const dl = await import('/js/exportdl.js');
    const kinds = ['native', 'ios', 'mobile', 'desktop'];
    return kinds.map((k) => {
      const h = dl.landingHint(k, '帧叙集-九宫格-test.jpg');
      return { k, ok: h.ok, where: h.where, detail: h.detail.slice(0, 40), canOpenAlbum: h.canOpenAlbum };
    });
  });
  for (const h of hints) {
    check(`[${h.k}] 文案非空且不含"相册文件夹"虚假承诺`,
      h.ok && h.where && !/相册文件夹/.test(h.detail), h);
  }
  check('🔴 四种环境文案互不完全相同（确实按环境分档）',
    new Set(hints.map((h) => h.ok + h.detail.slice(0, 12))).size >= 3, hints.map((h) => h.ok));

  /* ══════════ 四主题 + 暗色 ══════════ */
  console.log('\n── 配方页四主题 + 暗色 ──');
  await page.goto(`${BASE}/index.html#/recipes`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
  for (const th of ['origin', 'forest', 'film', 'sweet']) {
    await page.evaluate(async (t) => { (await import('/js/store.js')).actions.setTheme(t); }, th);
    await page.waitForTimeout(300);
    const p = await page.evaluate(() => {
      const card = document.querySelector('.rcard');
      const tag = document.querySelector('.rtag');
      const cs = card ? getComputedStyle(card) : null;
      const ts = tag ? getComputedStyle(tag) : null;
      return {
        attr: document.documentElement.dataset.theme,
        bg: cs ? cs.backgroundColor : '',
        border: cs ? cs.borderColor : '',
        tagBg: ts ? ts.backgroundColor : '',
      };
    });
    check(`[${th}] 配方卡有主题化底色与边框`, p.attr === th && p.bg !== 'rgba(0, 0, 0, 0)' && Boolean(p.border), p);
  }
  for (const mode of ['dark', 'light']) {
    await page.evaluate(async (m) => { (await import('/js/store.js')).actions.setMode(m); }, mode);
    await page.waitForTimeout(300);
    const d = await page.evaluate(() => ({
      mode: document.documentElement.dataset.mode,
      card: (() => { const c = document.querySelector('.rcard'); return c ? getComputedStyle(c).backgroundColor : ''; })(),
      txt: (() => { const c = document.querySelector('.rcard__name'); return c ? getComputedStyle(c).color : ''; })(),
    }));
    check(`[${mode}] 配方卡底色/文字有值（无白底压白字）`,
      d.card && d.card !== 'rgba(0, 0, 0, 0)' && d.txt, d);
  }
  await page.evaluate(async () => { (await import('/js/store.js')).actions.setMode('light'); });

  /* ══════════ 禁止项 ══════════ */
  console.log('\n── 禁止项核验 ──');
  const forbid = await page.evaluate(async () => {
    const tabs = [...document.querySelectorAll('.tab')].map((t) => t.dataset.tab);
    const src = await (await fetch('/js/pages.js')).text();
    return {
      tabs,
      // 底部导航没被动：仍是 4 个
      tabCount: tabs.length,
      // 页面里没有引入社区信息流
      hasFeed: /推荐流|广场|关注流|feedsList/.test(src),
    };
  });
  check('🔴 底部导航仍是 4 项（create/gallery/recipes/settings），未加第 5 项',
    forbid.tabCount === 4 && forbid.tabs.join(',') === 'create,gallery,recipes,settings', forbid.tabs);
  check('🔴 未引入社区信息流', forbid.hasFeed === false, forbid.hasFeed);

  check('全程无 pageerror / console.error', errors.length === 0, errors.slice(0, 5));

  console.log(`\n===== P0 自测：${pass} 通过 / ${fail} 失败 =====`);
  if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('自测异常：', e); process.exit(2); });
