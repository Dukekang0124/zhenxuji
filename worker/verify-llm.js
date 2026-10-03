/**
 * 模型调度层 · 三层断言 + A/B 鉴别力校验
 * —— 2026-10-03 重写：单厂商 → **四家异构厂商**（OpenRouter / 商汤 / Agnes / 智谱）
 *
 * 🔴 只跑一遍全绿的脚本**证明不了它在测东西**。必须让同一脚本在两类输入下给出相反结论：
 *    A 组（四档全开）        → 走完整条链，degraded 与 tried 长度给出真实链路证据
 *    B 组（只留兜底档）      → 应一次成功、degraded=false、tried 长度 =1
 *    C 组（全关）           → 应 no_candidate，ok=false（不允许假装成功）
 *    只有 A≠B，前面的断言才不是"永远通过"的空壳。
 *
 * 用法：
 *   K1=xxx K2=yyy K3=zzz K4=www node verify-llm.js
 *   （不传真 key 时，纯逻辑段仍全跑，真实网络段自动跳过并明确标注）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, resolveCandidates, normalizeCode, configSnapshot, getStats } from './llm-router.js';
import cfg from './llm.config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(ROOT, '..');
const APP = path.join(PROJECT_ROOT, '帧叙集-app');

const results = [];
const sections = [];
const sec = (n) => { sections.push({ n, i: results.length }); console.log(`\n===== 分区 ${n} =====`); };
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  ← ' + JSON.stringify(detail)}`);
}

/* ---------------- 密钥装载 ---------------- */

const keys = {
  GLM_KEY_53: process.env.K1 || '',
  SN_KEY: process.env.K2 || '',
  AG_KEY: process.env.K3 || '',
  GLM_KEY_4F: process.env.K4 || '',
};
const presentCount = Object.values(keys).filter(Boolean).length;
const hasFullKeys = presentCount === 4;

/**
 * 🔴 纯逻辑断言必须用"假 key"，不能依赖环境变量。
 *    否则本机没配 env 时解析期过滤把整条链剃空，顺序类断言返回 []
 *    被判红 —— 那是环境噪音，不是代码缺陷。
 */
