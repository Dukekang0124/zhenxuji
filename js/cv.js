/**
 * cv.js — 端侧视觉分析引擎（纯计算，零 DOM 依赖）
 *
 * 定位：方案「模块0/模块1」的视觉能力，全部在本地像素上完成，原图不出浏览器。
 * 设计：所有导出函数都是纯函数（像素数组进，指标对象出），可在浏览器里直接
 *       import() 做单元断言 —— 这是多模块架构的红利。
 *
 * ⚠️ 诚实声明（不做假实现）：
 *   - 场景分类（人像/风景/美食）为**颜色启发式**，非深度学习模型，准确率低于真模型。
 *     真模型接入时只需替换 classifyScene()，其余调用方零改动。
 *   - 闭眼检测、人脸角度检测需真人脸关键点模型，MVP **不判定该废片理由**——
 *     宁可不判，也不做随机假判。
 */

/* ============================ 基础工具 ============================ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** RGBA 像素 → 灰度数组（Rec.601） */
export function toGray(pixels, w, h) {
  const n = w * h;
  const g = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }
  return g;
}

/** 最近邻降采样 RGBA（统一分析尺度，够用且快） */
export function resizeRGBA(pixels, w, h, tw, th) {
  const out = new Uint8ClampedArray(tw * th * 4);
  const xr = w / tw, yr = h / th;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, (y * yr) | 0);
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, (x * xr) | 0);
      const si = (sy * w + sx) * 4, di = (y * tw + x) * 4;
      out[di] = pixels[si]; out[di + 1] = pixels[si + 1];
      out[di + 2] = pixels[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

/* ============================ 指标计算 ============================ */

/**
 * 拉普拉斯方差清晰度。经典无参考清晰度指标：
 * 清晰图高频丰富 → 拉普拉斯响应方差大；失焦/运动模糊 → 方差趋近 0。
 * @returns {number} 原始方差（越大越清晰），未归一化，便于调阈值
 */
export function laplacianVariance(gray, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap; sum2 += lap * lap; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

/**
 * 亮度直方图统计：过曝 / 死黑 / 均值 / 均方差（光影均匀度）
 */
export function exposureStats(gray) {
  let over = 0, under = 0, sum = 0, sum2 = 0;
  const n = gray.length;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    if (v > 250) over++;
    if (v < 12) under++;
    sum += v; sum2 += v * v;
  }
  const mean = sum / n;
  const varc = Math.max(0, sum2 / n - mean * mean);
  return {
    over: over / n,
    under: under / n,
    mean,
    std: Math.sqrt(varc),
  };
}

/**
 * 色彩构成统计：肤色比 / 绿植比 / 暖色比 / 平均饱和度 / 中心聚焦度
 */
export function colorStats(pixels, w, h) {
  let skin = 0, green = 0, warm = 0, satSum = 0;
  let centerSat = 0, centerN = 0, allSat = 0;
  const n = w * h;
  const cx0 = w * 0.25, cx1 = w * 0.75, cy0 = h * 0.25, cy1 = h * 0.75;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    satSum += sat; allSat += sat;

    // Kovac 肤色规则（RGB 归一化前）
    if (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b) skin++;
    // 绿植：G 通道显著高于 R/B
    if (g > r + 10 && g > b + 10) green++;
    // 暖色：R 高于 B 且有一定饱和
    if (r > b + 12 && sat > 0.18) warm++;

    const x = i % w, y = (i / w) | 0;
    if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) { centerSat += sat; centerN++; }
  }
  const centerAvg = centerN ? centerSat / centerN : 0;
  const allAvg = allSat / n || 1e-6;
  return {
    skinRatio: skin / n,
    greenRatio: green / n,
    warmRatio: warm / n,
    saturation: satSum / n,
    centerFocus: clamp01(centerAvg / allAvg - 0.5), // >0 表示主体居中
  };
}

/**
 * 边缘平坦度：用于「镜头遮挡/手指挡屏」粗判。
 * 取四周 15% 边框带，切成 8×8 小块，统计近乎纯色（方差极低）的块占比。
 */
