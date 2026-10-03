#!/usr/bin/env node
/* 帧叙集 · 图标生成器
 * ------------------------------------------------------------------
 * 为什么不是「画一张 1024 的图再等比缩」：
 *   细线图标一旦先放大再缩回 48px，抗锯齿会把 1px 的线条糊成灰边，
 *   米白底上尤其明显（看起来像没画干净）。
 *   所以本脚本对**每一个输出尺寸**都按原生分辨率渲染一次 SVG 再截图，
 *   线条在任何尺寸下都是干净的单一像素比。
 *
 * 为什么用 Playwright 而不是 rsvg/ImageMagick/cairosvg：
 *   本机没有 rsvg-convert/inkscape，cairosvg 未装；playwright 已在 node_modules，
 *   且走本机 Chrome（channel:'chrome'），与项目其余自测同一套运行时。
 *
 * 一套矢量，三种用途：
 *   A. PWA / manifest  —— icon-192/512（any）+ icon-maskable-192/512（maskable，满幅底）
 *   B. 安卓自适应前景   —— 各密度 mipmap 下的 ic_launcher_foreground.png（透明底，图形落在中央 66.67% 安全区）
 *   C. 安卓旧版整图标   —— 各密度 mipmap 下的 ic_launcher.png / ic_launcher_round.png（含 #F7F4F0 底，API<26 用）
 *   D. 页头迷你 Logo    —— icons/logo-mini.svg（与桌面图标同一条路径，保证品牌一致）
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

const PAPER = '#F7F4F0';   // 米白纸感底
const BRAND = '#7A6F65';   // 雾棕主色
const SW = 1.15;           // 主线条宽（24 网格单位）——与页头迷你 Logo 完全一致
const SW_WAVE = 0.92;      // 时间轴略细，形成层次
const DOT_R = 1.3;         // 帧点半径

/* —— 主图形：翻开的薄册页 + 柔和时间轴 + 帧点（全部 24 网格坐标） —— */
const PAGES_L = 'M12 6.2C10.5 5.1 8.8 4.6 7.2 4.6H6A2 2 0 0 0 4 6.6v10.8a2 2 0 0 0 2 2h1.2c1.6 0 3.3-.5 4.8-1.6';
const PAGES_R = 'M12 6.2c1.5-1.1 3.2-1.6 4.8-1.6H18a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2h-1.2c-1.6 0-3.3-.5-4.8-1.6';
const WAVE = 'M4.5 13Q8.25 9.5 12 13q3.75 3.5 7.5 0';
const DOTS = [[8.25, 11.25, 0.5], [15.75, 14.75, 0.9]];

/* 24 网格 → 任意画布：图形横向占 16 格，所以 k = size*span/16 时 artSpan == size*span。
   图形中心正好落在画布中心（故外层先 translate(-12,-12) 把网格原点挪到图形中心）。 */
const ART_W = 16;
const kOf = (size, span) => (size * span) / ART_W;

/* 🔴 安全区硬约束（很多人是"看着差不多"就完了，这里算成断言）
   自适应 / maskable 图标会被 launcher 按**圆形**遮罩裁切，安全区是画布中心
   直径为 66.67%（安卓）/ 80%（PWA maskable 规范）的圆。
   而册页是**方形**的，图形最远点在四个外角：(4,4.6) → 距中心 √((8)²+(7.5)²)=9.71 格，
   再加半个描边 SW/2 → 9.71+0.575 ≈ 10.29 格。
   10.29/16 = 0.643，即"图形半径 ≈ 0.643 × 图形占比"。
   所以  0.643 × span ≤ 安全区半径比  才不会被切角。 */
const ART_MAX_R = 9.71 + SW / 2;      // 网格单位
const SAFE_ADAPTIVE = 66.67 / 200;    // 0.3333 → 中央 66.67% 直径的圆
const SAFE_PWA_MASK = 80 / 200;       // 0.4 → PWA maskable 中央 80% 直径的圆
function checkSafe(span, safeRatio) {
  const r = (ART_MAX_R / ART_W) * span;
  if (safeRatio && r > safeRatio + 1e-9) {
    throw new Error(
      `图形占比 ${span} 会让最远点半径 ${r.toFixed(3)}×画布 超出安全区 ${safeRatio}×画布 ` +
      `（会切角）—— 请把 span 降到 ${(safeRatio * ART_W / ART_MAX_R).toFixed(3)} 或以下`
    );
  }
}

