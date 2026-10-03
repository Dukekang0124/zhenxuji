/**
 * check-texture-render.cjs — 纸肌理的「声明 vs 实际渲染」对账闸门
 *
 * 为什么需要它（这是 P0-3 抓到的一个真缺陷的产物）：
 *   theme/packs.json 里给每套肌理声明了 delta =「最坏情况下底色朝文字色偏移的比例」，
 *   对比度闸门（check-theme-contrast.mjs）**就是按这个数字**算最坏对比度的。
 *   也就是说：delta 是闸门的输入。delta 说小了，闸门就会给出"全绿"的假结论。
 *   实测就是这么回事 —— 配置写着 delta=0.03（偏移 3%，听着很克制），
 *   而 textureImage() 烘进 SVG 的却是 `<rect opacity='0.5'>`：
 *   拿 50% 浓度的分形噪声去 multiply 一张纸底，等效压暗远不止 3%。
 *   于是「闸门全绿」与「屏幕上那层灰」同时成立 —— 又是一个"阀门说 OK、事实是另一回事"。
 *
 * 本闸门把这条路堵死：不看声明，看**真渲染出来的像素**。
 *   ① 起真 Chrome，把主题 + 模式应用到 body；
 *   ② 把 view / 顶栏 / 底栏临时藏掉，只留纯 body 背景（肌理就在这一层上）；
 *   ③ 截图 → 回灌进页面内 canvas 解出真实像素（不引第三方 PNG 解码库）；
 *   ④ 对每个像素算它与 ink2 / brand / alert / muted 的对比度，取最坏值；
 *   ⑤ 反解"等效 delta"：让 mix(paper, fg, d) 的对比度等于实测最坏值 → 得到 dEff；
 *   ⑥ 断言 **声明 delta ≥ 实测 dEff**（声明必须覆盖现实，不许低报）。
 *
 * 跑法（playwright 在受管 workspace，必须带 NODE_PATH）：
 *   NODE_PATH=<受管 workspace>/node_modules node scripts/check-texture-render.cjs
 * 需要先起本地服务：PORT=4188 node _selftest/server.cjs
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:4188';
const packs = JSON.parse(fs.readFileSync(path.join(ROOT, 'theme', 'packs.json'), 'utf8'));

/* —— 颜色工具（与 check-theme-contrast.mjs 同源算法，独立实现以免互相牵连）—— */
const hex2rgb = (h) => {
  const s = String(h).replace('#', '').trim();
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const chan = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
const contrastRgb = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const mixRgb = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);

