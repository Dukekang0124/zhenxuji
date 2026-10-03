/**
 * ai.js — 本地规则引擎：排序、标签抽取、契约校验、文案归一化
 *
 * 纪律：
 *  - 本文件是**确定性兜底**，本身就是完整实现，不是残废保底。
 *  - 非法输入不抛错：validateShape 缺字段补默认，safeJsonParse 异常兜底。
 *  - 不关心文案从哪来（那是 api.js 的事），只负责消费与校验。
 */

import { STORY_SHAPE, localStory, findForbidden, scrubForbidden, SYSTEM_TEXT } from './prompts.js';
import { SCENE_LABEL } from './cv.js';

/* ==================== 契约校验 ==================== */

/**
 * 补齐缺失字段，绝不抛错。
 * @param {'story'} type
 */
export function validateShape(type, obj) {
  const o = (obj && typeof obj === 'object') ? obj : {};
  if (type === 'story') {
    const rawCaps = Array.isArray(o.captions) ? o.captions.map((x) => String(x || '')).filter(Boolean) : [];
    return {
      ...STORY_SHAPE,
      ...o,
      cover: String(o.cover || STORY_SHAPE.cover || '').slice(0, 24) || '日常的一页',
      captions: rawCaps.length ? rawCaps.map((c) => scrubForbidden(c).slice(0, 40)) : ['留个纪念'],
      body: scrubForbidden(String(o.body || '')).slice(0, 300) || '一些细碎的光，记下来。',
      hook: scrubForbidden(String(o.hook || '')).slice(0, 40) || '你最近也这样吗？',
    };
  }
  return { ...o };
}

/** 安全解析：任何异常都返回兜底对象，前端永不崩 */
export function safeJsonParse(str, type = 'story') {
  try {
    const cleaned = String(str || '')
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    const obj = JSON.parse(cleaned);
    return { ok: true, data: validateShape(type, obj) };
  } catch (e) {
    return { ok: false, code: 'parse_failed', data: validateShape(type, null) };
  }
}

/**
 * 截断容忍解析：模型输出被 max_tokens 截成半截时，从尾部回退补全括号栈。
 * 这是防「正常输入被误判为失败」的关键兜底。
 */
export function tolerantParse(str, type = 'story') {
  const direct = safeJsonParse(str, type);
  if (direct.ok) return direct;
  let s = String(str || '').trim();
  for (let back = 0; back < 200 && s.length > 0; back++) {
    // 补全未闭合的引号与括号
    const quote = (s.match(/"/g) || []).length;
    let fixed = s;
    if (quote % 2 === 1) fixed += '"';
    const open = (fixed.match(/[{[]/g) || []).length;
    const close = (fixed.match(/[}\]]/g) || []).length;
    for (let i = 0; i < open - close; i++) fixed += '}';
    const r = safeJsonParse(fixed, type);
    if (r.ok) return { ...r, repaired: true };
    s = s.slice(0, -1);
  }
  return { ok: false, code: 'unrepairable', data: validateShape(type, null) };
}

/* ==================== 排序 ==================== */

/**
 * 时间排序
 */
export function timeOrder(photos) {
  return photos.slice().sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));
}

/**
 * AI 叙事逻辑排序：风景开场 → 人像 → 细节 → 美食 → 收尾
 * 段内再按分数降序（好的先出）。
 */
const NARRATIVE_RANK = { landscape: 0, portrait: 1, other: 2, food: 3 };

export function narrativeOrder(photos) {
  return photos.slice().sort((a, b) => {
    const ra = NARRATIVE_RANK[a.scene] ?? 9;
    const rb = NARRATIVE_RANK[b.scene] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.score || 0) - (a.score || 0);
  });
}

/* ==================== 标签抽取（喂给 GLM 的唯一内容） ==================== */

/**
 * 从照片元数据抽取结构化标签。
 * ⚠️ 硬约束：只传标签，**绝不传图片二进制/原图**。
 */
export function extractTags(photos, group) {
  const list = photos || [];
  const sceneCount = {};
  for (const p of list) {
    const s = p.scene || 'other';
    sceneCount[s] = (sceneCount[s] || 0) + 1;
  }
  const dominant = Object.entries(sceneCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
  const times = list.map((p) => p.takenAt).filter(Boolean);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) : null;

  const keywords = [];
  const push = (w) => { if (w && !keywords.includes(w)) keywords.push(w); };
  for (const s of Object.keys(sceneCount)) push(SCENE_LABEL[s]);
  const hasGPS = list.some((p) => typeof p.lat === 'number');
  if (hasGPS) push('有位置信息');
  const brightAvg = list.length ? list.reduce((a, p) => a + (p.brightness || 0), 0) / list.length : 0;
  if (brightAvg > 160) push('明亮'); else if (brightAvg < 90) push('偏暗');
  const satAvg = list.length ? list.reduce((a, p) => a + (p.saturation || 0), 0) / list.length : 0;
  if (satAvg > 0.35) push('色彩浓郁'); else push('色调清淡');

  return {
    scene: SCENE_LABEL[dominant] || '日常',
    sceneKey: dominant,
    dateText: start ? dateRangeText(start, end) : '',
    count: list.length,
    keywords,
    place: '',
    mood: satAvg > 0.35 ? '轻快' : '平和',
  };
}

export function dateRangeText(start, end) {
  const f = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  if (!start) return '';
  if (!end || sameDay(start, end)) return f(start);
  return `${f(start)}—${f(end)}`;
}

function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/* ==================== 文案消费 ==================== */

/** 统一出口：任何来源的文案都过这里，保证禁词被清掉、字段齐全 */
export function normalizeStory(raw, tags) {
  const base = validateShape('story', raw);
  const bad = findForbidden([base.cover, base.body, base.hook, ...base.captions].join(' '));
  if (bad.length) {
    return {
      ...base,
      cover: scrubForbidden(base.cover),
      body: scrubForbidden(base.body),
      hook: scrubForbidden(base.hook),
      captions: base.captions.map(scrubForbidden),
      _scrubbed: bad,
    };
  }
  return base;
}

/**
 * 纯本地生成（无网络 / 未配 Key / 用户关闭 AI 开关时的路径）
 */
export function localStoryOf(tags) {
  return normalizeStory(localStory(tags), tags);
}

/** 供测试与调试：系统提示词是否按方案定稿 */
export const SYSTEM_PROMPT = SYSTEM_TEXT;
