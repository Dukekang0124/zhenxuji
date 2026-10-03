/**
 * llm-router.js — 模型调度核心（配置驱动 + 优先级链 + 自动降级）
 *
 * 三层分离：
 *   第一层 密钥   → env（Worker secret：GLM_KEY_53 / SN_KEY / AG_KEY / GLM_KEY_4F），
 *                  绝不进配置文件、绝不进代码
 *   第二层 结构   → llm.config.js（provider/顺序/超时/降级条件，改它即可，本文件不动）
 *   第三层 环境   → LLM_DISABLE_MODELS（灰度摘模型）；本地可读 process.env
 *
 * 关键纪律（每条都对应一个真实踩过的坑）：
 *  1. 解析期过滤：不可用条目在**建链时**就剔除，一次注定失败的请求也是延迟。
 *  2. 重试 ≠ 降级：瞬时故障(限流/5xx/超时)才在同一模型上重试；
 *     参数错/模型不存在/余额不足/鉴权失败 → 直接换档，重试一百次结果一样。
 *  3. 厂商私有码必须归一成通用码，否则 degradeOn 要为每家厂商写一遍；
 *     且归一必须带 provider 前缀（四家异构后 429/402 各表各义）。
 *  4. tried[] 必须带 provider，否则排障时答不出"是谁挂了"。
 *  5. 日志不写用户正文。
 *  6. 🔴 思考模型（GLM-5.3-Flash）的 content 可能为 null，正文在 reasoning 字段，
 *     且推理会吃满 max_tokens。不回退 + 不放大 = 最高优先档永远形同不存在。
 */

import cfg from './llm.config.js';

/* ---------------- 配置装载 ---------------- */

export function loadConfig(raw) {
  return raw ? JSON.parse(JSON.stringify(raw)) : cfg;
}

const disabledFromEnv = () =>
  String(process.env.LLM_DISABLE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);

/* ---------------- 厂商码归一 ---------------- */

export function normalizeCode(status, vendorCode, msg = '', provider = '') {
  const map = cfg.vendorCodes || {};
  const vc = String(vendorCode ?? '');
  // 🔴 两级查表：先查「厂商:码」（不同厂商同一个数字含义完全不同，不加前缀会互相覆盖），
  //    再退回裸码（智谱的数字码是全局唯一的，历史配置依赖裸码，不能一刀切删掉）。
  if (vc) {
    if (provider && map[`${provider}:${vc}`]) return map[`${provider}:${vc}`];
    if (map[vc]) return map[vc];
  }

  const s = String(msg || '');
  // 中文厂商的错误描述（智谱为主）
  if (s.includes('余额不足') || s.includes('无可用资源包')) return 'quota_exhausted';
  if (s.includes('限流') || s.includes('并发')) return 'rate_limited';
  if (s.includes('模型不存在')) return 'model_not_found';
  if (s.includes('令牌') || s.includes('鉴权') || s.includes('过期')) return 'auth_failed';
  // 英文厂商的错误描述（OpenRouter / 商汤 / Agnes 都可能给英文）
  if (/insufficient|quota|credit|balance|payment required/i.test(s)) return 'quota_exhausted';
  if (/rate limit|too many requests|throttl/i.test(s)) return 'rate_limited';
  if (/no such model|model not found|does not exist|unknown model/i.test(s)) return 'model_not_found';
  if (/invalid.*(api key|token)|unauthor|authentication/i.test(s)) return 'auth_failed';
  if (/content (policy|filter)|moderation|flagged/i.test(s)) return 'content_filtered';

  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 402) return 'quota_exhausted';   // OpenRouter 余额不足走 402，不是 4xx 泛码
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'unknown';
}

/* ---------------- 解析期过滤 ---------------- */

/**
 * 解析候选链：剔除 provider 关停 / 模型 enabled:false / 无可用 key 的条目。
 * 环境变量 LLM_DISABLE_MODELS 可临时摘除某个模型（灰度/止血用）。
 */
