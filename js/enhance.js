/**
 * enhance.js — 配方落地的真实执行层（P1 配方增强）
 *
 * 🔴 本模块存在的唯一理由：**把「批量调色」做成真的**。
 *
 * 现实情况（本轮核实）：合并前 app.js 里的 `applyEnhance` 是
 *     store.toast(`已对分组应用修图（N 张）`)
 * —— 一个**只弹提示、不动任何像素**的假功能。用户点下去照片毫无变化，
 *   却以为调色成功了。这正是康哥明令禁止的"禁止仅弹出提示的假功能"。
 *
 * 本模块的做法：真实走 imaging.enhance()（逐像素 getImageData → 改 RGB → putImageData），
 * 输出新的 JPEG blob 并写回 store。
 *
 * ⚠️ 三条硬边界（都是会被真机打脸的地方，先说清）：
 *  1. **原图永不覆盖**。原图 _file 只读，调色结果写进新字段 `enhancedUrl`。
 *     用户随时能退回原图（"撤销调色"按钮），导出时也能选用哪一版。
 *     这是产品决策：调色是"再生成一份"，不是"改我的原图"。
 *  2. **不持久化到 localStorage**。enhancedUrl 是 blobURL，跨会话必失效；
 *     写进持久化层还会撑爆配额（store 的白名单机制已天然排除它 —— 见下方说明）。
 *  3. **缩略图同步更新**。只改大图不改缩略图的话，相册列表会显示"没调色的旧样子"，
 *     用户会以为没生效 —— 那是比不做更糟的体验。
 */

import { enhance } from './imaging.js';

/** 配方类型标识（与 recipes.js 的 type 对齐） */
export const RECIPE_KIND = { beauty: 'beauty', template: 'template' };

/**
 * 🔴 成套方案的数据形状。
 * 美颜配方 + 排版模板 绑成一套，一键加载。
 * 注意：这是**在既有 recipes 集合上加一个引用关系**，不新建表 ——
 * 另起一套表就等于两份真相源（配方改名字两处不同步）。
 */
export function makeBundle(id, { beautyId, templateId, name } = {}) {
  return {
    id: id || `bd_${Date.now().toString(36)}`,
    name: name || '成套风格',
    beautyId: beautyId || '',
    templateId: templateId || '',
  };
}

/* ==================== 真实像素级调色 ==================== */

/**
 * 对一张照片套用配方，**真的改像素**。
 *
 * @param {object} p        photo（需有 _file）
 * @param {object} recipe   {bright, soft, warm, sat, contrast}
 * @returns {Promise<{ok:boolean, url?:string, reason?:string, ms:number}>}
 *          失败时返回 ok:false + **用户能看懂的原因**，不静默
 */
export async function applyRecipeToPhoto(p, recipe) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (!p || !p._file) {
    return { ok: false, reason: '这张照片的原始数据已不在内存里，请重新导入', ms: 0 };
  }
  try {
    // 解码原图（原图是 File/Blob，可直接建 bitmap）
    const bmp = await createImageBitmap(p._file);
    const src = document.createElement('canvas');
    src.width = bmp.width; src.height = bmp.height;
    src.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();

    // 真正的逐像素处理
    const out = enhance(src, p.scene || 'other', recipe || {});

    // 输出 JPEG blob（0.92 与导出九宫格同档，肉眼几乎无损但体积小）
    const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) return { ok: false, reason: '调色结果编码失败', ms: 0 };

    return { ok: true, url: URL.createObjectURL(blob), ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) };
  } catch (e) {
    console.error('[enhance] 调色失败', e);
    return { ok: false, reason: '这张照片处理失败了（可能是格式不支持）', ms: 0 };
  }
}

/**
 * 批量套用配方到一组照片。
 *
 * 🔴 逐张串行而非 Promise.all 全部并发：36 张 12MP 原图同时解码，
 *    移动端内存会炸（这是 OOM，不是慢）。串行 + 小批最稳。
 *
 * @returns {Promise<{total:number, done:number, failed:Array<{id:string,reason:string}>, ms:number}>}
 */
