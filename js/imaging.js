/**
 * imaging.js — 图像解码 / EXIF / 缩略图 / 批量修图
 *
 * 职责：方案「模块2 智能批量修图」+ 相册扫描的数据来源层。
 * 关键纪律：
 *   - 原图**只读**，任何函数都不得写回用户文件系统（方案硬约束第 5 条）。
 *   - 解码后立即降采样并释放 bitmap，上万张照片场景下防 OOM。
 *   - 本文件是唯一「知道照片从哪来」的文件。接入 Capacitor 原生相册时，
 *     只需替换 pickPhotos() 与 readExif()，上层 cv/ai/app 零改动。
 */

const ANALYSIS_WIDTH = 256; // 分析统一尺度：够准且快

/* ============================ 照片来源 ============================ */

/**
 * 拉起系统/浏览器照片选择。
 * mode: 'few'   → 手动选择少量照片（对应方案「部分照片权限」语义）
 *       'album' → 选择整个文件夹（webkitdirectory，对应「完整相册访问」语义）
 * @returns {Promise<File[]>}
 */
export function pickPhotos(mode = 'few') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    if (mode === 'album') {
      // 整目录读取 —— 等价「完整相册扫描」入口
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    input.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.appendChild(input);
    let done = false;
    const finish = (files) => { if (done) return; done = true; input.remove(); resolve(files || []); };
    input.addEventListener('change', () => finish([...input.files]));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

export function filterImages(files) {
  return files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
}

/* ============================ EXIF 解析 ============================ */

/**
 * 从 JPEG 头部解析 EXIF：拍摄时间（DateTimeOriginal）与 GPS 坐标。
 * 只读前 128KB —— APP1 段一定在文件头部，避免整文件入内存。
 * @returns {{takenAt:number|null, lat:number|null, lon:number|null}}
 */
export async function readExif(file) {
  const empty = { takenAt: null, lat: null, lon: null };
  try {
    const head = await file.slice(0, 131072).arrayBuffer();
    const view = new DataView(head);
    if (view.byteLength < 4) return empty;
    if (view.getUint16(0) !== 0xffd8) return empty; // 非 JPEG（PNG/WebP 不解析，回落 mtime）

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) { offset++; continue; }
      const marker = view.getUint8(offset + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break; // 进入图像数据，EXIF 结束

      const size = view.getUint16(offset + 2);
      if (marker === 0xe1) {
        const start = offset + 4;
        if (start + 6 <= view.byteLength) {
          let tag = '';
          for (let i = 0; i < 4; i++) tag += String.fromCharCode(view.getUint8(start + i));
          if (tag === 'Exif') return parseTiff(view, start + 6);
        }
      }
      if (size < 2) break;
      offset += 2 + size;
    }
    return empty;
  } catch (e) {
    console.warn('[imaging] exif parse failed', e);
    return empty;
  }
}

function parseTiff(view, start) {
  const out = { takenAt: null, lat: null, lon: null };
  try {
    const bo = view.getUint16(start);           // 0x4949 = II, 0x4d4d = MM
    const le = bo === 0x4949;
    if (view.getUint16(start + 2, le) !== 0x002a) return out;

    const ifd0 = start + view.getUint32(start + 4, le);
    const entries0 = readIFD(view, ifd0, start, le);

    // Exif SubIFD
    if (entries0[0x8769] != null) {
      const sub = readIFD(view, start + entries0[0x8769], start, le);
      if (sub[0x9003] != null) out.takenAt = parseExifDate(readASCII(view, sub[0x9003], start, le));
      else if (sub[0x9004] != null) out.takenAt = parseExifDate(readASCII(view, sub[0x9004], start, le));
    }
    // GPS IFD
    if (entries0[0x8825] != null) {
      const g = readIFD(view, start + entries0[0x8825], start, le);
      const latRef = readASCII(view, g[0x0001], start, le) || 'N';
      const lonRef = readASCII(view, g[0x0003], start, le) || 'E';
      const lat = readRationalTriplet(view, g[0x0002], start, le);
      const lon = readRationalTriplet(view, g[0x0004], start, le);
      if (lat != null) out.lat = (latRef.toUpperCase() === 'S' ? -1 : 1) * lat;
      if (lon != null) out.lon = (lonRef.toUpperCase() === 'W' ? -1 : 1) * lon;
    }
    if (out.takenAt == null && entries0[0x0132] != null) {
      out.takenAt = parseExifDate(readASCII(view, entries0[0x0132], start, le));
    }
  } catch (e) { /* EXIF 损坏不影响主流程 */ }
  return out;
}

