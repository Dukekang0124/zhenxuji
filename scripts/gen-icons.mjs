#!/usr/bin/env node
/* 帧叙集 · 图标生成器
 * ------------------------------------------------------------------
 * 为什么不是「画一张 1024 的图再等比缩」：
 *   缩放只做**一次**，且发生在目标尺寸上。若先放大再缩回来，抗锯齿会把边缘
 *   糊成灰边，米白底上尤其明显（看起来像没画干净）。所以每一个输出尺寸都
 *   单独渲染一次再截图。
 *
 * 为什么用 Playwright 而不是 rsvg/ImageMagick/cairosvg：
 *   本机没有 rsvg-convert/inkscape，cairosvg 未装；playwright 已在 node_modules，
 *   且走本机 Chrome（channel:'chrome'），与项目其余自测同一套运行时。
 *
 * 🔴 0.6.3 起图形来源换了，尺寸保真的**依据**也跟着换（别照抄旧结论）：
 *   旧版本脚本是「一套矢量」—— 用手写 SVG 路径画翻开的册页，靠矢量数学保证
 *   48px 下线条依然干净。
 *   新版是康哥定的「帧」字标，它是一张**位图**（源自 1280px 设计稿）。
 *   位图没有矢量数学可依，保真唯一靠「源分辨率足够」：
 *     字形原生 828×717；本脚本最大只输出 512（PWA icon-512）/ 432（安卓
 *     xxxhdpi 前景）。全程是**降采样**，任何一档都不存在放大插值。
 *   若将来要输出 > 828px 的图标，必须先把字形矢量化，否则会糊。
 *
 * 一套（矢量 + 位图）资产，四种用途：
 *   A. PWA / manifest  —— icon-192/512（any）+ icon-maskable-192/512（maskable，满幅底）
 *   B. 安卓自适应前景   —— 各密度 mipmap 下的 ic_launcher_foreground.png（透明底，图形落在中央 66.67% 安全区）
 *   C. 安卓旧版整图标   —— 各密度 mipmap 下的 ic_launcher.png / ic_launcher_round.png（含底色，API<26 用）
 *   D. 页头迷你 Logo    —— icons/logo-mini.svg
 *      ⚠️ 它**仍然是旧的「册页」线条图形**，与本文件的桌面图标**不再同源**。
 *         原因：页头只有 24px，而「帧」字有 11 画 + 胶片齿孔，缩到 24px 只会糊成
 *         一团黑；纤细单线在这里的可读性明显更好。这是**有意分叉**，不是漏改。
 *         （自测 L5 会校验页头内联 SVG 与 logo-mini.svg 路径一致，改一边必须改两边。）
 * ------------------------------------------------------------------ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* 🔴 playwright 装在受管的 node workspace 里（不是本项目的 node_modules）。
   ESM 的 import 不认 NODE_PATH（只有 CJS 才认），所以走 createRequire
   从 workspace 目录解析；这样脚本既能独立跑，也不往项目里塞一堆依赖。 */
const require = createRequire('C:/Users/Admin/.workbuddy/binaries/node/workspace/index.js');
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const RES = path.join(APP, 'android', 'app', 'src', 'main', 'res');
const ICONS = path.join(APP, 'icons');

const PAPER = '#F7F4F0';   // 米白纸感底（与 manifest theme_color / 启动页 / 安卓自适应底同源）
const BRAND = '#7A6F65';   // 雾棕主色
const SW = 1.15;           // 页头迷你 Logo 线宽（24 网格单位）
const SW_WAVE = 0.92;      // 时间轴略细，形成层次
const DOT_R = 1.3;         // 帧点半径

/* ================= 产品图标：康哥定的「帧」字标 =================
   字形位图由 scripts/extract-icon-glyph.py 从设计稿抠出
   （双色混合模型解 alpha + alpha 吸附 + 边缘扩散），产出物入库在 assets/icon/。
   这里只读，不重新抠 —— 抠图是设计侧动作，生成器只负责排版。 */