export function resolveCandidates(config, moduleName, keys) {
  const mod = (config.modules && config.modules[moduleName]) || config.modules?.default || {};
  const tierName = mod.tier || 'premium';
  const chain = (config.tiers && config.tiers[tierName]) || [];
  const off = disabledFromEnv();

  const out = [];
  for (const modelName of chain) {
    const m = config.models?.[modelName];
    if (!m) continue;
    if (m.enabled === false) continue;
    if (off.includes(modelName)) continue;
    const p = config.providers?.[m.provider];
    if (!p || p.enabled === false) continue;
    const key = (p.keyEnvs || []).map((k) => keys[k]).find(Boolean);
    if (!key) continue;                       // 解析不到 key 直接剔除
    out.push({
      provider: m.provider,
      model: modelName,
      endpoint: p.endpoint,
      key,
      // 🔴 厂商特有请求头必须带下去：OpenRouter 的 Referer/X-Title 缺了不报错，
      //    但会被限流得更狠（"不写也能跑、跑了会慢慢出问题"的那类）
      headers: p.headers || {},
      timeoutMs: m.timeoutMs ?? config.defaults.timeoutMs,
      temperature: m.temperature ?? config.defaults.temperature,
      // 思考模型的 reasoning budget 要靠倍率放大基础 maxTokens
      maxTokensScale: m.maxTokensScale ?? 1,
      // content 为空时是否回退读 reasoning（思考模型专治）
      reasoningFallback: m.reasoningFallback === true,
    });
  }
  return { tier: tierName, candidates: out };
}

/* ---------------- 统计 ---------------- */

const stats = { total: 0, ok: 0, fail: 0, degraded: 0, byModel: {}, byModule: {} };

export function getStats() { return JSON.parse(JSON.stringify(stats)); }

function bump(model, moduleName, ok, degraded) {
  stats.total++;
  if (ok) stats.ok++; else stats.fail++;
  if (degraded) stats.degraded++;
  stats.byModel[model] = stats.byModel[model] || { total: 0, ok: 0 };
  stats.byModel[model].total++;
  if (ok) stats.byModel[model].ok++;
  stats.byModule[moduleName] = stats.byModule[moduleName] || { total: 0, ok: 0, degraded: 0 };
  stats.byModule[moduleName].total++;
  if (ok) stats.byModule[moduleName].ok++;
  if (degraded) stats.byModule[moduleName].degraded++;
}

/* ---------------- 单次调用 ---------------- */