function readIFD(view, ifdOffset, tiffStart, le) {
  const map = {};
  if (ifdOffset + 2 > view.byteLength) return map;
  const n = view.getUint16(ifdOffset, le);
  for (let i = 0; i < n; i++) {
    const e = ifdOffset + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    map[view.getUint16(e, le)] = e + 8; // 存值/偏移指针位置
  }
  return map;
}

function readASCII(view, valPtr, tiffStart, le) {
  if (valPtr == null) return null;
  try {
    const type = view.getUint16(valPtr - 6, le);
    const count = view.getUint32(valPtr - 4, le);
    if (type !== 2) return null;
    let p = count > 4 ? tiffStart + view.getUint32(valPtr, le) : valPtr;
    let s = '';
    for (let i = 0; i < count && p < view.byteLength; i++, p++) {
      const c = view.getUint8(p);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  } catch (e) { return null; }
}

function readRationalTriplet(view, valPtr, tiffStart, le) {
  if (valPtr == null) return null;
  try {
    const type = view.getUint16(valPtr - 6, le);
    if (type !== 5 && type !== 10) return null;
    const base = tiffStart + view.getUint32(valPtr, le);
    const rd = (i) => {
      const p = base + i * 8;
      if (p + 8 > view.byteLength) return 0;
      const num = view.getUint32(p, le), den = view.getUint32(p + 4, le);
      return den ? num / den : 0;
    };
    const d = rd(0), m = rd(1), s = rd(2);
    return d + m / 60 + s / 3600;
  } catch (e) { return null; }
}

/** EXIF 日期 "2026:09:12 14:03:22" → 时间戳（按本地时区解释） */
export function parseExifDate(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T]?(\d{2})?:?(\d{2})?:?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isFinite(t) ? t : null;
}

/* ============================ 解码与降采样 ============================ */

/**
 * 解码单张照片 → 分析像素 + 缩略图 + EXIF。
 * 解码后立即 close bitmap，避免上万张时内存爆掉。
 */
export async function decodePhoto(file, thumbSize = 256) {
  const bmp = await createImageBitmap(file);
  try {
    const { width: w, height: h } = bmp;
    const aw = Math.min(ANALYSIS_WIDTH, w);
    const ah = Math.max(1, Math.round((h * aw) / w));

    const aCanvas = drawTo(bmp, aw, ah);
    const pixels = aCanvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, aw, ah).data;

    const tCanvas = drawTo(bmp, thumbSize, Math.max(1, Math.round((h * thumbSize) / w)));

    const exif = await readExif(file);
    return {
      w, h,
      pixels, pw: aw, ph: ah,
      thumbCanvas: tCanvas,
      takenAt: exif.takenAt ?? file.lastModified ?? Date.now(),
      lat: exif.lat, lon: exif.lon,
    };
  } finally {
    if (bmp.close) bmp.close(); // 立即释放
  }
}

function drawTo(bmp, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  return c;
}

/**
 * 缩略图画布 → 可持久化 dataURL。
 *
 * 🔴 质量从 0.72 提到 0.82（P0 图片画质专项）：0.72 在 96px 小图上不明显，
 *    但缩略图边长提到 256 后，低质量会在人像脸部/风景细节处压出可见块状噪点。
 */
export function canvasToURL(canvas) {
  return canvas.toDataURL('image/jpeg', 0.82);
}

/* ==================== 原图显示源（大图预览用） ====================
 *
 * 🔴 P0 图片画质专项（根因修复的一部分）：
 *    页面里"全宽大图"（作品详情页）此前直接渲染 p.thumbUrl（缩略图），
 *    被拉伸到整屏 → 肉眼可见马赛克/糊。用户要的是"屏幕用适配预览、底层留原图"。
 *    这里给出**会话内**的原图显示源（blobURL），按 id 缓存，避免每次渲染新建 URL。
 *
 *   - 有 `_file`（原图句柄，导入后会话内一直在）→ 原图 blobURL，全分辨率；
 *   - 无 `_file`（重启后，句柄本来就不落盘）→ 回落 thumbUrl，如实降级。
 * 绝不在此修改/压缩原文件；blobURL 只是引用。
 */
