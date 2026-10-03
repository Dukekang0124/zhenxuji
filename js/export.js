/**
 * export.js — 九宫格 / 微信竖版长图 / H5 分享页 / 下载
 *
 * 方案「模块4」：叙事九宫格自动统一整套色调；微信优化竖版长图降低压缩糊图。
 */

import { enhance } from './imaging.js';
import { get as getState } from './store.js';
import { tokens } from './theme.js';
import { currentAppearance } from './appearance.js';

/**
 * 导出取色（V1.5：导出故事册跟随外观主题；本轮起同时跟随明暗）。
 *  🔴 所有函数**签名不变** —— 主题在内部从 store 取，调用方（app.js）一行都不用改。
 *  🔴 绝不在这里硬编码 #7A6F65 之类：画到 canvas 上的颜色必须是当前主题的 token，
 *     否则用户换成「山野信笺」导出的图还是雾棕纸白，主题形同虚设。
 *  🔴 明暗也要跟：用户在深色模式下导出，拿到的图必须也是深色版，
 *     否则分享出去的和自己在 App 里看到的不是同一套（走 appearance.js 统一解析，
 *     不在本文件重写一遍 matchMedia 判断）。
 */
function tk() {
  const s = getState().settings || {};
  const { theme, mode } = currentAppearance(s);
  return tokens(theme, mode);
}

/** 载入导出用画布：优先用原文件（清晰），缺失时回落缩略图（会糊，如实标注） */
export async function loadForExport(photo, size = 900) {
  if (photo._file) {
    try {
      const bmp = await createImageBitmap(photo._file);
      const c = document.createElement('canvas');
      const w = Math.min(size, bmp.width);
      c.width = w; c.height = Math.max(1, Math.round((bmp.height * w) / bmp.width));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return { canvas: c, degraded: false };
    } catch (e) { /* 回落缩略图 */ }
  }
  if (photo.thumbUrl) {
    const img = await loadImage(photo.thumbUrl);
    const c = document.createElement('canvas');
    c.width = Math.min(size, img.width * 6);
    c.height = Math.round((img.height * c.width) / img.width);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { canvas: c, degraded: true };
  }
  return { canvas: null, degraded: true };
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 统一整套色调：先算组内平均亮度/饱和，再反推补偿参数 */
export function unifyToneParams(photos) {
  const n = photos.length || 1;
  const bright = photos.reduce((a, p) => a + (p.brightness || 128), 0) / n;
  const sat = photos.reduce((a, p) => a + (p.saturation || 0.3), 0) / n;
  return {
    bright: Math.round((128 - bright) * 0.35),
    sat: Math.round((0.42 - sat) * 40),
    warm: 6,
    contrast: 6,
    soft: 0,
  };
}

/**
 * 叙事九宫格（3×3）。取前 9 张（按叙事顺序），统一色调。
 */
export async function makeNineGrid(photos, cell = 360, gap = 8) {
  const list = photos.slice(0, 9);
  const tone = unifyToneParams(list);
  const size = cell * 3 + gap * 2 + gap * 2;
  const out = document.createElement('canvas');
  out.width = size; out.height = size;
  const ctx = out.getContext('2d');
  ctx.fillStyle = tk().paper;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < list.length; i++) {
    const { canvas } = await loadForExport(list[i], cell * 2);
    if (!canvas) continue;
    const tuned = enhance(canvas, list[i].scene || 'other', tone);
    const x = gap + (i % 3) * (cell + gap);
    const y = gap + Math.floor(i / 3) * (cell + gap);
    drawCover(ctx, tuned, x, y, cell, cell);
  }
  return out;
}

/**
 * 微信优化竖版长图：固定 1080 宽（朋友圈压缩友好），按叙事顺序纵向拼贴 + 文案区
 */