export async function applyRecipeToGroup(photos, recipe, onProgress) {
  const list = photos || [];
  const failed = [];
  let done = 0;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  for (const p of list) {
    const r = await applyRecipeToPhoto(p, recipe);
    if (r.ok) {
      done++;
    } else {
      failed.push({ id: p.id, reason: r.reason });
    }
    if (typeof onProgress === 'function') onProgress({ done: done + failed.length, total: list.length });
  }
  return { total: list.length, done, failed, ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) };
}

/**
 * 撤销调色：丢掉 enhancedUrl，回到原图。
 * ⚠️ 只清我们写进去的字段，不碰用户Override / verdict 等其他模块的数据。
 */
export function revertPhoto(p) {
  if (!p || !p.enhancedUrl) return p;
  try { URL.revokeObjectURL(p.enhancedUrl); } catch { /* 已失效就算了 */ }
  const { enhancedUrl, enhancedAt, ...rest } = p;
  return rest;
}

/* ==================== 导出取图：让导出用上调色结果 ==================== */

/**
 * 🔴 为什么需要这个包装层（而不是改 export.js）：
 *
 * 用户明令「禁止修改 export.js 底层导出渲染逻辑」。这条约束是对的 ——
 * 九宫格布局、长图拼接、主题 token、H5 生成都是踩过坑调出来的，
 * 为了「导出用调色图」这种接线需求去动它，风险远大于收益。
 *
 * 那怎么让导出拿到调色后的像素？**不改 export.js，只改喂给它的数据**：
 *   - 九宫格 / 长图 → export.js 的 loadForExport() 只认 `photo._file` 与 `photo.thumbUrl`，
 *     于是把 enhancedUrl 的字节**装进 `_file`**（Blob 能直接 createImageBitmap，清晰度不打折）；
 *   - H5 分享页 → buildShareHTML() 只认 `photo.thumbUrl`，
 *     于是额外把同一张图转成 dataURL 填进 `thumbUrl`。
 *
 * 副作用控制：返回的是**浅拷贝**，store 里的照片一个字节都不动，
 * 原图 `_file` 也不会被覆盖。撤销调色后自然回到取原图，无需额外清理。
 *
 * @param {Array<object>} photos
 * @returns {Promise<Array<object>>} 包装后的照片列表（未调色的原样返回同一引用）
 */
export async function toExportPhotos(photos) {
  const list = photos || [];
  const out = [];
  for (const p of list) {
    if (!p || !p.enhancedUrl) { out.push(p); continue; }
    try {
      const blob = await (await fetch(p.enhancedUrl)).blob();
      // 🔴 两处都要填：_file 给 canvas 导出（清晰），thumbUrl 给 H5（要 dataURL）
      const next = { ...p, _file: blob };
      try {
        next.thumbUrl = await downscaleToDataURL(p.enhancedUrl, 720);
      } catch { /* 转 dataURL 失败就保留原缩略图，不阻断导出 */ }
      out.push(next);
    } catch (e) {
      // 调色结果失效（blobURL 跨会话过期等）→ 如实回落原图，不静默给空
      console.warn('[enhance] 调色结果不可用，导出回落原图', e);
      out.push(p);
    }
  }
  return out;
}

/**
 * 把 blobURL / dataURL 缩到指定边长并转 dataURL。
 *
 * 🔴 为什么配方预览与 H5 导出的缩略图都用 **dataURL 而不是 blobURL**：
 *    blobURL 生命周期跟着当前文档走，跨会话必失效，写进 localStorage 就是
 *    重启后一堆坏图（这个坑 store.load 清 thumbUrl 时踩过一次）。
 *    dataURL 是字符串，能持久化 —— 代价是体积，所以只用在 160/720 这种小尺寸。
 */
export async function downscaleToDataURL(srcUrl, size, quality = 0.8) {
  try {
    const bmp = await createImageBitmap(await (await fetch(srcUrl)).blob());
    const c = document.createElement('canvas');
    const ratio = Math.min(1, size / Math.max(bmp.width, bmp.height));
    c.width = Math.max(1, Math.round(bmp.width * ratio));
    c.height = Math.max(1, Math.round(bmp.height * ratio));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', quality);
  } catch (e) {
    console.warn('[enhance] 缩略图生成失败', e);
    return '';
  }
}