const _displayCache = new Map(); // photoId -> blobURL

export function displaySrc(p) {
  if (!p) return '';
  if (p._file) {
    let u = _displayCache.get(p.id);
    if (!u) { try { u = URL.createObjectURL(p._file); _displayCache.set(p.id, u); } catch (_) { u = ''; } }
    if (u) return u;
  }
  return p.thumbUrl || '';
}

/** 释放显示源缓存（清空数据 / 重置时调用，防 blobURL 泄漏） */
export function clearDisplaySrc() {
  for (const u of _displayCache.values()) { try { URL.revokeObjectURL(u); } catch (_) { /* 忽略 */ } }
  _displayCache.clear();
}

/** 稳定 id：名字+大小+时间，同一张照片重复导入不会重复入库 */
export function photoId(file) {
  return `p_${hashStr(`${file.name}|${file.size}|${file.lastModified}`)}`;
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** 极小图 / 截图识别（方案：默认不纳入故事推荐分组） */
export function classifyByMeta(w, h, hasExifTime) {
  const maxSide = Math.max(w, h);
  const isTiny = maxSide < 320;
  const ratios = [16 / 9, 9 / 16, 9 / 19.5, 19.5 / 9, 4 / 3, 3 / 4];
  const r = w / h;
  const isScreenRatio = ratios.some((x) => Math.abs(r - x) < 0.02);
  return { isTiny, isScreenshot: isScreenRatio && !hasExifTime && maxSide > 320 };
}

/* ============================ 批量修图 ============================ */

/**
 * 差异化修图（参数化调色，非深度学习美颜）。
 * portrait：提亮 + 柔化 + 暖调；landscape：对比 + 饱和；food：提亮 + 暖调 + 饱和
 * @param {HTMLCanvasElement} src 原尺寸画布（调用方按需传入，避免反复解码）
 * @param {string} scene
 * @param {object} recipe 用户配方 {bright, soft, warm, sat, contrast}
 */
export function enhance(src, scene, recipe = {}) {
  const base = {
    portrait: { bright: 6, soft: 0.35, warm: 8, sat: 4, contrast: 4 },
    landscape: { bright: 2, soft: 0, warm: 2, sat: 12, contrast: 10 },
    food: { bright: 8, soft: 0.1, warm: 12, sat: 14, contrast: 6 },
    other: { bright: 4, soft: 0.1, warm: 4, sat: 6, contrast: 5 },
  }[scene] || { bright: 4, soft: 0.1, warm: 4, sat: 6, contrast: 5 };
  const p = { ...base, ...recipe };

  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const cf = (259 * (p.contrast + 255)) / (255 * (259 - p.contrast));
  const sf = 1 + p.sat / 100;
  const bf = p.bright;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    // 亮度
    r += bf; g += bf; b += bf;
    // 对比度
    r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; b = cf * (b - 128) + 128;
    // 饱和度（围绕亮度加权）
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l + sf * (r - l); g = l + sf * (g - l); b = l + sf * (b - l);
    // 暖调
    r += p.warm; b -= p.warm * 0.6;
    d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
  }
  ctx.putImageData(img, 0, 0);

  // 柔化（人像）：叠一层低透明度模糊 —— 简化版磨皮，明确非真美颜模型
  if (p.soft > 0.02) {
    const tmp = document.createElement('canvas');
    tmp.width = out.width; tmp.height = out.height;
    const tctx = tmp.getContext('2d');
    tctx.filter = `blur(${Math.max(1, Math.round(3 * p.soft * 4))}px)`;
    tctx.drawImage(out, 0, 0);
    ctx.globalAlpha = 0.28 * p.soft;
    ctx.drawImage(tmp, 0, 0);
    ctx.globalAlpha = 1;
  }
  return out;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * 人脸角度异常预警（启发式）。
 * ⚠️ 真人脸角度需关键点模型；本版基于「亮度分布左右不对称 + 逆光」给出**弱提示**，
 *    并在 UI 明示为「提示」而非判定，用户可忽略。
 */
export function faceWarning(m) {
  const warns = [];
  if (m.brightness < 90 && m.over > 0.05) warns.push('疑似逆光，建议提亮');
  if (m.skinRatio > 0.02 && m.skinRatio < 0.10) warns.push('人脸占比偏小，可能为侧脸');
  if (m.contrastStd > 95) warns.push('明暗反差大，五官可能偏硬');
  return warns;
}