const logicKeys = {
  GLM_KEY_53: 'fake.or.key.logic.only',
  SN_KEY: 'fake.sn.key.logic.only',
  AG_KEY: 'fake.ag.key.logic.only',
  GLM_KEY_4F: 'fake.zhipu.key.logic.only',
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------------- A. 纯函数层 ---------------- */

sec('A. 码值归一与解析期过滤（四家异构）');

// 裸数字码（智谱）
check('1113 → quota_exhausted', normalizeCode(429, '1113') === 'quota_exhausted', normalizeCode(429, '1113'));
check('1305 → rate_limited', normalizeCode(429, '1305') === 'rate_limited', normalizeCode(429, '1305'));
check('1211 → model_not_found', normalizeCode(400, '1211') === 'model_not_found', normalizeCode(400, '1211'));
check('1214 → param_error（参数错不重试，直接换档）', normalizeCode(400, '1214') === 'param_error', normalizeCode(400, '1214'));
check('401 → auth_failed', normalizeCode(401, '401') === 'auth_failed', normalizeCode(401, '401'));
check('无码时按 HTTP 状态推断', normalizeCode(503, '') === 'http_5xx', normalizeCode(503, ''));
check('中文文案也能归一（余额不足）', normalizeCode(429, '', '余额不足或无可用资源包') === 'quota_exhausted', normalizeCode(429, '', '余额不足'));

// 🔴 provider 前缀码：四家异构后同一个数字在不同厂商含义不同，必须分开
check('openrouter:402 → quota_exhausted（OpenRouter 余额走 402，不是 4xx 泛码）',
  normalizeCode(402, '402', '', 'openrouter') === 'quota_exhausted', normalizeCode(402, '402', '', 'openrouter'));
check('openrouter:403 → content_filtered（内容审核拦截，与鉴权失败区分开）',
  normalizeCode(403, '403', '', 'openrouter') === 'content_filtered', normalizeCode(403, '403', '', 'openrouter'));
check('🔴 同一码 403 在无 provider 时仍是 auth_failed（证明前缀查表真的在起作用）',
  normalizeCode(403, '403', '', '') === 'auth_failed', normalizeCode(403, '403', '', ''));
check('openrouter:408 → timeout', normalizeCode(408, '408', '', 'openrouter') === 'timeout', normalizeCode(408, '408', '', 'openrouter'));
check('openrouter:503 → http_5xx', normalizeCode(503, '503', '', 'openrouter') === 'http_5xx', normalizeCode(503, '503', '', 'openrouter'));

// 英文错误描述（商汤/Agnes/OpenRouter 都可能给英文）
check('英文 insufficient credit → quota_exhausted',
  normalizeCode(400, '', 'Insufficient credits', 'openrouter') === 'quota_exhausted', 'en-quota');
check('英文 rate limit → rate_limited',
  normalizeCode(200, '', 'Rate limit exceeded', 'agnes') === 'rate_limited', 'en-rate');
check('英文 invalid api key → auth_failed',
  normalizeCode(401, '', 'Invalid API key provided', 'sensenova') === 'auth_failed', 'en-auth');
check('英文 model not found → model_not_found',
  normalizeCode(404, '', 'No such model: xxx', 'openrouter') === 'model_not_found', 'en-model');
check('英文 content policy → content_filtered',
  normalizeCode(400, '', 'Content policy violation', 'openrouter') === 'content_filtered', 'en-filter');

/* ---------------- A2. 解析期过滤与顺序 ---------------- */

{
  const r = resolveCandidates(cfg, 'story', logicKeys);
  check('story 走 premium 链', r.tier === 'premium', r.tier);
  check('🔴 候选严格保留需求顺序（GLM-5.3 → deepseek → agnes → GLM-4）',
    JSON.stringify(r.candidates.map((c) => c.model))
    === JSON.stringify(['GLM-5.3-Flash', 'deepseek-v4-flash', 'agnes-2.5-flash', 'GLM-4-Flash']),
    r.candidates.map((c) => c.model));
  check('四个候选取自四家不同 provider（真的是异构链，不是同厂多模型）',
    new Set(r.candidates.map((c) => c.provider)).size === 4,
    r.candidates.map((c) => `${c.model}@${c.provider}`));
}

{
  const noKey = resolveCandidates(cfg, 'story', {});
  check('解析不到 key 时整条链被剔除（不白跑一次注定失败的请求）',
    noKey.candidates.length === 0, noKey.candidates);
}

{
  // 🔴 单点缺 key：只给兜底档的 key，链上应只剩 1 档 —— 证明过滤是**逐档**的，
  //    而不是"有任意一把 key 就全放行"。
  const onlyFallback = resolveCandidates(cfg, 'story', { GLM_KEY_4F: 'fake' });
  check('只给兜底 key 时链上只剩 GLM-4-Flash（逐档过滤，不放行无 key 的档）',
    onlyFallback.candidates.length === 1 && onlyFallback.candidates[0].model === 'GLM-4-Flash',
    onlyFallback.candidates.map((c) => c.model));
}

{
  // 换整份配置 → 顺序全变，而代码一行不改（"不硬编码"的可验证标准）
  const flipped = clone(cfg);
  flipped.tiers.premium = ['GLM-4-Flash', 'agnes-2.5-flash', 'deepseek-v4-flash', 'GLM-5.3-Flash'];
  const r = resolveCandidates(flipped, 'story', logicKeys);
  check('整份配置换掉即改变顺序（证明顺序未被硬编码）',
    r.candidates[0]?.model === 'GLM-4-Flash', r.candidates.map((c) => c.model));
}

{
  // 🔴 厂商特有请求头必须被带下去（OpenRouter 缺 Referer/X-Title 会被限流更狠）
  const r = resolveCandidates(cfg, 'story', logicKeys);
  const or = r.candidates.find((c) => c.provider === 'openrouter');
  check('OpenRouter 候选带上了 HTTP-Referer / X-Title',
    Boolean(or?.headers?.['HTTP-Referer']) && Boolean(or?.headers?.['X-Title']),
    or?.headers);

  const zp = r.candidates.find((c) => c.provider === 'zhipu');
  check('非 OpenRouter 候选不带多余头（headers 为空对象，不污染请求）',
    Object.keys(zp?.headers || {}).length === 0, zp?.headers);
}

{
  // 🔴 思考模型的两个开关必须真的透传到候选上，否则 callOnce 里读了也是 undefined
  const r = resolveCandidates(cfg, 'story', logicKeys);
  const k1 = r.candidates.find((c) => c.model === 'GLM-5.3-Flash');
  check('GLM-5.3-Flash 透传 maxTokensScale=3（推理要额外预算）', k1?.maxTokensScale === 3, k1?.maxTokensScale);
  check('GLM-5.3-Flash 透传 reasoningFallback=true（content=null 时回退读 reasoning）',
    k1?.reasoningFallback === true, k1?.reasoningFallback);
  const k4 = r.candidates.find((c) => c.model === 'GLM-4-Flash');
  check('GLM-4-Flash 的 maxTokensScale 默认 1（不放大，普通模型不该浪费额度）',
    k4?.maxTokensScale === 1, k4?.maxTokensScale);
  check('GLM-4-Flash 不开 reasoningFallback（不开无用回退）',
    k4?.reasoningFallback === false, k4?.reasoningFallback);
}

{
  // 脱敏快照（第一个参数是 config，第二个是可选 env）
  const snap = configSnapshot(cfg, { GLM_KEY_53: 'x' });
  const s = JSON.stringify(snap);
  check('快照不含任何真实 endpoint', !s.includes('openrouter.ai') && !s.includes('sensenova.cn') && !s.includes('agnes-ai') && !s.includes('bigmodel.cn'), s.slice(0, 160));
  check('快照不含密钥明文', !/[0-9a-f]{32}\./.test(s) && !s.includes('sk-'), 'snapshot leaked?');
  check('🔴 快照的 present 来自传入的 env（Worker 无 process.env，读全局会 500）',
    snap.providers.openrouter.keyEnvs[0].present === true && snap.providers.sensenova.keyEnvs[0].present === false,
    snap.providers.openrouter.keyEnvs);
  // 🔴 不传 env 也不能抛：Worker 环境没有 process，若代码直接读全局引用会 TypeError
  let threw = false;
  try { configSnapshot(cfg); } catch (e) { threw = true; }
  check('不传 env 时快照不抛异常（Worker 里 process 不存在的兜底路径）', threw === false, 'threw');
}

/* ---------------- B. 模块白名单 ---------------- */

sec('B. 模块白名单与越权防护');

{
  const r = await route(cfg, logicKeys, { module: 'nonexistent-module', user: 'x' });
  check('非法模块名被拒绝（不允许凭空造模块去打模型）',
    r.ok === false && r.code === 'module_not_allowed', r.code);
}

/* ---------------- C. A/B 鉴别力校验（真实网络） ---------------- */

sec('C. A/B 鉴别力校验（真实调用）');

if (!hasFullKeys) {
  console.log(`  ⚠️ 四把 key 未配齐（当前 ${presentCount}/4：${Object.entries(keys).filter(([, v]) => v).map(([k]) => k).join(', ') || '无'}）`);
  console.log('     → 跳过真实调用段（前面的纯逻辑断言仍然有效）');
} else {
  // A 组：四档全开 —— 最坏情况也要能兜到 GLM-4-Flash
  const cfgA = clone(cfg);
  const a = await route(cfgA, keys, { module: 'story', user: '只回复两个字：可用', maxTokens: 32 });

  // B 组：只留兜底档 —— 应一次成功、不降级
  const cfgB = clone(cfg);
  cfgB.models['GLM-5.3-Flash'].enabled = false;
  cfgB.models['deepseek-v4-flash'].enabled = false;
  cfgB.models['agnes-2.5-flash'].enabled = false;
  const b = await route(cfgB, keys, { module: 'story', user: '只回复两个字：可用', maxTokens: 32 });

  // C 组：全关 —— 必须 no_candidate，不允许假装成功
  const cfgC = clone(cfg);
  for (const k of Object.keys(cfgC.models)) cfgC.models[k].enabled = false;
  const c = await route(cfgC, keys, { module: 'story', user: 'OK' });

  console.log(`  A 组 tried=${a.tried?.length} degraded=${a.degraded} model=${a.model}@${a.provider} code=${a.code} ms=${a.ms} usedReasoning=${a.usedReasoning}`);
  console.log(`  B 组 tried=${b.tried?.length} degraded=${b.degraded} model=${b.model}@${b.provider} code=${b.code} ms=${b.ms}`);
  console.log(`  C 组 ok=${c.ok} code=${c.code}`);
  if (a.tried?.length) {
    console.log('  A 组逐档轨迹：');
    for (const t of a.tried) console.log(`    ${t.model}@${t.provider} attempt=${t.attempt} ok=${t.ok} code=${t.code || '-'} ms=${t.ms} finish=${t.finishReason || '-'}`);
  }

  check('A 组最终成功（降级链真的走到了可用档）', a.ok === true, { code: a.code, tried: a.tried });
  check('🔴 A 组最高优先档 GLM-5.3-Flash 真的被调用过（不是被静默剃掉）',
    (a.tried || []).some((t) => t.model === 'GLM-5.3-Flash'), a.tried?.map((t) => t.model));

  // 🔴 这条是本次改造的核心验收：思考模型如果没回退/没放大，这一档必然 empty_response
  {
    const k1Try = (a.tried || []).find((t) => t.model === 'GLM-5.3-Flash');
    if (k1Try) {
      check('GLM-5.3-Flash 未因思考模型特性误判为 empty_response（reasoning 回退生效）',
        k1Try.code !== 'empty_response',
        { code: k1Try.code, finishReason: k1Try.finishReason });
    } else {
      check('GLM-5.3-Flash 出现在轨迹里', false, 'missing in tried[]');
    }
  }

  check('B 组一次成功、未降级', b.ok === true && b.degraded === false, { ok: b.ok, degraded: b.degraded, code: b.code });
  check('B 组 tried 只有 1 条', (b.tried?.length || 0) === 1, b.tried?.length);
  check('B 组用的是兜底档 GLM-4-Flash', b.model === 'GLM-4-Flash', b.model);
  check('C 组链空时返回 no_candidate 且不假装成功',
    c.ok === false && c.code === 'no_candidate', c.code);
  check('tried[] 带 provider（排障能答出"是谁挂了"）',
    (a.tried || []).every((t) => typeof t.provider === 'string' && t.provider),
    a.tried?.slice(0, 2).map((t) => t.provider));
  check('回包带耗时与模型名（可观测）', typeof a.ms === 'number' && Boolean(a.model), { ms: a.ms, model: a.model });

  const st = getStats();
  check('统计按模型分桶（byModel 有记录）', Object.keys(st.byModel || {}).length > 0, st.byModel);
  if (a.degraded) {
    console.log('  ℹ️ 注：本次 A 组发生了降级（说明上游确实有档不健康）');
  } else {
    console.log('  ℹ️ 注：本次 A 组四档全健康、一次命中最高优先档 —— 这是最好情况，但也意味着');
    console.log('      "降级真的会发生"这件事没被真实环境证伪。下一段用**受控故障注入**补上这个证据。');
  }
}

/* ---------------- C2. 受控故障注入：让"降级真的会发生"可被证明 ---------------- */

sec('C2. 受控故障注入（不依赖上游健康度）');

/**
 * 🔴 为什么需要这一段：
 *    C 段的 A/B 鉴别力依赖"上游前几档必然失败"这个**环境前提**。
 *    一旦四家厂商全部健康，A 组一次就命中最高优先档、tried=1，
 *    与 B 组数值相同 → "A/B 结论相反"这条断言假红。
 *    那是**测量仪器坏了**，不是被测对象坏了。
 *
 * 正确做法：把"失败"做成受控输入 —— 用假 config / 假 key / 假端点，
 * 让注定失败的档与健康的档同处一条链，观察调度器是否按序跳过、最终落到健康档。
 * 这样无论上游怎么变，断言都成立，且证明力更强（我们在控制变量，而非碰运气）。
 */
{
  // ① 首位档用不存在的模型名 + 指向真实端点的假 key → 必然鉴权/模型错 → 应换档
  const cfgInject = clone(cfg);
  cfgInject.tiers.premium = ['GLM-5.3-Flash', 'GLM-4-Flash'];
  cfgInject.models['GLM-5.3-Flash'].enabled = true;
  // 🔴 假 key 绝对不能长得像真 key —— 否则会被本文件末尾的「密钥泄漏扫描」抓到，
  //    变成"测试代码自己触发自己的安全断言"这种自伤。用一个明显非密钥的哨兵串。
  const INVALID_KEY = 'INVALID-KEY-FOR-DEGRADE-TEST';
  const injectKeys = { ...keys, GLM_KEY_53: INVALID_KEY };
  const inj = await route(cfgInject, injectKeys, { module: 'story', user: '只回复：可用', maxTokens: 32 });

  console.log(`  注入组 tried=${inj.tried?.length} degraded=${inj.degraded} model=${inj.model}@${inj.provider} code=${inj.code} ms=${inj.ms}`);
  if (inj.tried?.length) {
    for (const t of inj.tried) console.log(`    ${t.model}@${t.provider} attempt=${t.attempt} ok=${t.ok} code=${t.code || '-'} ms=${t.ms}`);
  }

  check('注入组：首档鉴权失败后确实降级到下一档',
    inj.tried.length >= 2 && inj.tried[0].ok === false && inj.degraded === true,
    { len: inj.tried.length, firstOk: inj.tried[0]?.ok, degraded: inj.degraded });
  check('注入组的 tried[0] 记录了失败原因（不是静默跳档）',
    Boolean(inj.tried[0]?.code), inj.tried[0]);
  check('注入组最终仍成功（降级链的兜底价值）', inj.ok === true, { code: inj.code });
  check('注入组最终落在兜底档 GLM-4-Flash', inj.model === 'GLM-4-Flash', inj.model);

  // ② 全档注入无效 key → 必须整链失败且如实返回，不允许假装成功
  const cfgAllBad = clone(cfg);
  cfgAllBad.tiers.premium = ['GLM-5.3-Flash', 'GLM-4-Flash'];
  const allBadKeys = { GLM_KEY_53: INVALID_KEY, GLM_KEY_4F: 'INVALID-KEY-FOR-ALL-BAD-TEST' };
  const bad = await route(cfgAllBad, allBadKeys, { module: 'story', user: 'OK', maxTokens: 16 });
  console.log(`  全坏组 ok=${bad.ok} code=${bad.code} tried=${bad.tried?.length}`);
  check('全档失效时如实返回失败（绝不假装成功）',
    bad.ok === false && Boolean(bad.code), { ok: bad.ok, code: bad.code });
  check('全档失效时 tried 记录了每一档（排障能看到完整链路）',
    (bad.tried?.length || 0) >= 2, bad.tried?.length);

  // ③ 端到端时延边界：注入组应在合理时间内收敛（不是无限重试拖死）
  check('注入组在 20s 内收敛（重试策略没有把请求拖死）',
    inj.ms < 20000, inj.ms);
}

/* ---------------- D. 密钥零泄漏扫描 ---------------- */

sec('D. 密钥零泄漏扫描');

{
  const KEY_PATTERNS = [/[0-9a-f]{32}\.[A-Za-z0-9]{16,}/, /sk-[A-Za-z0-9-]{16,}/, /sk-or-v1-[A-Za-z0-9]{16,}/];
  // 🔴 扫描范围是**整个项目**（含文档），不只是代码。
  //    密钥最容易在"写文档时顺手贴上去"泄漏 —— 文档不是安全盲区。
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'www'
        || e.name === 'android' || e.name === 'apk-dist' || e.name === 'dist') continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(js|mjs|cjs|json|md|html|css|toml|txt|yml|yaml)$/i.test(e.name)) files.push(fp);
    }
  };
  walk(PROJECT_ROOT);
  check('扫描覆盖到项目文档目录（不只代码）',
    files.some((f) => /05-技术选型/.test(f)), files.length);

  const hits = [];
  for (const f of files) {
    // .dev.vars* 是本机/示例密钥文件，本就该放密钥；模板文件里是空值不触发
    if (/\.dev\.vars/.test(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    for (const re of KEY_PATTERNS) if (re.test(txt)) hits.push(path.relative(ROOT, f));
  }
  check('源码与文档中无硬编码密钥（全项目扫描）', hits.length === 0, hits);

  const appJs = path.join(APP, 'js', 'api.js');
  const apiTxt = fs.existsSync(appJs) ? fs.readFileSync(appJs, 'utf8') : '';
  // 只看**非注释代码行**：注释里提到这个词不算泄漏，断言过粗会误伤
  const codeOnly = apiTxt.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  check('前端 api.js 代码里不再出现 Authorization 头',
    !codeOnly.includes('Authorization'), 'still sets Authorization header');
  check('前端 api.js 不再出现模型名常量', !apiTxt.includes('GLM-4-Flash'), 'still has model const');
  check('前端设置页不再有 API Key 输入框',
    !fs.readFileSync(path.join(APP, 'js', 'pages.js'), 'utf8').includes('id="apiKey"'), 'apiKey input still exists');
}

/* ---------------- 汇总 ---------------- */

const pass = results.filter((r) => r.ok).length;
console.log('\n==== 分区条数 ====');
sections.forEach((s, i) => {
  const n = (i + 1 < sections.length ? sections[i + 1].i : results.length) - s.i;
  console.log(`  ${String(s.n).padEnd(46)} ${String(n).padStart(4)}`);
});
console.log(`\n==== 结果：${pass}/${results.length} 通过 ====`);
const failed = results.filter((r) => !r.ok);
if (failed.length) { failed.forEach((f) => console.log(`  ✗ ${f.name}`)); process.exit(1); }