export async function makeLongImage(photos, story, width = 1080) {
  const list = photos.slice(0, 9);
  const tone = unifyToneParams(list);
  const pad = 48;
  const textH = 260;
  const imgH = Math.round((width - pad * 2) * 1.25); // 4:5
  const height = pad + textH + list.length * (imgH + pad);

  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  const ctx = out.getContext('2d');
  const t = tk();
  ctx.fillStyle = t.paper;
  ctx.fillRect(0, 0, width, height);

  // 封面文案区
  ctx.fillStyle = t.brand;
  ctx.font = `600 ${Math.round(width / 18)}px "Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(story?.text?.cover || story?.title || '生活故事', pad, pad + 10);
  ctx.fillStyle = t.muted;
  ctx.font = `400 ${Math.round(width / 34)}px "Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif`;
  wrapText(ctx, story?.text?.body || '', pad, pad + 110, width - pad * 2, Math.round(width / 26));

  let y = pad + textH;
  for (let i = 0; i < list.length; i++) {
    const { canvas } = await loadForExport(list[i], width);
    if (!canvas) continue;
    const tuned = enhance(canvas, list[i].scene || 'other', tone);
    drawCover(ctx, tuned, pad, y, width - pad * 2, imgH);
    const cap = (story?.text?.captions || [])[i];
    if (cap) {
      ctx.fillStyle = t.brand;
      ctx.font = `400 ${Math.round(width / 30)}px "Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.fillText(cap, pad, y + imgH + 14);
    }
    y += imgH + pad;
  }
  return out;
}

function drawCover(ctx, src, x, y, w, h) {
  const sr = src.width / src.height, dr = w / h;
  let sw = src.width, sh = src.height, sx = 0, sy = 0;
  if (sr > dr) { sw = src.height * dr; sx = (src.width - sw) / 2; }
  else { sh = src.width / dr; sy = (src.height - sh) / 2; }
  ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h);
}

function wrapText(ctx, text, x, y, maxW, lh) {
  let line = '', yy = y;
  for (const ch of String(text || '')) {
    if (ctx.measureText(line + ch).width > maxW) { ctx.fillText(line, x, yy); line = ch; yy += lh; }
    else line += ch;
  }
  if (line) ctx.fillText(line, x, yy);
}

export function downloadCanvas(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve(false);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); resolve(true); }, 300);
    }, 'image/jpeg', 0.92);
  });
}

/**
 * 生成 H5 分享页（离线可看的完整 HTML）。
 * MVP 阶段导出为本地 HTML 文件；在线持久分享需部署 worker/（见文档待办）。
 */
export function buildShareHTML(story, photos, templateId = 't1') {
  const imgs = photos.slice(0, 9).map((p) => p.thumbUrl).filter(Boolean);
  const caps = story?.text?.captions || [];
  // V1.5：H5 分享页内联一套当前主题的变量，导出出去的页面和 APP 内是同一套气质
  const t = tk();
  const vars = `--brand:${t.brand};--mint:${t.mint};--paper:${t.paper};`
    + `--ink:${t.ink};--ink-2:${t['ink-2']};--line:${t.line}`;
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(story?.text?.cover || story?.title || '帧叙集')}</title>
<style>
:root{${vars}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);
font-family:"Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.75}
.wrap{max-width:640px;margin:0 auto;padding:32px 20px 60px}
h1{font-size:22px;font-weight:600;color:var(--brand);letter-spacing:.08em;margin:0 0 6px}
.date{font-size:13px;color:var(--ink-2);margin-bottom:28px}
figure{margin:0 0 28px}
img{width:100%;display:block;border-radius:10px;background:var(--line)}
figcaption{font-size:13px;color:var(--ink-2);margin-top:8px;letter-spacing:.04em}
.body{font-size:15px;color:var(--ink);margin:28px 0}
.hook{font-size:14px;color:var(--brand);border-left:2px solid var(--mint);padding-left:12px;margin:24px 0}
.foot{font-size:12px;color:var(--ink-2);text-align:center;margin-top:48px}
</style></head><body><div class="wrap">
<h1>${esc(story?.text?.cover || story?.title || '生活故事')}</h1>
<div class="date">${esc(story?.dateText || '')}</div>
${imgs.map((src, i) => `<figure><img src="${src}" alt=""><figcaption>${esc(caps[i] || '')}</figcaption></figure>`).join('\n')}
<div class="body">${esc(story?.text?.body || '')}</div>
<div class="hook">${esc(story?.text?.hook || '')}</div>
<div class="foot">由 帧叙集 生成 · ${new Date().toLocaleDateString('zh-CN')}</div>
</div></body></html>`;
}

export function downloadText(text, filename, mime = 'text/html') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 300);
}
