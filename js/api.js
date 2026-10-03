/**
 * api.js — ★唯一知道「数据从哪来」的契约层
 *
 * 纪律（换真后端时只改本文件，其余零改动）：
 *  1. 永不抛错：所有失败归一成 { ok:false, code }，降级交给调用方。
 *  2. 全程 trace：每次调用记录 stage/ok/code/ms/model，可观测。
 *  3. 失败分类：按前缀决定能不能重试（见 isRetryable）。
 *  4. 隐私硬约束：只传结构化标签，绝不传图片二进制/原图。
 *
 * 三层兜底语义（关键，别把三件事混为一谈）：
 *  ① 模型答了        → 归一化后返回
 *  ② 模型没答好      → 本地规则引擎兜底（code 非结构性）
 *  ③ 通道结构性不可用 → 本地规则引擎（code 结构性：未配置/已禁用/无网络能力）
 */

import { SYSTEM_TEXT, buildStoryPrompt, localStory } from './prompts.js';
import { validateShape, tolerantParse, normalizeStory } from './ai.js';
import { resolveApiBase } from './runtime.js';

// 🔴 前端**永不直连模型厂商、永不持有密钥、永不指定模型名**。
//    用哪个模型、按什么顺序降级、超时多少 —— 全部由服务端 worker/llm.config.js 决定。
//    前端只说「模块名」，因此后端换冠军模型时前端一行不改、不出新版 APK。
export const MAX_REGEN = 3; // 方案限流：单次手记最多 3 次 AI 重生成

const trace = [];
const regenCount = new Map(); // storyId → 已重生成次数

export function debug() {
  return { trace: trace.slice(-20), regen: Object.fromEntries(regenCount) };
}

function push(t) {
  trace.push({ at: Date.now(), ...t });
  if (trace.length > 200) trace.shift();
  return t;
}

/** 结构性不可用 = 根本没有模型可问（区别于"模型答错了"） */
const STRUCTURAL = ['provider_disabled', 'provider_unconfigured', 'sdk_unavailable'];
export function isStructural(code) { return STRUCTURAL.includes(String(code || '')); }

/**
 * 按前缀分类：不是所有错误都该重试。
 *
 * 🔴 2026-10-03 真实事故（0.6.0 首次带上后端地址后暴露）：
 *    这里原来把 `network_*` 一律当可重试 —— 于是**端点不可达**时也会再试一次，
 *    而重试同一个不可达地址在物理上不可能成功。代价是用户拿到本地文案的时间
 *    从「1×超时」变成「2×超时」（实测 14.6s → 14.9s 含两次，最坏近 29s）。
 *    `network_error` 是传输层失败（DNS/连接被拒/TLS 失败），必须**不重试**；
 *    `network_timeout` 才是「对方还在想」这种可能自己好的情况，保留重试。
 */
export function isRetryable(code) {
  const c = String(code || '');
  if (c.startsWith('auth_') || c.startsWith('quota_') || c.startsWith('request_')) return false;
  if (c === 'network_error') return false;          // 端点不可达，重试零收益
  return c.startsWith('network_') || c.startsWith('gateway_') || c.startsWith('model_') || c.startsWith('internal_');
}

/** 用户输入进 Prompt 前必须清洗（提示注入防护） */
export function sanitizeInput(text, max = 2000) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/"{3,}/g, '"')
    .replace(/\{\{|\}\}/g, '')
    .slice(0, max);
}

/* ==================== 主入口 ==================== */

/**
 * 生成手记文案。
 * @param {object} tags  结构化标签（extractTags 产出）
 * @param {object} settings { aiTextEnabled, glmEndpoint, ... }
 * @param {object} opts { storyId, force, apiBase }
 *         apiBase 显式指定后端根地址（测试/特殊场景用）；不传则按
 *         「用户填的 > 内置默认」自动解析（见 js/runtime.js）
 * @returns {Promise<{ok,data,code,source,ms,degraded}>}
 */