const GLYPH_DIR = path.join(APP, 'assets', 'icon');
const GLYPH_PNG = path.join(GLYPH_DIR, 'frame-glyph.png');
const GLYPH_META = path.join(GLYPH_DIR, 'glyph-metrics.json');
if (!fs.existsSync(GLYPH_PNG) || !fs.existsSync(GLYPH_META)) {
  throw new Error(
    `缺少字形源文件。期望：\n  ${GLYPH_PNG}\n  ${GLYPH_META}\n` +
    `请先跑：python scripts/extract-icon-glyph.py <设计稿> assets/icon/frame-glyph.png assets/icon/glyph-metrics.json`
  );
}
const META = JSON.parse(fs.readFileSync(GLYPH_META, 'utf8'));
const ASPECT = META.aspect;                 // 字形 宽/高（实测 ≈1.1548，宽 > 高）
const GLYPH_B64 = fs.readFileSync(GLYPH_PNG).toString('base64');
console.log(`[gen:icons] 字形源 ${META.glyph_native[0]}×${META.glyph_native[1]}  宽高比 ${ASPECT}`);

/* 🔴 安全区硬约束（很多人是"看着差不多"就完了，这里算成断言）
   自适应 / maskable 图标会被 launcher 按**圆形**遮罩裁切，安全区是画布中心
   直径为 66.67%（安卓）/ 80%（PWA maskable 规范）的圆。

   ⚠️ 换了图形，这条算式的**推导**必须跟着换 —— 沿用旧数字等于没算。
   旧册页图形最远点在四角 (4,4.6) → 半径 9.71+SW/2 格，系数 0.643。
   新的「帧」字标是一个 bbox = 828×717 的矩形，最远点在 bbox 的角上：
       半宽 = span/2 ，半高 = (span/ASPECT)/2
       半径 = (span/2)·√(1 + 1/ASPECT²) = CORNER_K · span
   代入 ASPECT=1.1548 → √(1+0.7500)=1.3229 → CORNER_K ≈ 0.6614。
   （数值上与旧的 0.643 很接近，但**来源完全不同**；这里用的是保守的 bbox
     外接圆 —— 帧字的墨迹并不真的顶到 bbox 四角，所以实际余量比算式更宽。） */
const CORNER_K = 0.5 * Math.hypot(1, 1 / ASPECT);
const SAFE_ADAPTIVE = 66.67 / 200;    // 0.3333 → 中央 66.67% 直径的圆
const SAFE_PWA_MASK = 80 / 200;       // 0.4 → PWA maskable 中央 80% 直径的圆
function checkSafe(span, safeRatio) {
  const r = CORNER_K * span;
  if (safeRatio && r > safeRatio + 1e-9) {
    throw new Error(
      `图形占比 ${span} 会让最远点半径 ${r.toFixed(4)}×画布 超出安全区 ${safeRatio}×画布 ` +
      `（会切角）—— 请把 span 降到 ${(safeRatio / CORNER_K).toFixed(4)} 或以下`
    );
  }
}

/* 把「帧」字标按 span 居中排到 size×size 画布上。
   span 的语义沿用旧版：**字形宽 / 画布宽**（不是最长边），这样与历史
   设计参数可直接对比；高度由 ASPECT 反推。 */
function frameMarkSvg({ size, span, bg = null, bgRx = 0 }) {
  const gw = size * span;
  const gh = gw / ASPECT;
  const x = (size - gw) / 2;
  const y = (size - gh) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    (bg ? `<rect width="${size}" height="${size}" rx="${bgRx}" fill="${bg}"/>` : '') +
    `<image href="data:image/png;base64,${GLYPH_B64}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" ` +
    `width="${gw.toFixed(2)}" height="${gh.toFixed(2)}" preserveAspectRatio="none"/>` +
    `</svg>\n`;
}

/* —— 页头迷你 Logo（旧「册页」图形，保留；见文件头 D 段说明） —— */
const PAGES_L = 'M12 6.2C10.5 5.1 8.8 4.6 7.2 4.6H6A2 2 0 0 0 4 6.6v10.8a2 2 0 0 0 2 2h1.2c1.6 0 3.3-.5 4.8-1.6';
const PAGES_R = 'M12 6.2c1.5-1.1 3.2-1.6 4.8-1.6H18a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2h-1.2c-1.6 0-3.3-.5-4.8-1.6';
const WAVE = 'M4.5 13Q8.25 9.5 12 13q3.75 3.5 7.5 0';
const DOTS = [[8.25, 11.25, 0.5], [15.75, 14.75, 0.9]];

