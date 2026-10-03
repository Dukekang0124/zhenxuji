/**
 * Pages Function — /api/* 反向代理到 zhenxuji-api Worker
 *
 * 🔴 为什么需要这一层（这是本文件存在的唯一理由，删掉它功能就废）：
 *    线上实测确认：`*.workers.dev` 这个域名在国内**被稳定阻断**，
 *    而 `zhenxuji.pages.dev` 可达。两者在同一次测试里：
 *      ✅ https://zhenxuji.pages.dev/version.json      → 200
 *      ✅ https://github.com/...                        → 206
 *      ❌ https://zhenxuji-api.kang7108558.workers.dev  → ConnectTimeout
 *    也就是说：App 里 `BUILTIN_API_ORIGIN` 若直指 workers.dev，
 *    **用户在手机上同样连不上** → AI 文案上线即不可用、且只会静默降级成
 *    本地兜底，界面上不报任何错 —— 这是最难发现的那类故障。
 *
 *    解法：让 App 改打 Pages 域名（可达），由这一层在**服务端**转发到 Worker。
 *    服务端转发走的是 Cloudflare 机房内部网络，不受终端所在网络的域名阻断影响，
 *    所以「终端可达 Pages」就等于「终端可达 Worker」，而终端无需知道 Worker 地址。
 *
 * 附带收益：Worker 的地址从端侧彻底消失 → 攻击面收窄，换后端不用重发 APK。
 *
 * 部署：Pages 自动识别仓库根的 `functions/` 目录，无需额外配置。
 *      但 `functions/` 必须与发布目录（本项目 www/）一起被 wrangler pages deploy 感知 ——
 *      见 scripts/build-web.mjs 里把 functions/ 复制到 www 同级部署根的处理。
 */

const UPSTREAM = 'https://zhenxuji-api.kang7108558.workers.dev';

/** 这些头是逐跳（hop-by-hop）语义，必须剥掉，否则会干扰上游 */
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  // host 必须重写，否则上游按 Pages 的域名做路由/校验会失败
  'host',
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // 只代理 /api/*，其余交给静态资源（不该走到这里，防御性判断）
  if (!url.pathname.startsWith('/api/')) {
    return context.next();
  }

  const target = UPSTREAM + url.pathname + url.search;

  // 转发请求头：剥逐跳头，其余原样带过去（含 Origin，Worker 侧还要做白名单校验）
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) headers.set(k, v);
  }

  const init = {
    method: request.method,
    headers,
    // GET/HEAD 不能带 body，带了上游会报错
    body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    redirect: 'manual',
  };

  let res;
  try {
    res = await fetch(target, init);
  } catch (e) {
    // 上游不可达 → 如实返回，让端侧走本地兜底；不回 200 假装成功
    return new Response(JSON.stringify({
      ok: false, error: 'upstream_unreachable', message: String(e?.message || e).slice(0, 200),
    }), { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  // 回包剥逐跳头；CORS 由 Worker 自己按 Origin 白名单给出，这里不重复设置
  // （重复设会出现两个 Access-Control-Allow-Origin，浏览器直接判非法）
  const out = new Headers();
  for (const [k, v] of res.headers) {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) out.set(k, v);
  }

  return new Response(res.body, { status: res.status, headers: out });
}