function artSvg({ size, span, bg = null, bgRx = 0, stroke = BRAND }) {
  const k = kOf(size, span);
  const c = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
${bg ? `<rect width="${size}" height="${size}" rx="${bgRx}" fill="${bg}"/>` : ''}
<g transform="translate(${c},${c}) scale(${k}) translate(-12,-12)"
   fill="none" stroke="${stroke}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${SW}">
  <path d="${PAGES_L}"/>
  <path d="${PAGES_R}"/>
  <path d="${WAVE}" stroke-width="${SW_WAVE}" opacity=".9"/>
${DOTS.map(([x, y, o]) => `  <circle cx="${x}" cy="${y}" r="${DOT_R}" fill="${stroke}" stroke="none" opacity="${o}"/>`).join('\n')}
</g>
</svg>
`;
}

/* —— 任务表 —— */
const Android = (d) => path.join(RES, d);
const jobs = [];
const png = (rel, size, opts) => jobs.push({ rel, size, opts });
const vec = (rel, txt) => jobs.push({ rel, txt });
const del = (rel) => jobs.push({ rel, del: true });

/* 各用途的图形占比（span = 图形宽度 / 画布宽度）：
   - any / 旧版整图标：不被圆形遮罩裁 → 可以放开
   - maskable / 安卓自适应前景：必须落在圆形安全区里（层面对应 80% / 66.67% 直径） */

// A. PWA / manifest（"any" 不裁切）
png('icons/icon-192.png', 192, { span: 0.62, bg: PAPER, bgRx: 0.23 * 192 });
png('icons/icon-512.png', 512, { span: 0.62, bg: PAPER, bgRx: 0.23 * 512 });

// B. PWA maskable —— 满幅底 + 图形落在中央 80% 圆内（不裁切，但规范建议留足余量）
checkSafe(0.56, SAFE_PWA_MASK);
png('icons/icon-maskable-192.png', 192, { span: 0.56, bg: PAPER, bgRx: 0 });
png('icons/icon-maskable-512.png', 512, { span: 0.56, bg: PAPER, bgRx: 0 });

// C. 安卓自适应前景（透明底）—— 落在中央 66.67% 圆内，圆形遮罩 launcher 不切角
checkSafe(0.50, SAFE_ADAPTIVE);
for (const [d, s] of [['mipmap-mdpi', 108], ['mipmap-hdpi', 162], ['mipmap-xhdpi', 216], ['mipmap-xxhdpi', 324], ['mipmap-xxxhdpi', 432]]) {
  png(`android/app/src/main/res/${d}/ic_launcher_foreground.png`, s, { span: 0.50, bg: null });
}

// D. 安卓旧版整图标（API<26 / 不支持自适应的 launcher 走这里，不套圆遮罩）
for (const [d, s] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
  png(`android/app/src/main/res/${d}/ic_launcher.png`, s, { span: 0.66, bg: PAPER, bgRx: 0.23 * s });
}

// E. 圆图标：会按圆形遮罩显示 → 同样套安全区约束
checkSafe(0.50, SAFE_ADAPTIVE);
for (const [d, s] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
  png(`android/app/src/main/res/${d}/ic_launcher_round.png`, s, { span: 0.50, bg: PAPER, bgRx: 0.23 * s });
}

// D. 矢量：页头迷你 Logo + PWA 图标 + 安卓矢量前景/背景
vec('icons/logo-mini.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="帧叙集">
  <!-- 帧叙集 · 页头迷你 Logo —— 与桌面图标同源（scripts/gen-icons.mjs 生成）
       笔宽 1.15/24，纤细单线；描边色写死雾棕 #7A6F65，作为 <img> 引入时也能保持品牌色。 -->
  <g fill="none" stroke="${BRAND}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${SW}">
    <path d="${PAGES_L}"/>
    <path d="${PAGES_R}"/>
    <path d="${WAVE}" stroke-width="${SW_WAVE}" opacity=".9"/>
${DOTS.map(([x, y, o]) => `    <circle cx="${x}" cy="${y}" r="${DOT_R}" fill="${BRAND}" stroke="none" opacity="${o}"/>`).join('\n')}
  </g>
</svg>
`);
vec('icons/icon.svg', artSvg({ size: 64, span: 0.56, bg: PAPER, bgRx: 15 }));
vec('icons/icon-maskable.svg', artSvg({ size: 512, span: 0.62, bg: PAPER, bgRx: 0 }));
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
    const svg = artSvg({ size: j.size, ...j.opts });
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
    fs.writeFileSync(out, buf);
    done.push(`${j.rel}  ${j.size}x${j.size}  ${buf.length}B`);
  } catch (e) {
    failed.push(`${j.rel}: ${e.message}`);
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
console.log('[gen:icons] 全部通过：每个 PNG 的 IHDR 尺寸都已核对');