/* —— 任务表 —— */
const jobs = [];
const png = (rel, size, opts) => jobs.push({ rel, size, opts });
const vec = (rel, txt) => jobs.push({ rel, txt });
const del = (rel) => jobs.push({ rel, del: true });

/* 各用途的图形占比（span = 字形宽 / 画布宽）：
   - any / 旧版整图标：不被圆形遮罩裁 → 可以放开
   - maskable / 安卓自适应前景：必须落在圆形安全区里（层面对应 80% / 66.67% 直径） */

// A. PWA / manifest（"any" 不裁切）
png('icons/icon-192.png', 192, { span: 0.62, bg: PAPER, bgRx: 0.23 * 192, safe: null });
png('icons/icon-512.png', 512, { span: 0.62, bg: PAPER, bgRx: 0.23 * 512, safe: null });

// B. PWA maskable —— 满幅底 + 图形落在中央 80% 圆内（不裁切，但规范建议留足余量）
checkSafe(0.56, SAFE_PWA_MASK);
png('icons/icon-maskable-192.png', 192, { span: 0.56, bg: PAPER, bgRx: 0, safe: SAFE_PWA_MASK });
png('icons/icon-maskable-512.png', 512, { span: 0.56, bg: PAPER, bgRx: 0, safe: SAFE_PWA_MASK });

// C. 安卓自适应前景（透明底）—— 落在中央 66.67% 圆内，圆形遮罩 launcher 不切角
checkSafe(0.50, SAFE_ADAPTIVE);
for (const [d, s] of [['mipmap-mdpi', 108], ['mipmap-hdpi', 162], ['mipmap-xhdpi', 216], ['mipmap-xxhdpi', 324], ['mipmap-xxxhdpi', 432]]) {
  png(`android/app/src/main/res/${d}/ic_launcher_foreground.png`, s, { span: 0.50, bg: null, safe: SAFE_ADAPTIVE });
}

// D. 安卓旧版整图标（API<26 / 不支持自适应的 launcher 走这里，不套圆遮罩）
for (const [d, s] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
  png(`android/app/src/main/res/${d}/ic_launcher.png`, s, { span: 0.66, bg: PAPER, bgRx: 0.23 * s, safe: null });
}

// E. 圆图标：会按圆形遮罩显示 → 同样套安全区约束
checkSafe(0.50, SAFE_ADAPTIVE);
for (const [d, s] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
  png(`android/app/src/main/res/${d}/ic_launcher_round.png`, s, { span: 0.50, bg: PAPER, bgRx: 0.23 * s, safe: SAFE_ADAPTIVE });
}

