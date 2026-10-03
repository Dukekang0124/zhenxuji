/**
 * 帧叙集 Worker — 统一模型入口 + 分享页数据
 *
 * 存在的理由：
 *  1. 密钥零泄漏：前端永远拿不到 Key，也拿不到 endpoint。Key 只在 Worker secret。
 *  2. 换模型不改前端：前端只说「模块名」，后端换冠军模型前端零改动、不出新版 APK。
 *  3. 分享页数据：H5 手记的点赞/留言存储。
 *
 * 安全约束：
 *  - Origin 精确白名单（不限 Origin 等于把接口公开给人刷）。
 *  - 只接受结构化标签 / 文本，**拒绝图片二进制**。
 *  - 回包不含 endpoint、不含 key、不含用户正文日志。
 */

import { route, getStats, configSnapshot, loadConfig } from './llm-router.js';
import cfg from './llm.config.js';

const ALLOWED_ORIGINS = [
  'https://zhenxuji.pages.dev',
  'http://127.0.0.1:4188',
  'http://localhost:4188',
  // 🔴 APK 端：Capacitor Android 的 WebView origin 固定为 https://localhost
  //    （capacitor.config.json 里 androidScheme=https）。漏了这条 → 打出来的
  //    APK 调任何接口都会被 403 origin_not_allowed 拦死，且只在真机上暴露。
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];

const RATE_MAX = 30;
const RATE_WINDOW = 60000;
const rate = new Map();

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return new Response('', { headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin_not_allowed' }, 403, cors);

    const url = new URL(req.url);
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    if (!rateOk(ip)) return json({ error: 'rate_limited' }, 429, cors);

    // 密钥只从 env 读（Worker secret），配置里只有 env 的名字。
    // 🔴 四家异构厂商：名字必须与 llm.config.js 的 providers[].keyEnvs 严格一致。
    //    名字对不上 → resolveCandidates() 找不到 key → 整条优先级链被剃空 →
    //    线上表现为「永远 degraded、永远出兜底文案」，而且不报错。
    const keys = {
      GLM_KEY_53: env.GLM_KEY_53,   // OpenRouter — GLM-5.3-Flash（思考模型，主力档）
      SN_KEY: env.SN_KEY,           // 商汤 SenseNova — deepseek-v4-flash
      AG_KEY: env.AG_KEY,           // Agnes AI Hub — agnes-2.5-flash
      GLM_KEY_4F: env.GLM_KEY_4F,   // 智谱开放平台 — GLM-4-Flash（兜底档）
    };

    try {
      if (url.pathname === '/api/llm' && req.method === 'POST') return await handleLLM(req, keys, cors);
      if (url.pathname === '/api/llm/config') return json(configSnapshot(cfg, env), 200, cors);
      if (url.pathname === '/api/llm/stats') return json(getStats(), 200, cors);
      if (url.pathname === '/api/story' && req.method === 'POST') return await handleStory(req, keys, cors);
      if (url.pathname.startsWith('/api/share/')) return await handleShare(req, env, url, cors);
      // 版本配置（方案 §2.9.8）：APK 走 /version.json 由 Cloudflare 静态托管；
      // 这里再兜一个 /api/version，保证 Workers 部署形态下也能读到同一份配置。
      if (url.pathname === '/api/version') return handleVersion(env, cors);
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ error: 'internal_error', message: String(e?.message || e) }, 500, cors);
    }
  },
};

/* ---------------- 版本配置（方案 §2.9.8） ---------------- */

/**
 * 版本信息来源优先级：
 *   ① KV 绑定 APP_VERSION_KV 的 'current'（改版本不用重新部署 Worker）
 *   ② env.VERSION_JSON 里的静态 JSON（兜底）
 *   ③ 硬编码兜底值（保证端侧永远拿得到合法结构，不会 404）
 *
 * 🔴 无论哪条路径，出口都必须过一次 normalizeVersion —— 脏配置会让端侧解析失败，
 *    而"检查更新"失败对普通用户是莫名其妙的坏体验。
 */
const FALLBACK_VERSION = {
  latest_version: '0.3.1',
  is_force: false,
  update_url: '',
  update_content: '这次主要是修了一些小问题，让用起来更顺手。',
  update_time: '2026-10',
};

function normalizeVersion(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const ver = String(o.latest_version || '').trim();
  return {
    latest_version: /^\d+(\.\d+){0,3}$/.test(ver) ? ver : FALLBACK_VERSION.latest_version,
    // 🔴 is_force 必须严格是布尔 true：字符串 "true"/1 都当 false，
    //    否则运营手滑就能把全量用户卡在强制更新上（风险最高的一个字段）。
    is_force: o.is_force === true,
    update_url: String(o.update_url || '').slice(0, 500),
    update_content: String(o.update_content || FALLBACK_VERSION.update_content).slice(0, 600),
    update_time: String(o.update_time || '').slice(0, 40),
  };
}

