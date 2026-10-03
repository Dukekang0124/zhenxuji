/**
 * verify-version.js — 版本更新端点自测（方案 §2.9）
 *
 * 为什么单独一个脚本：worker/index.js 是 Workers runtime 入口（没有导出），
 * 无法像 llm-router.js 那样 import 单测。这里用 Node 原生 http 起一个
 * 转发到 Worker default.fetch 的最小宿主，真发请求验证端点行为。
 *
 * 覆盖：
 *  ① 干净配置原样透出
 *  ② 脏配置（非法版本号）被 normalizeVersion 兜住
 *  ③ is_force 只认布尔 true（字符串 "true" / 数字 1 都当 false）
 *  ④ is_force=true 但没下载地址 → 自动降级为非强制（否则端侧点了没反应）
 *  ⑤ KV 绑定时优先读 KV
 *  ⑥ 响应带 Cache-Control，避免每次冷启动都回源
 */

import http from 'node:http';

let pass = 0, total = 0;
const failed = [];
function check(name, cond, detail) {
  total++;
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed.push({ name, detail }); console.log(`  ✗ ${name}  ← ${JSON.stringify(detail)}`); }
}

console.log('\n===== 分区 A. 版本配置端点（真实 fetch） =====');

const mod = await import('./index.js');
const worker = mod.default;

async function callWorker(env = {}) {
  // 🔴 必须带合法 Origin：worker 里有 Origin 白名单（这是既有安全机制，不是缺陷）。
  //    少了它会一律 403 origin_not_allowed，测的就不是版本端点而是白名单了。
  const req = new Request('https://example.test/api/version', {
    method: 'GET',
    headers: { Origin: 'http://127.0.0.1:4188' },
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json().catch(() => null);
  return { res, body };
}

// ① 干净配置
{
  const { res, body } = await callWorker({
    VERSION_JSON: JSON.stringify({
      latest_version: '9.9.9', is_force: false,
      update_url: 'https://example.com/a.apk',
      update_content: '优化了一些体验', update_time: '2026-11',
    }),
  });
  check('合法配置原样透出', body?.latest_version === '9.9.9', body);
  check('下载地址与文案透传', body?.update_url === 'https://example.com/a.apk'
    && body?.update_content === '优化了一些体验', body);
  check('响应带 Cache-Control（减少回源）',
    String(res.headers.get('Cache-Control') || '').includes('max-age=300'),
    res.headers.get('Cache-Control'));
}

// ② 脏配置：非法版本号 → 回落兜底
{
  const { body } = await callWorker({ VERSION_JSON: JSON.stringify({ latest_version: 'not-a-version' }) });
  check('非法版本号被兜住（不把脏数据发给端侧）',
    /^\d+(\.\d+){0,3}$/.test(String(body?.latest_version || '')), body?.latest_version);
}

// ③ is_force 严格布尔
{
  const t = await callWorker({ VERSION_JSON: JSON.stringify({ latest_version: '9.9.9', is_force: 'true' }) });
  check('is_force="true"（字符串）→ false', t.body?.is_force === false, t.body?.is_force);
  const n = await callWorker({ VERSION_JSON: JSON.stringify({ latest_version: '9.9.9', is_force: 1 }) });
  check('is_force=1（数字）→ false', n.body?.is_force === false, n.body?.is_force);
  const b = await callWorker({ VERSION_JSON: JSON.stringify({ latest_version: '9.9.9', is_force: true, update_url: 'https://x/y.apk' }) });
  check('is_force=true（布尔）+有地址 → 保持强制', b.body?.is_force === true, b.body);
}

// ④ 强制更新但无下载地址 → 自动降级（防"点了没反应"卡死全量用户）
{
  const { body } = await callWorker({ VERSION_JSON: JSON.stringify({ latest_version: '9.9.9', is_force: true }) });
  check('强制更新缺下载地址 → 自动降级为可选（防卡死全量用户）',
    body?.is_force === false, body);
}

// ⑤ KV 优先于 env
{
  const kv = { get: async (k) => (k === 'current' ? { latest_version: '8.8.8', is_force: false, update_content: '来自KV' } : null) };
  const { body } = await callWorker({
    APP_VERSION_KV: kv,
    VERSION_JSON: JSON.stringify({ latest_version: '1.1.1' }),
  });
  check('KV 绑定时优先读 KV（改版本不用重新部署）',
    body?.latest_version === '8.8.8' && body?.update_content === '来自KV', body);
}

// ⑥ 完全无配置 → 仍返回合法结构（端侧永远拿得到，不会解析失败）
{
  const { body } = await callWorker({});
  check('无任何配置时返回合法兜底结构',
    /^\d+(\.\d+){0,3}$/.test(String(body?.latest_version || ''))
    && typeof body?.is_force === 'boolean' && typeof body?.update_content === 'string',
    body);
}

// ⑦ KV 读取抛异常时不得 500（KV 未绑定是常见情况）
{
  const badKv = { get: async () => { throw new Error('kv not bound'); } };
  const { res, body } = await callWorker({ APP_VERSION_KV: badKv, VERSION_JSON: JSON.stringify({ latest_version: '7.7.7' }) });
  check('KV 抛异常时回落 env 而不是 500',
    res.status === 200 && body?.latest_version === '7.7.7', { status: res.status, body });
}

console.log('\n==== 结果：' + pass + '/' + total + ' 通过 ====');
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log('  ✗ ' + f.name + '  ← ' + JSON.stringify(f.detail)));
  process.exit(1);
}
