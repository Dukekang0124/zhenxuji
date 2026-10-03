/**
 * 模型探针 — 全矩阵实测（key × model），输出「存在性 / 厂商错误码 / 耗时 / 限流」
 *
 * 🔴 skill 铁律 §3.2：需求方给的「优先级」通常是意图，不是事实。
 *    必做两步：
 *      ① 全矩阵探针：每把 key × 每个模型，打印原始 HTTP 状态 + 厂商错误码 + 耗时
 *      ② 对照实验：用**不存在的模型名**打同一端点，必须返回可区分的「模型不存在」错误。
 *        没有这一步，「某模型不可用」的结论不成立 —— 你可能把余额问题误判成模型问题。
 *
 * 用法（密钥走环境变量，绝不落盘）：
 *   GLM_KEY_A=xxx GLM_KEY_B=yyy GLM_KEY_C=zzz node probe-models.cjs
 */

const ENDPOINTS = {
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
};

const KEYS = {
  A: process.env.GLM_KEY_A,   // 需求指定：glm-4.7-flash
  B: process.env.GLM_KEY_B,   // 需求指定：glm-5.2（sk- 前缀，疑似第三方兼容端点）
  C: process.env.GLM_KEY_C,   // 需求指定：glm-4-flash
};

const MODELS = ['glm-5.2', 'glm-4.7-flash', 'glm-4-flash'];
const CONTROL = 'glm-9.9-nonexistent-probe';   // 对照实验：不存在的模型名

const rows = [];

async function probe(keyLabel, key, model, endpoint = ENDPOINTS.zhipu) {
  if (!key) return { keyLabel, model, status: '-', code: 'no_key', ms: 0 };
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 16,
        messages: [{ role: 'user', content: '只回复：OK' }],
      }),
    });
    const ms = Date.now() - t0;
    let code = '', msg = '';
    try {
      const j = await res.json();
      code = j?.error?.code ?? '';
      msg = String(j?.error?.message ?? '').slice(0, 90);
      if (!code && j?.choices?.[0]?.message?.content) code = 'OK';
    } catch (e) { msg = 'non-json body'; }
    return { keyLabel, model, status: res.status, code: String(code), ms, msg };
  } catch (e) {
    return { keyLabel, model, status: 'NET', code: 'network', ms: Date.now() - t0, msg: String(e?.message || e).slice(0, 60) };
  }
}

(async () => {
  console.log('\n===== ① 全矩阵探针（key × model）=====');
  for (const [label, key] of Object.entries(KEYS)) {
    for (const m of MODELS) {
      const r = await probe(label, key, m);
      rows.push(r);
      console.log(`  key ${label}  ${m.padEnd(16)} HTTP ${String(r.status).padEnd(5)} code=${String(r.code).padEnd(16)} ${String(r.ms).padStart(6)}ms  ${r.msg || ''}`);
    }
  }

  console.log('\n===== ② 对照实验（不存在的模型名，必须返回可区分错误）=====');
  for (const [label, key] of Object.entries(KEYS)) {
    const r = await probe(label, key, CONTROL);
    console.log(`  key ${label}  ${CONTROL.padEnd(16)} HTTP ${String(r.status).padEnd(5)} code=${String(r.code).padEnd(16)} ${String(r.ms).padStart(6)}ms  ${r.msg || ''}`);
  }

  console.log('\n===== 结论 =====');
  const usable = rows.filter((r) => r.code === 'OK');
  if (!usable.length) console.log('  ⚠️ 没有任何 (key, model) 组合可用 —— 需要检查密钥/额度/端点');
  else {
    console.log('  可用组合（按耗时升序）：');
    usable.sort((a, b) => a.ms - b.ms).forEach((r) => {
      console.log(`    key ${r.keyLabel} + ${r.model.padEnd(16)} ${String(r.ms).padStart(6)}ms`);
    });
  }
})();