async function handleVersion(env, cors) {
  let raw = null;

  // ① KV（可能未绑定）
  try {
    if (env?.APP_VERSION_KV) raw = await env.APP_VERSION_KV.get('current', 'json');
  } catch (_) { /* KV 未绑定或读取失败 → 往下走 */ }

  // ② env 静态 JSON
  if (!raw && env?.VERSION_JSON) {
    try { raw = JSON.parse(env.VERSION_JSON); } catch (_) { raw = null; }
  }

  // ③ 兜底
  const body = normalizeVersion(raw || FALLBACK_VERSION);
  // 强制更新时必须带下载地址，否则端侧点了没反应
  if (body.is_force && !body.update_url) body.is_force = false;

  return json(body, 200, {
    ...cors,
    // 版本配置要能被 CDN 缓存 5 分钟，避免每次冷启动都回源
    'Cache-Control': 'public, max-age=300',
  });
}

/* ---------------- 统一模型入口 ---------------- */

async function handleLLM(req, keys, cors) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ error: 'invalid_body' }, 400, cors);

  const moduleName = String(b.module || 'default');
  if (!(cfg.modules && cfg.modules[moduleName])) {
    return json({ error: 'module_not_allowed', module: moduleName }, 400, cors);
  }

  const r = await route(loadConfig(cfg), keys, {
    module: moduleName,
    system: String(b.system || '').slice(0, 4000),
    user: String(b.user || '').slice(0, 8000),
    temperature: Number(b.temperature) || undefined,
    maxTokens: Number(b.maxTokens) || undefined,
    json: Boolean(b.json),
  });

  // 回包只给可观测信息：用了谁、降没降级、试过谁。**不给 endpoint、不给 key**
  return json({
    ok: r.ok, text: r.text, model: r.model, provider: r.provider, tier: r.tier,
    degraded: r.degraded, attempts: r.attempts, ms: r.ms, code: r.code, tried: r.tried,
  }, r.ok ? 200 : 502, cors);
}

/* ---------------- 手记文案（业务封装，内部走同一收口） ---------------- */

async function handleStory(req, keys, cors) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ error: 'invalid_body' }, 400, cors);

  // 白名单：只转发结构化标签，绝不转发图片二进制
  const tags = {
    scene: str(b.scene, 20),
    dateText: str(b.dateText, 40),
    count: Number(b.count) || 0,
    keywords: Array.isArray(b.keywords) ? b.keywords.slice(0, 20).map((k) => str(k, 20)) : [],
    mood: str(b.mood, 20),
    place: str(b.place, 40),
  };

  const system = '你是极简生活故事文案助手，输出风格温柔、克制、高级、不网红、不矫情。\n'
    + '输出内容包含：封面标题、配图短句、朋友圈正文、互动钩子。\n'
    + '固定输出JSON格式，无多余文字、无解释、无废话。';
  const user = [
    `场景：${tags.scene}`, `时间：${tags.dateText}`, `照片数量：${tags.count}`,
    `画面关键词：${tags.keywords.join('、') || '无'}`, `情绪基调：${tags.mood}`,
    '',
    '严格输出 JSON，字段：cover、captions、body、hook。不要解释，不要 markdown 代码块。',
  ].join('\n');

  const r = await route(loadConfig(cfg), keys, {
    module: 'story', system, user, maxTokens: 900,
  });

  return json({
    ok: r.ok, content: r.text, model: r.model, provider: r.provider,
    degraded: r.degraded, ms: r.ms, code: r.code, tried: r.tried,
  }, r.ok ? 200 : 502, cors);
}

/* ---------------- 分享页数据 ---------------- */

async function handleShare(req, env, url, cors) {
  const id = url.pathname.split('/').pop() || '';
  if (!/^[\w-]{1,64}$/.test(id)) return json({ error: 'bad_id' }, 400, cors);

  if (req.method === 'GET') {
    const raw = await env.SHARE?.get(`share:${id}`);
    const d = raw ? JSON.parse(raw) : { views: 0, likes: 0, comments: [] };
    d.views = (d.views || 0) + 1;
    await env.SHARE?.put(`share:${id}`, JSON.stringify(d));
    return json(d, 200, cors);
  }
  if (req.method === 'POST') {
    const b = await req.json().catch(() => null);
    if (!b) return json({ error: 'invalid_body' }, 400, cors);
    const raw = await env.SHARE?.get(`share:${id}`);
    const d = raw ? JSON.parse(raw) : { views: 0, likes: 0, comments: [] };
    if (b.like) d.likes = (d.likes || 0) + 1;
    if (typeof b.comment === 'string' && b.comment.trim()) {
      d.comments = [...(d.comments || []), { text: str(b.comment, 200), at: Date.now() }].slice(-50);
    }
    await env.SHARE?.put(`share:${id}`, JSON.stringify(d));
    return json(d, 200, cors);
  }
  return json({ error: 'method_not_allowed' }, 405, cors);
}

/* ---------------- 工具 ---------------- */

function rateOk(ip) {
  const now = Date.now();
  const rec = rate.get(ip);
  if (!rec || now - rec.t > RATE_WINDOW) { rate.set(ip, { t: now, n: 1 }); return true; }
  if (rec.n >= RATE_MAX) return false;
  rec.n++;
  return true;
}

function str(v, max) { return String(v == null ? '' : v).slice(0, max); }

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}