async function callOnce(cand, { system, user, temperature, maxTokens, json }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cand.timeoutMs);
  try {
    // 🔴 思考模型的推理也要 token 预算：不放大就会 content=null（实测 GLM-5.3-Flash
    //    在 max_tokens=64 时 reasoning_tokens=63、finish_reason=length、正文一个字都没有）
    const baseMax = maxTokens ?? cfg.defaults.maxTokens;
    const scaledMax = Math.round(baseMax * (cand.maxTokensScale || 1));

    const body = {
      model: cand.model,
      temperature: temperature ?? cand.temperature,
      max_tokens: scaledMax,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
    };
    if (json) body.response_format = { type: 'json_object' };

    const res = await fetch(cand.endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cand.key}`,
        ...(cand.headers || {}),      // 厂商特有头（如 OpenRouter 的 Referer/X-Title）
      },
      body: JSON.stringify(body),
    });

    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }

    if (!res.ok) {
      // 错误体结构各家不同：OpenRouter 用 error.type + 顶层 error.code(数字)，
      // 智谱用 error.code(数字)+中文 message，商汤/Agnes 走标准 HTTP 状态码
      const vc = data?.error?.code ?? data?.error?.type ?? data?.code ?? '';
      const msg = String(data?.error?.message ?? data?.message ?? data?.msg ?? '');
      return {
        ok: false, code: normalizeCode(res.status, vc, msg, cand.provider), status: res.status,
        vendorCode: String(vc), ms: Date.now() - t0, text: '',
      };
    }

    const msgObj = data?.choices?.[0]?.message || {};
    const finish = String(data?.choices?.[0]?.finish_reason || '');
    let text = String(msgObj.content ?? '').trim();
    let usedReasoning = false;

    // 🔴 思考模型回退：content 为空 ≠ 模型没答，很可能答案整个在 reasoning 字段里。
    //    不回退 = 这一档永远判 empty_response → 永远降级 → 最高优先级那档形同不存在。
    if (!text && cand.reasoningFallback) {
      const r = String(msgObj.reasoning ?? msgObj.reasoning_content ?? '').trim();
      if (r) { text = r; usedReasoning = true; }
    }

    if (!text) {
      // 200 但真空：思考模型把 token 全花在推理上被 length 截断，视为可降级
      return { ok: false, code: 'empty_response', status: 200, vendorCode: '', ms: Date.now() - t0, text: '', finishReason: finish };
    }
    return { ok: true, code: '', status: 200, vendorCode: '', ms: Date.now() - t0, text, usedReasoning, finishReason: finish };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, code: 'timeout', ms: Date.now() - t0, text: '' };
    return { ok: false, code: 'network', ms: Date.now() - t0, text: '', message: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 主路由 ---------------- */

/**
 * @param {object} config 结构配置
 * @param {object} keys   { GLM_KEY_A: '...', ... }
 * @param {object} req    { module, system, user, temperature, maxTokens, json }
 */
export async function route(config, keys, req = {}) {
  const moduleName = String(req.module || 'default');
  if (!(config.modules && config.modules[moduleName])) {
    // 模块白名单：不允许前端凭空造模块名去打模型（也是一种越权）
    if (moduleName !== 'default') return { ok: false, code: 'module_not_allowed', tried: [] };
  }

  const { tier, candidates } = resolveCandidates(config, moduleName, keys);
  if (!candidates.length) {
    return { ok: false, code: 'no_candidate', tier, tried: [], degraded: false };
  }

  const t0 = Date.now();
  const tried = [];
  const degradeOn = config.degradeOn || [];
  const retryOn = config.retry?.onlyCodes || [];
  const maxAttempts = config.retry?.maxAttempts ?? cfg.defaults.attempts;
  const backoff = config.retry?.backoffMs ?? cfg.defaults.backoffMs;

  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx];
    let last = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const r = await callOnce(cand, req);
      tried.push({
        provider: cand.provider, model: cand.model,
        ok: r.ok, code: r.code, ms: r.ms, attempt,
      });

      if (r.ok) {
        const degraded = idx > 0;
        bump(cand.model, moduleName, true, degraded);
        return {
          ok: true, text: r.text, model: cand.model, provider: cand.provider,
          tier, degraded, attempts: attempt, ms: Date.now() - t0, code: '', tried,
          // 观测：这一档是不是靠 reasoning 回退才拿到内容的（思考模型的固有特征）
          usedReasoning: Boolean(r.usedReasoning),
        };
      }

      last = r;
      tried[tried.length - 1].finishReason = r.finishReason || '';
      // 只在同一模型上重试**瞬时故障**；其余直接换档
      if (!retryOn.includes(r.code) || attempt >= maxAttempts) break;
      await new Promise((res) => setTimeout(res, backoff * attempt));
    }

    // 换档前判断：不在 degradeOn 里的错误（如参数错）其实也换档，但记录下来便于排障
    if (last && !degradeOn.includes(last.code) && last.code !== 'quota_exhausted') {
      // 仍然继续尝试下一档 —— 降级是兜底，不因"不该降级"就放弃
    }
  }

  const lastTry = tried[tried.length - 1] || {};
  bump(lastTry.model || 'none', moduleName, false, true);
  return {
    ok: false, text: '', model: lastTry.model || '', provider: lastTry.provider || '',
    tier, degraded: true, attempts: tried.length, ms: Date.now() - t0,
    code: lastTry.code || 'all_failed', tried,
  };
}

/* ---------------- 脱敏快照（给运维/审计看） ---------------- */

/**
 * @param {object} config 结构配置
 * @param {object} [env]  Worker 的 env 对象。
 *   🔴 Cloudflare Workers 里**没有 process.env**（那是 Node 的东西）。
 *      老版本这里直接写 process.env[k] —— 在 Worker 上会抛
 *      "process is not defined"，整个 /api/llm/config 端点 500。
 *      改为优先读传入的 env，其次才退回 process.env（本地 Node 单测用）。
 *   🔴 present 只回布尔，绝不回密钥值本身。
 */
export function configSnapshot(config, env = null) {
  const strip = (o) => JSON.parse(JSON.stringify(o));
  const c = strip(config);
  const has = (k) => {
    try {
      if (env && env[k]) return true;
      if (typeof process !== 'undefined' && process.env && process.env[k]) return true;
    } catch (_) { /* Worker 里 process 不存在 → 视为未配置 */ }
    return false;
  };
  for (const p of Object.values(c.providers || {})) {
    delete p.endpoint;                 // endpoint 不在快照里暴露
    p.keyEnvs = (p.keyEnvs || []).map((k) => ({ env: k, present: has(k) }));
  }
  return c;
}