/** 反解等效 delta：find d s.t. contrast(fg, mix(paper,fg,d)) == target */
function solveDelta(paper, fg, targetRatio) {
  if (targetRatio >= contrastRgb(paper, fg)) return 0;   // 实测没比原色更差
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRgb(mixRgb(paper, fg, mid), fg) > targetRatio) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* 压在页面底色上的关键前景色，与 check-theme-contrast.mjs 的 CHECKS 对齐 */
const TIGHT = [
  { id: 'ink2', key: 'ink2', min: 4.5 },
  { id: 'muted', key: 'muted', min: 4.5 },
  { id: 'brand', key: 'brand', min: 4.5 },
  { id: 'alert', key: 'alert', min: 4.5 },
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 760 } });
  await page.goto(`${BASE}/?t=texture-probe`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  // 🔴 先把过渡与动画关掉再量。
  //    踩过的坑：body 上有 `transition:background-color .3s`（换主题不闪白），
  //    而我们在切完主题后只等了 150ms 就截图 —— 截到的是**过渡中的中间色**。
  //    后果非常隐蔽：暗色主题的中间色比目标纸底亮，于是"乘性混合（只可能压暗）"
  //    却量出了比纸底更亮的像素，看着像"肌理很猛"，其实量的是动画帧。
  //    静态量测必须先把时间维度去掉：只留终态。
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' });
  await page.waitForTimeout(60);

  const rows = [];
  let failed = 0;

  for (const pack of packs.packs) {
    const tex = packs.textures[pack.texture] || {};
    if (!tex.kind || tex.kind === 'none') continue;
    for (const mode of ['light', 'dark']) {
      // ① 藏掉所有内容，只留 body 自己的背景层（肌理就铺在这一层）
      await page.evaluate(() => {
        for (const sel of ['#view', '#topbar', '#tabbar', '#toast', '#modalRoot']) {
          const el = document.querySelector(sel);
          if (el) el.style.visibility = 'hidden';
        }
      });
      // ② 应用主题与模式 —— 设两次，中间留一个心跳：
      //    app 自己挂着 store 订阅在往 <html> 上写 data-theme/data-mode，
      //    我们设完它可能又被改回去。等一跳再设一次，最后立刻回读确认。
      const apply = () => page.evaluate(({ pack, mode }) => {
        document.documentElement.setAttribute('data-theme', pack);
        document.documentElement.setAttribute('data-mode', mode);
      }, { pack: pack.key, mode });
      await apply();
      await page.waitForTimeout(150);
      await apply();
      // 🔴 回读确认（测量工具本身也要被验证）：
      //    踩过的坑 —— 暗色模式没生效时，暗底被当成亮底，乘性混合只会把底压暗、
      //    浅色字的对比度本该**上升**，却测出"反而下降到 3.96"这种物理上不可能的结果。
      //    数字看着像模像样，结论全错。所以属性不对就立刻标红，绝不当成有效测量。
      const applied = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        mode: document.documentElement.getAttribute('data-mode'),
      }));
      const attrsOk = applied.theme === pack.key && applied.mode === mode;

      // ③ 截一块纯背景 → 回灌 canvas 读真实像素
      const buf = await page.screenshot({ clip: { x: 60, y: 200, width: 240, height: 240 }, type: 'png' });
      const stats = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, cv.width, cv.height).data;
        const px = [];
        for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
        return { px, n: px.length, paper: getComputedStyle(document.body).backgroundColor };
      }, buf.toString('base64'));

      const cs = pack.modes[mode].colors;
      const paper = hex2rgb(cs.paper);
      // 判定基准用**实际渲染出来的纸底**（截图里的众数色），而不是配置里的 paper ——
      // 这样即便 CSS 变量没生效（比如主题没切成功），也会立刻暴露成"实测偏差为 0"的假绿，
      // 而不是被配置值掩盖过去。
      const hist = new Map();
      for (const p of stats.px) {
        const k = p.join(',');
        hist.set(k, (hist.get(k) || 0) + 1);
      }
      let modeKey = '0,0,0', modeN = -1;
      for (const [k, n] of hist) if (n > modeN) { modeN = n; modeKey = k; }
      const renderedPaper = modeKey.split(',').map(Number);

      // 仪器自检 ②：乘性混合在物理上只能把底**压暗**（Cs≤1 → Cb*Cs ≤ Cb），
      // 所以 blend=multiply 时不该出现比纸底更亮的像素。出现了就说明这轮测量无效
      // （多半是主题没切成功、量到了别的底色），必须停机而不是当成"肌理很轻"。
      let brightest = [0, 0, 0];
      for (const p of stats.px) for (let i = 0; i < 3; i++) if (p[i] > brightest[i]) brightest[i] = p[i];
      // 颗粒幅度：像素亮度的极差与标准差。用来回答"这层肌理到底还看不看得见" ——
      // 只看对比度是否达标会让人一路把肌理调到"零代价"，而那也等于"零效果"。
      // 判据落在**局部起伏**上（这才是眼睛读到的"颗粒"），不是整体明度偏移。
      const lums = stats.px.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
      const lMin = Math.min(...lums), lMax = Math.max(...lums);
      const lMean = lums.reduce((a, b) => a + b, 0) / lums.length;
      const sigma = Math.sqrt(lums.reduce((a, b) => a + (b - lMean) ** 2, 0) / lums.length);
      const multiplySane = tex.blend !== 'multiply'
        || brightest.every((v, i) => v <= paper[i] + 3);
      const valid = attrsOk && multiplySane;
      const spread = Number((lMax - lMin).toFixed(1));
      const sigmaN = Number(sigma.toFixed(2));

      for (const fgDef of TIGHT) {
        const fg = hex2rgb(cs[fgDef.key]);
        const baseRatio = contrastRgb(fg, paper);
        let worst = Infinity;
        for (const p of stats.px) {
          const r = contrastRgb(fg, p);
          if (r < worst) worst = r;
        }
        const dEff = solveDelta(paper, fg, worst);
        const declared = typeof tex.delta === 'number' ? tex.delta : 0;
        // 三个判据：① 测量有效；② 实测仍达 AA；③ 声明的 delta 不许比实测等效 delta 还小（低报）
        const okAA = worst >= fgDef.min;
        const okDecl = declared + 1e-6 >= dEff;
        if (!valid || !okAA || !okDecl) failed++;
        rows.push({
          pack: pack.key, mode, tex: pack.texture, fg: fgDef.id,
          renderedPaper: renderedPaper.join(','), renderedMode: stats.paper,
          declared, dEff: Number(dEff.toFixed(4)), attrsOk, multiplySane, valid, spread, sigma: sigmaN,
          brightest: brightest.join(','), paperCfg: paper.join(','),
          ratioBase: Number(baseRatio.toFixed(2)), ratioWorst: Number(worst.toFixed(2)),
          min: fgDef.min, okAA, okDecl,
        });
      }
    }
  }

  // 恢复 DOM 改动，避免影响后续脚本（本脚本自己起自己的浏览器，稳妥起见还是改回来）
  await browser.close();

  /* —— 报告 —— */
  console.log('===== 纸肌理：声明 delta vs 实渲染像素 =====');
  const byTex = new Map();
  for (const r of rows) {
    const k = `${r.pack}/${r.mode}`;
    if (!byTex.has(k)) byTex.set(k, []);
    byTex.get(k).push(r);
  }
  for (const [k, list] of byTex) {
    const bad = list.filter((r) => !r.valid || !r.okAA || !r.okDecl);
    console.log(`\n-- ${k}  肌理=${list[0].tex}  声明 delta=${list[0].declared}  渲染纸底(${list[0].renderedPaper})`
      + `  颗粒幅度 极差=${list[0].spread}/255 σ=${list[0].sigma}`
      + `${bad.length ? `  ❌ ${bad.length} 项` : '  ✅'}`);
    if (!list[0].valid) {
      console.log(`   ⚠️ 测量无效：属性回读=${list[0].attrsOk ? 'ok' : '不符'} 乘性单调=${list[0].multiplySane ? 'ok' : '越界'}`
        + `  配置纸底(${list[0].paperCfg}) 实测最亮(${list[0].brightest})`);
    }
    for (const r of list) {
      const mark = (r.valid && r.okAA && r.okDecl) ? '✓' : '✗';
      console.log(`   ${mark} ${r.fg.padEnd(6)} 原色 ${String(r.ratioBase).padStart(5)} → 实测最坏 ${String(r.ratioWorst).padStart(5)} (需 ≥${r.min})`
        + `  等效 delta=${String(r.dEff).padStart(7)}  声明=${r.declared}`
        + `${r.okDecl ? '' : '  ← 声明低报了！'}${r.okAA ? '' : '  ← 实测已破 AA'}`);
    }
  }
  console.log(`\n===== 结果：${failed === 0 ? 'PASS — 声明的 delta 覆盖得住真实渲染' : `FAIL — ${failed} 项`} =====`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