export async function generateStory(tags, settings = {}, opts = {}) {
  const t0 = Date.now();
  const storyId = opts.storyId || 'default';

  // ③ 通道结构性不可用
  // 🔴 这三条降级**不给用户看**（degraded 为空串）。理由：
  //    它们对用户没有可操作性 —— "你关掉了 AI 文案"用户自己知道（设置页有开关状态）；
  //    "后端没配好"是产品自己的事，甩给用户只会让人以为 App 坏了。
  //    而旧文案「未配置模型服务地址，使用本地文案」还把实现细节（服务地址）
  //    直接摊在界面上，违反方案 §5.4「普通用户看不到一切技术内容」——
  //    真机截图就是这么暴露出来的。
  if (settings.aiTextEnabled === false) {
    return local(tags, 'provider_disabled', t0, '');
  }
  const base = opts.apiBase !== undefined
    ? opts.apiBase
    : resolveApiBase({ configured: settings.glmEndpoint });
  if (!base) {
    return local(tags, 'provider_unconfigured', t0, '');
  }

  // 限流：单次手记最多 MAX_REGEN 次
  const used = regenCount.get(storyId) || 0;
  if (!opts.force && used >= MAX_REGEN) {
    return local(tags, 'quota_regen_limit', t0, `这条已经重新生成过 ${MAX_REGEN} 次啦，先用本地文案`);
  }

  const url = base.replace(/\/+$/, '') + '/api/story';

  let last = null;
  const attempts = 2; // 首次 + 最多 1 次重试（仅瞬时故障）
  for (let i = 0; i < attempts; i++) {
    const r = await callStoryService(url, sanitizeTags(tags), i);
    if (r.ok) {
      const parsed = tolerantParse(r.text, 'story');
      if (parsed.ok) {
        regenCount.set(storyId, used + 1);
        // 🔴 source 不再硬编码 'glm' —— 后端已从单厂商扩到四家异构
        //    （OpenRouter / 商汤 / Agnes / 智谱），写死 'glm' 就是在对上层说谎。
        //    统一用 'ai' 表示"模型生成"，具体是哪家看 provider/model 字段；
        //    本地兜底仍是 'local'。上层只需判 source === 'local' 即可区分。
        push({ stage: 'story', ok: true, code: 'ok', ms: Date.now() - t0,
               model: r.model || 'unknown', provider: r.provider || '',
               attempt: i, degraded: Boolean(r.degraded) });
        return {
          ok: true, code: 'ok', source: 'ai', degraded: '',
          model: r.model || '', provider: r.provider || '',
          ms: Date.now() - t0,
          data: normalizeStory(parsed.data, tags),
        };
      }
      last = { code: parsed.code || 'parse_failed' };
      push({ stage: 'story', ok: false, code: last.code, ms: Date.now() - t0, attempt: i });
      if (!isRetryable(last.code)) break;
      continue;
    }
    last = r;
    push({ stage: 'story', ok: false, code: r.code, ms: Date.now() - t0, attempt: i });
    if (!isRetryable(r.code)) break;
  }

  // ② 模型该答没答好 → 本地兜底（这条要如实说，但用用户能懂的话，不报内部错误码）
  return local(tags, last?.code || 'unknown', t0, 'AI 这次没答上来，先用本地文案帮你写好了');
}

async function callStoryService(url, tags, attempt) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000); // 15s 超时，不阻塞主流程
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },  // 🔴 不带任何鉴权头：密钥只在服务端
      body: JSON.stringify(tags),                       // 只传结构化标签，绝不传原图
    });
    // 服务端已跑完优先级链与降级，前端只看结果
    if (!res.ok) return { ok: false, code: 'gateway_error', status: res.status };
    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, code: 'bad_response' };
    if (json.ok === false) return { ok: false, code: json.code || 'gateway_error' };
    if (!json.content) return { ok: false, code: 'model_empty' };
    return {
      ok: true, text: json.content, ms: json.ms ?? (Date.now() - t0),
      model: json.model, provider: json.provider, degraded: json.degraded, tried: json.tried,
    };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, code: 'network_timeout' };
    return { ok: false, code: 'network_error', message: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttp(status, body) {
  if (status === 401 || status === 403) return { ok: false, code: 'auth_rejected', status };
  if (status === 429) return { ok: false, code: 'quota_exceeded', status };
  if (status >= 500) return { ok: false, code: 'gateway_error', status };
  if (status >= 400) return { ok: false, code: 'request_rejected', status, body: String(body).slice(0, 200) };
  return { ok: false, code: 'internal_error', status };
}

function sanitizeTags(tags) {
  const t = tags || {};
  return {
    scene: sanitizeInput(t.scene, 20),
    dateText: sanitizeInput(t.dateText, 40),
    count: Number(t.count) || 0,
    keywords: (Array.isArray(t.keywords) ? t.keywords : []).slice(0, 20).map((k) => sanitizeInput(k, 20)),
    mood: sanitizeInput(t.mood, 20),
    place: sanitizeInput(t.place, 40),
  };
}

function local(tags, code, t0, degraded) {
  push({ stage: 'story', ok: false, code, ms: Date.now() - t0, structural: isStructural(code) });
  return {
    ok: true,               // 对调用方而言产品仍可用
    code,
    source: 'local',
    degraded,
    structural: isStructural(code),
    ms: Date.now() - t0,
    data: normalizeStory(localStory(tags), tags),
  };
}

/** 重置某篇手记的重生成计数（新建手记时调用） */
export function resetRegen(storyId) { regenCount.delete(storyId); }

/**
 * 分享页数据上报（MVP：本地模拟 + 预留 Worker 端点）
 * 未配置 endpoint 时走本地计数器，数据不丢、可离线。
 */
export async function reportShare(storyId, settings = {}) {
  const endpoint = (settings.shareEndpoint || '').trim();
  if (!endpoint) return { ok: false, code: 'provider_unconfigured' };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyId }),
    });
    return { ok: res.ok, code: res.ok ? 'ok' : 'gateway_error' };
  } catch (e) {
    return { ok: false, code: 'network_error' };
  }
}
