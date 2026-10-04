/**
 * scan.js — 相册异步分页扫描引擎
 *
 * 对应方案「模块0」的性能要求：
 *  - 分页懒加载：一批一批解码，绝不一次性把全部原图读进内存
 *  - 后台异步：每批之间让出主线程（await yieldFrame），进度条可响应
 *  - 可暂停 / 取消：cancel() 立即停止，不阻塞 APP 主流程
 *  - 增量扫描：已有 id 默认跳过，只算新增照片
 *  - 自动降级：单批耗时过长自动缩小缩略图、降低批大小
 *  - 视频跳过：MVP 只处理图片
 */

import { decodePhoto, filterImages, photoId, classifyByMeta, canvasToURL } from './imaging.js';
import { analyze, verdict, duplicateIds, similarClusters, clusterEvents } from './cv.js';

export function createScanner() {
  let cancelled = false;
  let paused = false;
  return {
    cancel() { cancelled = true; },
    pause() { paused = true; },
    resume() { paused = false; },
    isCancelled: () => cancelled,
    isPaused: () => paused,
    _waitPause: async () => { while (paused && !cancelled) await sleep(120); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * @param {File[]} files
 * @param {object} opts { existing:Photo[], batchSize, thumbSize, onProgress, scanner }
 * @returns {Promise<{photos:Photo[], groups:EventGroup[], stats:object}>}
 */
export async function scanFiles(files, opts = {}) {
  const {
    existing = [],
    batchSize = 8,
    thumbSize = 256,
    onProgress = () => {},
    scanner = createScanner(),
    autoDowngrade = true,
  } = opts;

  const imgs = filterImages(files || []);
  const known = new Set(existing.map((p) => p.id));
  const pending = imgs.filter((f) => !known.has(photoId(f)));

  const total = pending.length;
  const photos = [...existing];
  const stats = { total: imgs.length, scanned: 0, skipped: known.size, failed: 0, downgraded: false };

  let bs = batchSize;
  const ts = thumbSize;   // 画质不接受性能降级：thumbSize 恒定，不再随设备变慢而下调

  for (let start = 0; start < total; start += bs) {
    if (scanner.isCancelled()) break;
    await scanner._waitPause();
    if (scanner.isCancelled()) break;

    const t0 = performance.now();
    const batch = pending.slice(start, start + bs);
    const out = [];
    for (const f of batch) {
      if (scanner.isCancelled()) break;
      try {
        out.push(await processOne(f, ts));
      } catch (e) {
        stats.failed++;
        console.warn('[scan] skip unreadable file', f?.name, e);
      }
      stats.scanned++;
    }
    photos.push(...out.filter(Boolean));
    onProgress({ done: stats.scanned, total, batch: out.length, failed: stats.failed });

    // 自动降级：单批超过 3.5s 判定设备吃力。
    // 🔴 P0 图片画质专项：降级**只允许缩小批大小（性能）**，
    //    绝不再缩 thumbSize —— 原来这里会把缩略图从 96 一路砍到 48，
    //    等于"设备一慢就把用户图片压更糊"，正是用户要禁掉的「默认全局有损压缩」。
    //    画质不接受性能降级；慢可以，糊不行。
    const cost = performance.now() - t0;
    if (autoDowngrade && cost > 3500 && bs > 2) {
      bs = Math.max(2, Math.floor(bs / 2));
      stats.downgraded = true;
    }
    await yieldFrame(); // 让出主线程，UI 不卡死
  }

  // 后处理：重复 / 相似 / 聚类
  const all = photos.slice();
  const dup = duplicateIds(all);
  const similar = similarClusters(all);
  const similarSet = new Set();
  for (const c of similar) c.forEach((id) => similarSet.add(id));

  for (const p of all) {
    p.isDuplicate = dup.has(p.id);
    p.isSimilar = similarSet.has(p.id) && !dup.has(p.id);
    const v = verdict(p.cv || {}, { isDuplicate: p.isDuplicate, isSimilar: p.isSimilar });
    p.verdict = v;
    p.score = v.score;
    p.verdictScore = v.score;
  }

  // 聚类排除：截图 / 极小图 默认不纳入故事推荐分组（方案兜底规则）
  const recommendable = all.filter((p) => !p.isTiny && !p.isScreenshot && !p.isDuplicate);
  const groups = clusterEvents(recommendable, { maxGapHours: 36, minSize: 1 });

  // 🔴 分组封面缩略图在**这里**补齐，而不是让每个调用方（app.js 的 runScan /
  //    regroup 按钮、自测脚本……）各自记得补一遍。
  //    原先由 app.js 事后补，结果任何绕过 app.js 的调用方拿到的分组都没有封面，
  //    分组卡直接退化成无封面版 —— 缺陷从"某处忘了调"变成"结构上不可能漏"。
  const byId = new Map(all.map((p) => [p.id, p]));
  for (const g of groups) g.coverThumb = byId.get(g.coverId)?.thumbUrl || null;

  return { photos: all, groups, stats, similar, cancelled: scanner.isCancelled() };
}

async function processOne(file, thumbSize) {
  const id = photoId(file);
  const d = await decodePhoto(file, thumbSize);
  const m = analyze(d.pixels, d.pw, d.ph);
  const meta = classifyByMeta(d.w, d.h, Boolean(d.takenAt));
  return {
    id,
    name: file.name,
    size: file.size,
    mtime: file.lastModified,
    takenAt: d.takenAt,
    lat: d.lat, lon: d.lon,
    w: d.w, h: d.h,
    // 🔴🔴 P0 图片画质专项 · 根因修复：
    //   这里之前**没有挂 `_file`** —— 于是导入后没有任何地方持有原图，
    //   查看器(srcOf)/导出(loadForExport)/大图预览/批量套用 全部回落到
    //   96px 缩略图 → 预览与导出全糊。测试之所以全绿，是 seed() 手工塞了 `_file`
    //   （典型的"测试在说谎"）。原图句柄是 File，只读引用、不复制数据，
    //   会话内存态、不落盘（stripRuntime 会剥离），撑 1 万张也只是 1 万个句柄。
    _file: file,
    thumbUrl: canvasToURL(d.thumbCanvas),
    dhash: m.dhash,
    exactHash: m.exactHash,
    cv: m,
    scene: m.scene,
    brightness: m.brightness,
    saturation: m.saturation,
    isTiny: meta.isTiny,
    isScreenshot: meta.isScreenshot,
    verdict: null,
    userOverride: null,
  };
}

/**
 * 重新聚类（用户手动拆分 / 合并 / 移除照片后调用）
 */
export function regroup(photos, opts = {}) {
  const recommendable = photos.filter((p) => !p.isTiny && !p.isScreenshot && !p.isDuplicate);
  const groups = clusterEvents(recommendable, opts);
  // 同 scanFiles：封面在这里补齐，调用方无需（也不该）再手工补
  const byId = new Map(recommendable.map((p) => [p.id, p]));
  for (const g of groups) g.coverThumb = byId.get(g.coverId)?.thumbUrl || null;
  return groups;
}