// F. 矢量 —— 页头迷你 Logo（旧册页图形，见文件头说明）
vec('icons/logo-mini.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="帧叙集">
  <!-- 帧叙集 · 页头迷你 Logo（scripts/gen-icons.mjs 生成）
       笔宽 1.15/24，纤细单线；描边色写死雾棕 ${BRAND}，作为 <img> 引入时也能保持品牌色。
       ⚠️ 0.6.3 起这个图形**不再**与桌面图标同源：桌面图标换成了「帧」字标，
          而 24px 下 11 画的汉字会糊成一团，这里保留可读性更好的册页单线。
          自测 L5 会校验它与 index.html 里的内联 SVG 路径一致 —— 改一边必须改两边。 -->
  <g fill="none" stroke="${BRAND}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${SW}">
    <path d="${PAGES_L}"/>
    <path d="${PAGES_R}"/>
    <path d="${WAVE}" stroke-width="${SW_WAVE}" opacity=".9"/>
${DOTS.map(([x, y, o]) => `    <circle cx="${x}" cy="${y}" r="${DOT_R}" fill="${BRAND}" stroke="none" opacity="${o}"/>`).join('\n')}
  </g>
</svg>
`);

/* 🔴 删掉 Capacitor 默认的 API 24–25 矢量前景（那张还是蓝 C 占位），
   同时让这两档版本走 AndroidManifest 里本就存在的 android:icon="@mipmap/ic_launcher"
   兜底 —— 直接用本脚本新生成的整图 PNG（含底色），比手搓一份带圆弧的
   VectorDrawable 稳得多（VectorDrawable 对 A（圆弧）指令的支持在 24/25 上不可靠）。 */
del('android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml');
vec('android/app/src/main/res/drawable/ic_launcher_background.xml',
`<?xml version="1.0" encoding="utf-8"?>
<!-- 帧叙集 · 自适应图标背景（原 Capacitor 默认青绿网格已移除） -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="${PAPER}" android:pathData="M0,0h108v108h-108z"/>
</vector>
`);
// 自适应图标的 background 层取色（anydpi-v26 引用的是 @color/ic_launcher_background）
vec('android/app/src/main/res/values/ic_launcher_background.xml',
`<?xml version="1.0" encoding="utf-8"?>
<!-- 帧叙集 · 自适应图标背景色：米白纸感 -->
<resources>
    <color name="ic_launcher_background">${PAPER}</color>
</resources>
`);

/* —— 执行 —— */
const pngDims = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
const failed = [];
const done = [];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1, omitBackground: true });

/* 在浏览器里把字形重采样到指定像素宽并取回 dataURL。
   用途：内嵌进 .svg 文件。为什么不直接塞 828px 原图 —— 那会让 icon.svg 涨到 43KB，
   而它只是个 favicon；缩到目标像素后不到 1/4。 */
async function glyphAtWidth(w) {
  return page.evaluate(({ b64, w }) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const h = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, w, h);
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => rej(new Error('字形位图解码失败'));
    img.src = 'data:image/png;base64,' + b64;
  }), { b64: GLYPH_B64, w });
}

/* 🔴 生成后的**行为**校验（只看 IHDR 尺寸是不够的：尺寸对、内容空白也照样通过）
   在浏览器里把刚写出的 PNG 解码回来，实测三件事：
     ① 有墨 —— 深色像素占比 > 0.5%（防"整体渲染成空白"）
     ② 双色齐全 —— 存在暖色像素（r-b>40），证明豆沙那半没丢
     ③ 底满幅 —— 带底色的图标，最外一圈像素必须等于底色（防源图的白边被带进来）
     ④ 安全区 —— 圆形遮罩类，墨迹最远半径必须落在安全圆内（复算，不靠前面的算式自觉） */
async function verifyPng(buf, { bg, safe }) {
  const stats = await page.evaluate(async ({ url, sizeP }) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const n = c.width * c.height;
    let dark = 0, warm = 0;
    let maxR2 = 0;
    const cx = c.width / 2, cy = c.height / 2;
    for (let i = 0; i < n; i++) {
      const o = i * 4, r = d[o], gg = d[o + 1], b = d[o + 2], a = d[o + 3];
      if (a < 128) continue;
      const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
      const isInk = lum < 120 || (r - b) > 40;
      if (lum < 120) dark++;
      if ((r - b) > 40) warm++;
      if (isInk) {
        const x = i % c.width, y = (i / c.width) | 0;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const rr = dx * dx + dy * dy;
        if (rr > maxR2) maxR2 = rr;
      }
    }
    const at = (x, y) => { const o = (y * c.width + x) * 4; return [d[o], d[o + 1], d[o + 2], d[o + 3]]; };
    const mid = (c.width / 2) | 0, last = c.width - 1;
    return {
      w: c.width, h: c.height, n,
      darkRatio: dark / n, warmRatio: warm / n,
      maxR: Math.sqrt(maxR2) / c.width,
      // ⚠️ 探针取**四边中点**而不是四角：带圆角的底（bgRx>0）四角本来就是透明的，
      //    拿四角去比"是否等于底色"必然会误报。四边中点无论圆角与否都落在底色上，
      //    而源图那圈约 10px 的白边若被带进来，这里会第一时间发现。
      edges: { 上: at(mid, 0), 下: at(mid, last), 左: at(0, mid), 右: at(last, mid) },
    };
  }, { url: 'data:image/png;base64,' + buf.toString('base64') });

  const errs = [];
  if (stats.darkRatio < 0.005) errs.push(`深色墨迹仅 ${(stats.darkRatio * 100).toFixed(2)}%（<0.5%，疑似空白图标）`);
  if (stats.warmRatio < 0.002) errs.push(`暖色（豆沙）像素仅 ${(stats.warmRatio * 100).toFixed(2)}%（双色标残缺）`);
  if (bg) {
    const want = bg.replace('#', '').match(/../g).map((h) => parseInt(h, 16));
    for (const [k, c] of Object.entries(stats.edges)) {
      const near = Math.abs(c[0] - want[0]) + Math.abs(c[1] - want[1]) + Math.abs(c[2] - want[2]) <= 12;
      if (!near) { errs.push(`${k}边中点不是底色（实测 rgba(${c.join(',')}) ≠ ${bg}）→ 底色没铺满`); break; }
    }
  }
  if (safe && stats.maxR > safe + 1e-3) {
    errs.push(`墨迹最远半径 ${stats.maxR.toFixed(4)} 超出安全圆 ${safe}（会被圆形遮罩切角）`);
  }
  return { errs, stats };
}

/* 生成内嵌字形的 SVG：先把字形位图重采样到目标像素，再拼装。 */
async function svgWithFrame({ size, span, bg, bgRx }) {
  const gw = Math.round(size * span);
  const glyphUrl = await glyphAtWidth(gw);
  return frameMarkSvg({ size, span, bg, bgRx }).replace(
    /href="data:image\/png;base64,[^"]+"/,
    `href="${glyphUrl}"`
  );
}

for (const j of jobs) {
  const out = path.isAbsolute(j.rel) ? j.rel : path.join(APP, j.rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    if (j.del) {
      fs.rmSync(out, { force: true });
      done.push(`${j.rel}  已删除（交给 mipmap 兜底）`);
      continue;
    }
    if (j.txt !== undefined) {
      fs.writeFileSync(out, j.txt.replace(/\r\n/g, '\n'), 'utf8');
      done.push(`${j.rel}  ${Buffer.byteLength(j.txt)}B`);
      continue;
    }
    const svg = frameMarkSvg({ size: j.size, ...j.opts });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${svg}</body></html>`, {
      waitUntil: 'load',
    });
    const buf = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: j.size, height: j.size },
    });
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 魔数');
    const [w, h] = pngDims(buf);
    if (w !== j.size || h !== j.size) throw new Error(`尺寸不符 IHDR=${w}x${h} 期望=${j.size}`);
    const { errs, stats } = await verifyPng(buf, { bg: j.opts.bg, safe: j.opts.safe });
    if (errs.length) throw new Error('内容校验未过：' + errs.join('；'));
    fs.writeFileSync(out, buf);
    done.push(`${j.rel}  ${j.size}x${j.size}  ${buf.length}B  墨${(stats.darkRatio * 100).toFixed(1)}%/暖${(stats.warmRatio * 100).toFixed(1)}%/半径${stats.maxR.toFixed(3)}`);
  } catch (e) {
    failed.push(`${j.rel}: ${e.message}`);
  }
}

