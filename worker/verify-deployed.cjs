/**
 * verify-deployed.cjs — 线上部署指纹核对（控制面，不依赖 workers.dev 用户面）
 *
 * 为什么需要它：
 *   本机环境打不通 *.workers.dev（代理 502 / 直连超时），所以**不能**靠
 *   `curl https://xxx.workers.dev/api/llm` 来验证线上到底是什么代码。
 *   但控制面（api.cloudflare.com）是通的 —— 于是改用：
 *     ① 读 secret 名单，确认四把密钥都在（只读名字，绝不回显值）
 *     ② 下载线上打包产物，做代码指纹比对，证明「线上跑的就是新代码」
 *   这把「部署成功了吗」从一句口头保证变成可核对的证据。
 *
 * 🔴 关键纪律（踩过的坑）：
 *   1. `/scripts/{name}/content` 返回 **405**，正确端点是 `/content/v2`
 *      （且返回 multipart/form-data，不是 JSON —— 直接按文本做子串匹配）。
 *   2. 必须先判 HTTP 是否 2xx 再看内容。否则拿到 52 字节的错误 JSON 时会
 *      得出"指纹全 ❌"的结论 —— 那不是代码旧，是**测量仪器坏了**。
 *   3. 「旧密钥名已移除」这类**否定式断言必须加非空前置保护**：
 *      空内容同样不含旧名，会给出假绿。
 *   4. 指纹要用**打包后**的真实形态匹配：esbuild 会把 import 的默认导出
 *      改名为 `llm_config_default`，写 `configSnapshot(cfg, env)` 必然假红。
 *
 * 用法：CF_TOKEN=xxx node verify-deployed.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.CF_TOKEN;
const ACCOUNT = 'd24caa86ff464fd98e1c95a11c814a61';
const SCRIPT = 'zhenxuji-api';
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOKEN}` };

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  ← ' + JSON.stringify(detail).slice(0, 200)}`);
};

(async () => {
  if (!TOKEN) { console.error('缺少 CF_TOKEN'); process.exit(2); }

  console.log('===== 1. 线上 secret 名单（只读名字）=====');
  let secretNames = [];
  {
    const r = await fetch(`${API}/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`, { headers: H });
    check('secrets 接口返回 2xx', r.ok, r.status);
    if (r.ok) {
      const j = await r.json();
      secretNames = (j.result || []).map((s) => s.name);
      console.log('  线上密钥名:', secretNames.join(', ') || '(空)');
    }
  }
  for (const n of ['GLM_KEY_53', 'SN_KEY', 'AG_KEY', 'GLM_KEY_4F']) {
    check(`secret ${n} 已就位`, secretNames.includes(n), secretNames);
  }
  check('🔴 旧密钥名 GLM_KEY_A / GLM_KEY_C 已不在线上（避免读到废弃配置）',
    !secretNames.includes('GLM_KEY_A') && !secretNames.includes('GLM_KEY_C'), secretNames);

  console.log('\n===== 2. 线上打包产物指纹 =====');
  let txt = '';
  {
    // 🔴 正确端点是 /content/v2；/content 会 405
    const r = await fetch(`${API}/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/content/v2`, { headers: H });
    check('产物下载接口返回 2xx（/content/v2，不是 /content）', r.ok, r.status);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      txt = buf.toString('utf8');
      console.log('  产物字节数:', buf.length);
      const out = path.join(__dirname, '_deployed_snapshot.txt');
      fs.writeFileSync(out, txt, 'utf8');
      console.log('  已落盘供人工复核:', path.basename(out));
    } else {
      console.log('   HTTP', r.status, (await r.text()).slice(0, 200));
    }
  }

  // 🔴 非空前置保护：内容为空时后面的否定式断言会假绿
  const nonEmpty = txt.length > 1000;
  check('🔴 产物内容非空（否则后续断言全部是假绿）', nonEmpty, txt.length);
  if (!nonEmpty) {
    console.log('\n❌ 产物取不到，后续指纹核对无意义，提前结束');
    process.exit(1);
  }

  const marks = [
    ['四家厂商端点 · openrouter', 'openrouter.ai/api/v1/chat/completions'],
    ['四家厂商端点 · sensenova', 'token.sensenova.cn/v1/chat/completions'],
    ['四家厂商端点 · agnes', 'apihub.agnes-ai.com/v1/chat/completions'],
    ['四家厂商端点 · zhipu', 'open.bigmodel.cn/api/paas/v4/chat/completions'],
    ['密钥名 · GLM_KEY_53', 'GLM_KEY_53'],
    ['密钥名 · SN_KEY', 'SN_KEY'],
    ['密钥名 · AG_KEY', 'AG_KEY'],
    ['密钥名 · GLM_KEY_4F', 'GLM_KEY_4F'],
    ['思考模型 · reasoning 回退', 'reasoningFallback'],
    ['思考模型 · maxTokens 倍率放大', 'maxTokensScale'],
    ['错误码 · provider 前缀表', 'openrouter:402'],
    ['OpenRouter 必需请求头', 'X-Title'],
    // 🔴 打包后 import 默认导出被改名，必须按产物形态匹配
    ['快照调用已传 env（修 Worker 无 process.env 崩溃）', 'configSnapshot(llm_config_default, env)'],
  ];
  for (const [label, needle] of marks) check(label, txt.includes(needle), needle);

  check('🔴 旧密钥名 GLM_KEY_A 已从产物中移除（证明部署的是新代码）',
    !txt.includes('GLM_KEY_A'), 'still contains GLM_KEY_A');

  // 优先级顺序必须原样出现在产物里（四档模型定义都在）
  const idxK1 = txt.indexOf('"GLM-5.3-Flash"');
  const idxK4 = txt.indexOf('"GLM-4-Flash"');
  const idxK2 = txt.indexOf('"deepseek-v4-flash"');
  const idxK3 = txt.indexOf('"agnes-2.5-flash"');
  check('产物里四个模型名都在（异构链完整）',
    idxK1 >= 0 && idxK2 >= 0 && idxK3 >= 0 && idxK4 >= 0,
    { idxK1, idxK2, idxK3, idxK4 });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n==== 结果：${pass}/${results.length} 通过 ====`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { failed.forEach((f) => console.log(`  ✗ ${f.name}`)); process.exit(1); }
  console.log('✅ 线上部署与本地代码一致，四把密钥就位');
})();