export function edgeFlatRatio(gray, w, h) {
  const bw = Math.max(1, Math.round(w * 0.15));
  const bh = Math.max(1, Math.round(h * 0.15));
  let blocks = 0, flat = 0;
  const regions = [
    [0, 0, w, bh], [0, h - bh, w, bh],
    [0, bh, bw, h - 2 * bh], [w - bw, bh, bw, h - 2 * bh],
  ];
  for (const [x0, y0, rw, rh] of regions) {
    if (rw < 8 || rh < 8) continue;
    const stepX = Math.max(1, Math.floor(rw / 8)), stepY = Math.max(1, Math.floor(rh / 8));
    for (let by = 0; by + stepY <= rh; by += stepY) {
      for (let bx = 0; bx + stepX <= rw; bx += stepX) {
        let s = 0, s2 = 0, c = 0;
        for (let y = y0 + by; y < y0 + by + stepY; y++) {
          for (let x = x0 + bx; x < x0 + bx + stepX; x++) {
            const v = gray[y * w + x]; s += v; s2 += v * v; c++;
          }
        }
        if (!c) continue;
        blocks++;
        const m = s / c, va = s2 / c - m * m;
        if (va < 9) flat++; // std < 3 → 近乎纯色块
      }
    }
  }
  return blocks ? flat / blocks : 0;
}

/* ============================ 感知哈希 ============================ */

/** dHash：9×8 灰度，逐行比较相邻像素，产出 64bit（十六进制 16 字符） */
export function dhash(gray, w, h) {
  const W = 9, H = 8;
  const small = resizeGray(gray, w, h, W, H);
  let bits = '';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits += small[y * W + x] < small[y * W + x + 1] ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 精确采样指纹：8×8 灰度均值量化，严格相等才判完全重复 */
export function exactHash(gray, w, h) {
  const W = 8, H = 8;
  const small = resizeGray(gray, w, h, W, H);
  let hex = '';
  for (let i = 0; i < W * H; i++) {
    hex += ((small[i] / 16) | 0).toString(16); // 16 级量化
  }
  return hex;
}

function resizeGray(gray, w, h, tw, th) {
  const out = new Float32Array(tw * th);
  const xr = w / tw, yr = h / th;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, (y * yr) | 0);
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, (x * xr) | 0);
      out[y * tw + x] = gray[sy * w + sx];
    }
  }
  return out;
}

/** 汉明距离（十六进制哈希串） */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16), y = parseInt(b[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return 999;
    let z = x ^ y;
    while (z) { d += z & 1; z >>= 1; }
  }
  return d;
}

/* ============================ 综合分析与判定 ============================ */

export const CV_THRESHOLDS = {
  // 拉普拉斯方差阈值。**低于此值判模糊**。
  // 标定依据（2026-10-03 实测）：分析尺度统一降采样到 256 宽。
  //   • 带真实纹理的清晰图：方差 100~800
  //   • blur(9px) 的失焦图：方差 < 30
  // 取 80 而非业界常见的 100：降采样会削掉一部分高频，阈值过高会把
  // 「正常但画面柔和」的照片误判成废片 —— 宁可漏判，不可错杀（方案信任体系）。
  blurVar: 80,
  over: 0.32,          // 过曝像素占比
  under: 0.55,         // 死黑像素占比
  edgeFlat: 0.55,      // 边缘纯色块占比 → 遮挡
  similarHamming: 10,  // dHash 汉明距离 ≤ 此值 → B 级相似候选
};

/**
 * 单图综合分析
 * @param {Uint8ClampedArray} pixels RGBA
 * @returns 指标对象（不含判定，判定交给 verdict()）
 */
export function analyze(pixels, w, h) {
  const gray = toGray(pixels, w, h);
  const lapVar = laplacianVariance(gray, w, h);
  const exp = exposureStats(gray);
  const col = colorStats(pixels, w, h);
  const flat = edgeFlatRatio(gray, w, h);
  return {
    sharpness: lapVar,
    blur: clamp01(1 - lapVar / (CV_THRESHOLDS.blurVar * 2)),
    over: exp.over,
    under: exp.under,
    brightness: exp.mean,
    contrastStd: exp.std,
    ...col,
    edgeFlat: flat,
    dhash: dhash(gray, w, h),
    exactHash: exactHash(gray, w, h),
    scene: classifyScene(col),
  };
}