/* PWA 图标引用的是 /icons/icon.svg 与 icon-maskable.svg —— 这两个文件内容
   直接决定 manifest 与 favicon，必须真的生成出来，不能静默跳过。 */
for (const [rel, opts] of [
  ['icons/icon.svg', { size: 512, span: 0.62, bg: PAPER, bgRx: 0.23 * 512 }],
  // ⚠️ 旧版这里写的是 span 0.62，与同名 PNG（0.56）不一致 —— maskable 图形比 PNG 版大，
  //    安全区余量被悄悄吃掉。0.6.3 起统一为 0.56。
  ['icons/icon-maskable.svg', { size: 512, span: 0.56, bg: PAPER, bgRx: 0 }],
]) {
  const out = path.join(APP, rel);
  try {
    const txt = await svgWithFrame(opts);
    fs.writeFileSync(out, txt, 'utf8');
    done.push(`${rel}  ${Buffer.byteLength(txt)}B（内嵌字形位图）`);
  } catch (e) {
    failed.push(`${rel}: ${e.message}`);
  }
}

await browser.close();

console.log('[gen:icons] 已生成 ' + done.length + ' 项：');
done.forEach((d) => console.log('   ✓ ' + d));
if (failed.length) {
  console.error('[gen:icons] ✗ ' + failed.length + ' 项失败：');
  failed.forEach((f) => console.error('   ✗ ' + f));
  process.exit(1);
}
console.log('[gen:icons] 全部通过：每个 PNG 的 IHDR 尺寸 + 墨迹/双色/底色满幅/安全区都已实测');
