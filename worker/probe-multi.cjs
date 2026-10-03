/**
 * probe-multi.cjs — 多端点 × 多密钥 × 多模型名 全矩阵探针
 *
 * 🔴 为什么必须实测（skill 铁律：需求方给的「型号名」是意图，不是事实）：
 *    康哥给了 4 把密钥，附带的模型名分别是
 *      GLM-5.3-Flash / deepseek-v4-flash / agnes-2.5-flash / GLM-4-Flash
 *    其中前两个**不一定是智谱的模型名**，密钥前缀也各不相同
 *    （sk-za-i9-… / sk-uE9… / sk-J5H… / 7917s… 无 sk- 前缀）。
 *    这四种前缀形态强烈暗示**至少来自 2~3 家不同厂商**。
 *    光看名字就写进配置 = 把三个注定 404/401 的条目放进优先级链，还挡住后面的兜底。
 *
 * 探针输出三件事，缺一不可：
 *   ① 每把 key 在**每个候选端点**上的真实表现（HTTP / 厂商码 / 耗时）
 *   ② 每把 key 试**多个模型名**，找出它真正能调通的那个
 *   ③ 对照实验：不存在的模型名 → 必须返回可区分的「模型不存在」，
 *      否则「模型不可用」的结论不成立（可能是余额问题被误判成模型问题）
 *
 * 用法（密钥只走环境变量，绝不落盘、绝不打印全文）：
 *   node probe-multi.cjs
 */

const A = process.env.K1_KEY; // GLM-5.3-Flash
const B = process.env.K2_KEY; // deepseek-v4-flash
const C = process.env.K3_KEY; // agnes-2.5-flash
const D = process.env.K4_KEY; // GLM-4-Flash（无 sk- 前缀，形态特殊）

const KEYS = [
  { label: 'K1·GLM-5.3-Flash  ', key: A },
  { label: 'K2·deepseek-v4-flash', key: B },
  { label: 'K3·agnes-2.5-flash ', key: C },
  { label: 'K4·GLM-4-Flash     ', key: D },
];

/**
 * 候选端点。宁多勿少 —— 猜错端点会得到误导性的 401，
 * 而 401 既可能是"密钥错"也可能是"端点不对"，必须靠交叉比对待排除。
 */
const ENDPOINTS = [
  { id: 'zhipu-open', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', style: 'openai' },
  { id: 'zhipu-cn', url: 'https://open.bigmodel.cn/api/paas/v4/', style: 'openai' },
  { id: 'zhipu-bigmodel-api', url: 'https://bigmodel.cn/api/paas/v4/chat/completions', style: 'openai' },
  { id: 'deepseek', url: 'https://api.deepseek.com/chat/completions', style: 'openai' },
  { id: 'deepseek-v1', url: 'https://api.deepseek.com/v1/chat/completions', style: 'openai' },
  { id: 'siliconflow', url: 'https://api.siliconflow.cn/v1/chat/completions', style: 'openai' },
  { id: 'volc-ark', url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', style: 'openai' },
  { id: 'moonshot', url: 'https://api.moonshot.cn/v1/chat/completions', style: 'openai' },
  { id: 'dashscope', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', style: 'openai' },
  { id: 'tencent-lkeap', url: 'https://api.lkeap.cloud.tencent.com/v1/chat/completions', style: 'openai' },
];

/** 每个 key 要试的模型名（含它名义上对应的那个 + 常见同族猜测 + 对照） */
const MODEL_TRIES = {
  K1: ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'glm-4.7-flash', 'glm-4-flash'],
  K2: ['deepseek-v4-flash', 'deepseek-v4', 'deepseek-chat', 'deepseek-v3', 'deepseek-reasoner'],
  K3: ['agnes-2.5-flash', 'agnes-2.5', 'agnes-2-flash', 'agnes-2.0-flash', 'agnes-flash'],
  K4: ['glm-4-flash', 'glm-4.7-flash', 'glm-5.2', 'glm-5.3-flash'],
};
const CONTROL = 'zzz-9.9-nonexistent-control';   // 对照：必须返回可区分的「模型不存在」

const TIMEOUT = 15000;

async function call(url, key, model) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 16,
        messages: [{ role: 'user', content: '只回复：OK' }],
      }),
    });
    const ms = Date.now() - t0;
    let code = '', msg = '', content = '';
    try {
      const j = await res.json();
      code = j?.error?.code ?? '';
      msg = String(j?.error?.message ?? '').slice(0, 80);
      content = String(j?.choices?.[0]?.message?.content ?? '').slice(0, 20);
      if (!code && content) code = 'OK';
    } catch (e) { msg = 'non-json'; }
    return { status: res.status, code: String(code), ms, msg, content };
  } catch (e) {
    return { status: 'NET', code: e?.name === 'AbortError' ? 'timeout' : 'network', ms: Date.now() - t0, msg: String(e?.message || e).slice(0, 60), content: '' };
  } finally { clearTimeout(timer); }
}

const mask = (k) => (k ? k.slice(0, 7) + '…' + k.slice(-4) : '(未提供)');

(async () => {
  console.log('\n########## 密钥指纹（只显示首尾，不打印全文）##########');
  for (const { label, key } of KEYS) console.log(`  ${label} ${mask(key)}  长度=${key ? key.length : 0}`);

  for (const { label, key } of KEYS) {
    if (!key) { console.log(`\n!!! ${label} 未提供，跳过`); continue; }
    const tag = label.trim().split('·')[0];
    console.log(`\n\n########## ${label} ##########`);

    let found = null;
    for (const ep of ENDPOINTS) {
      const r = await call(ep.url, key, MODEL_TRIES[tag][0]);
      const mark = r.code === 'OK' ? ' ✅可用' : '';
      console.log(`  [端点] ${ep.id.padEnd(20)} HTTP ${String(r.status).padEnd(5)} code=${r.code.padEnd(18)} ${String(r.ms).padStart(6)}ms ${r.msg}${mark}`);
      // 401/403 之外(即端点认得这把 key)才值得记下
      if (r.code === 'OK') { found = ep; break; }
      if (!found && r.status !== 404 && r.code !== 'network' && r.status !== 'NET' && r.status !== 403 && r.status !== 401) found = ep;
    }

    // 在哪家端点上试模型名
    const probeEps = found ? [found] : ENDPOINTS.slice(0, 3);
    for (const ep of probeEps) {
      console.log(`  --- 在 ${ep.id} 上试模型名 ---`);
      for (const m of MODEL_TRIES[tag]) {
        const r = await call(ep.url, key, m);
        console.log(`      ${m.padEnd(24)} HTTP ${String(r.status).padEnd(5)} code=${r.code.padEnd(18)} ${String(r.ms).padStart(6)}ms ${r.content ? '内容=' + r.content : r.msg}`);
      }
      const c = await call(ep.url, key, CONTROL);
      console.log(`      [对照] ${CONTROL.padEnd(17)} HTTP ${String(c.status).padEnd(5)} code=${c.code.padEnd(18)} ${String(c.ms).padStart(6)}ms ${c.msg}`);
    }
  }
})().catch((e) => { console.error('探针异常:', e); process.exit(1); });