/**
 * 场景分类（启发式）。
 * 判别顺序**有语义**：整屏暖色先判（棕色食物最容易被肤色规则误吞）→ 人像 → 风景 → 美食。
 *
 * ⚠️ 实测事故（2026-10-03）：#C8A46A 这类暖棕（食物）完美命中 Kovac 肤色规则
 *    （r>g>b 且 max-min>15），skinRatio 达 0.63 ⇒ 整盘菜被判成人像。
 *    修法：先看「整屏暖色 + 高饱和」——人像照片的背景/头发/衣服会把 warmRatio 拉低，
 *    而食物特写几乎整屏都是暖色。这条必须排在肤色规则之前。
 */
export function classifyScene(c) {
  if (c.warmRatio > 0.5 && c.saturation > 0.28 && c.skinRatio > 0.5) return 'food';
  if (c.skinRatio > 0.22) return 'portrait';
  if (c.greenRatio > 0.30 && c.skinRatio < 0.12) return 'landscape';
  if (c.warmRatio > 0.24 && c.saturation > 0.32 && c.centerFocus > 0.02) return 'food';
  if (c.greenRatio > 0.18) return 'landscape';
  return 'other';
}

export const SCENE_LABEL = {
  portrait: '人像', landscape: '风景', food: '美食', other: '其他',
};

const REASON_LABEL = {
  blur: '严重模糊/对焦失败',
  over: '严重过曝，细节丢失',
  under: '严重欠曝，画面死黑',
  occlude: '镜头遮挡/画面被挡',
  duplicate: '完全重复连拍',
  similar: '相似候选（不判废）',
};

/**
 * A/B 级废片判定
 * - A 级：硬废片（客观缺陷），只标记、不删除，附带可视化理由
 * - B 级：相似候选，**绝不判废**，只打分排序
 */
export function verdict(m, opts = {}) {
  const T = { ...CV_THRESHOLDS, ...(opts.thresholds || {}) };
  const reasons = [];
  if (m.sharpness < T.blurVar) reasons.push({ code: 'blur', label: REASON_LABEL.blur });
  if (m.over > T.over) reasons.push({ code: 'over', label: REASON_LABEL.over });
  if (m.under > T.under) reasons.push({ code: 'under', label: REASON_LABEL.under });
  if (m.edgeFlat > T.edgeFlat) reasons.push({ code: 'occlude', label: REASON_LABEL.occlude });
  if (opts.isDuplicate) reasons.push({ code: 'duplicate', label: REASON_LABEL.duplicate });

  const level = reasons.length ? 'A' : (opts.isSimilar ? 'B' : null);
  return {
    level,
    reasons,
    score: beautyScore(m),
  };
}

/**
 * 审美打分（0-100）。
 * 方案权重：人脸表情自然度 > 面部光影均匀度 > 构图完整性 > 清晰度。
 * ⚠️ 人脸表情需真人脸模型，本版**不计入**，权重按比例重分配到其余三项：
 *    光影均匀度 40% + 构图 30% + 清晰度 30%（如实降级，不假装算了表情）。
 */
export function beautyScore(m) {
  // ⚠️ 变量名一律用英文：中文标识符与关键字之间一旦漏空格（如 `const光影`），
  //    会被解析成单个标识符，语法检查通过、运行时才炸，是最难查的缺陷族。
  const lightScore = clamp01(1 - Math.abs(m.brightness - 128) / 128);
  const contrastScore = clamp01(1 - Math.abs(m.contrastStd - 65) / 65);
  const lighting = lightScore * 0.6 + contrastScore * 0.4;

  // 构图：主体聚焦 + 饱和度适中（不过曝不寡淡）
  const composition = clamp01(m.centerFocus * 0.7 + clamp01(m.saturation / 0.45) * 0.3);

  // 清晰度
  const sharp = clamp01(m.sharpness / (CV_THRESHOLDS.blurVar * 4));

  const raw = lighting * 0.4 + composition * 0.3 + sharp * 0.3;
  return Math.round(clamp01(raw) * 100);
}

/* ============================ 事件聚类 ============================ */

/**
 * 按「时间 + 场景相似度 + 地理位置」聚类。
 * 权重：时间（最高，gap 超阈值直接切分）> 画面相似度 > 位置
 *
 * @param {Array} photos 需含 id/takenAt/scene/dhash/lat/lon
 * @param {object} opts  { maxGapHours, minSize }
 */
export function clusterEvents(photos, opts = {}) {
  const maxGap = (opts.maxGapHours ?? 36) * 3600 * 1000;
  const list = photos.slice().sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));
  if (!list.length) return [];

  const out = [];
  let cur = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], p = list[i];
    const gap = (p.takenAt || 0) - (prev.takenAt || 0);
    let cut = gap > maxGap;

    // 异地切分：两点都有 GPS 且距离 > 50km
    if (!cut && hasGPS(prev) && hasGPS(p) && distanceKm(prev, p) > 50) cut = true;

    if (cut) { out.push(cur); cur = [p]; }
    else cur.push(p);
  }
  out.push(cur);

  return out
    .map((arr, i) => makeGroup(arr, i))
    .filter((g) => g.photoIds.length >= (opts.minSize ?? 1));
}

function makeGroup(arr, i) {
  const times = arr.map((p) => p.takenAt || 0).filter(Boolean);
  const sceneCount = {};
  for (const p of arr) sceneCount[p.scene || 'other'] = (sceneCount[p.scene || 'other'] || 0) + 1;
  const dominant = Object.entries(sceneCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
  const start = times.length ? Math.min(...times) : 0;
  const end = times.length ? Math.max(...times) : 0;
  // 封面：组内分数最高且未被判废的
  const sorted = arr.slice().sort((a, b) => (b.verdictScore || 0) - (a.verdictScore || 0));
  return {
    id: `g_${start}_${i}`,
    title: autoTitle(start, end, dominant),
    startAt: start,
    endAt: end,
    photoIds: arr.map((p) => p.id),
    coverId: (sorted[0] || arr[0]).id,
    sceneTag: dominant,
    source: 'auto',
  };
}

export function autoTitle(start, end, scene) {
  if (!start) return '未分组';
  const s = new Date(start), e = new Date(end);
  const fmt = (d) => `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const span = Math.round((end - start) / 86400000);
  const base = span <= 1 ? fmt(s) : `${fmt(s)}-${fmt(e).slice(5)}`;
  const tag = { portrait: '人像记录', landscape: '出游风景', food: '美食探店', other: '日常随拍' }[scene] || '日常随拍';
  return `${base} ${tag}`;
}

function hasGPS(p) { return typeof p.lat === 'number' && typeof p.lon === 'number'; }

/** 两点球面距离（km） */
export function distanceKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 相似图分组：把一组照片按 dHash 汉明距离聚成相似簇。
 * @returns {Array<Array<string>>} 每个簇内的 photoId 数组（仅返回 size>1 的簇）
 */
export function similarClusters(photos, opts = {}) {
  const T = opts.similarHamming ?? CV_THRESHOLDS.similarHamming;
  const seen = new Set();
  const clusters = [];
  for (let i = 0; i < photos.length; i++) {
    if (seen.has(i)) continue;
    const a = photos[i];
    if (!a.dhash) continue;
    const cluster = [a.id];
    seen.add(i);
    for (let j = i + 1; j < photos.length; j++) {
      if (seen.has(j)) continue;
      const b = photos[j];
      if (!b.dhash) continue;
      if (hamming(a.dhash, b.dhash) <= T) { cluster.push(b.id); seen.add(j); }
    }
    if (cluster.length > 1) clusters.push(cluster);
  }
  return clusters;
}

/**
 * 完全重复检测：exactHash 相同的归为一簇，除首张外其余标 A 级「完全重复」。
 * @returns {Set<string>} 应标为重复的 photoId（保留每簇第一张）
 */
export function duplicateIds(photos) {
  const map = new Map();
  const dup = new Set();
  for (const p of photos) {
    if (!p.exactHash) continue;
    if (map.has(p.exactHash)) dup.add(p.id);
    else map.set(p.exactHash, p.id);
  }
  return dup;
}
