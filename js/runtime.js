/**
 * runtime.js — 运行环境与「服务地址」解析（唯一真相源）
 *
 * 🔴 这个文件存在的理由（真机反馈暴露的设计错误）：
 *    应用把**产品自有的服务地址**当成了**用户必须自己填的配置项**。
 *    后果有两个现场，表现一模一样，用户看到的都是"没配地址"：
 *      ① 检查更新 → 「还没有配置服务地址，暂时无法检查更新」（js/update.js，已在 P0-1 修）
 *      ② 生成 AI 文案 → 「未配置模型服务地址，使用本地文案」（js/api.js，本文件修）
 *    普通用户不可能知道什么叫服务地址，更不可能去填。
 *    ⇒ 产品自带的默认地址必须**内置**，用户填的地址只作为**覆盖**（给自测/自建后端用）。
 *
 * 谁该读本文件：
 *    - js/api.js（手记文案、分享上报）
 *    - 以后任何要打后端的地方
 * 谁不该读：
 *    - js/update.js —— 版本清单走的是「同源 /version.json」，
 *      和 API 源是两套语义（见该文件里的说明），别混。
 */

/**
 * 内置服务地址 = 站点自己的域名（Pages 上的 /api/* 由 Functions 反向代理到 Worker）。
 *
 * ⚠️ **留空 = 智能文案永远走本地兜底**（能用，但不是 AI 写的）。
 *    部署后把地址填到这里，改一行即可，用户端零配置、不用重新教用户去设置页填。
 *    `npm run build:web` 会在为空时打一条醒目警告，避免"忘了填"一路带进 APK。
 *
 * 🔴 为什么填 pages.dev 而**不是** Worker 自己的 workers.dev 地址（实测教训）：
 *    本机与国内的实测结果 —— 同一时刻、同一条网络：
 *      ✅ https://zhenxuji.pages.dev/version.json        → 200
 *      ✅ https://github.com/...                          → 206
 *      ❌ https://zhenxuji-api.kang7108558.workers.dev    → Connect Timeout
 *    即 **`*.workers.dev` 这个域名被稳定阻断，而 `pages.dev` 可达**。
 *    若把 Worker 地址直接内置，**用户在手机上同样连不上** → AI 文案上线即不可用，
 *    而且因为 api.js 会静默降级到本地兜底，界面上**不报任何错** ——
 *    这正是最难被发现的那类故障（功能"看起来正常"，只是永远不是 AI 写的）。
 *
 *    解法：内置 Pages 域名，由 functions/api/[[path]].js 在**服务端**转发到 Worker。
 *    服务端转发走 Cloudflare 机房内部网络，不受终端所在网络的域名阻断影响。
 *    附带收益：Worker 地址从端侧彻底消失（攻击面收窄、换后端不用重发 APK）。
 *
 *    取值必须与站点域名一致；Worker 的 Origin 白名单已包含 https://zhenxuji.pages.dev
 *    与 https://localhost（APK WebView），所以 Web 与 APK 两端都能直连。
 */
export const BUILTIN_API_ORIGIN = 'https://zhenxuji.pages.dev';

/**
 * 把一个地址归一成「可以作为 API 根」的形式。
 * 保留路径（允许挂在子路径下的自建代理，例如 https://my.dev/zhenxuji），
 * 只去掉结尾斜杠；非 http(s) 一律拒绝。
 * @returns {string} 例如 'https://a.dev' / 'https://a.dev/zxj'；不可用时 ''
 */
export function apiBaseOf(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

/**
 * 解析实际使用的 API 根地址。
 * 优先级：用户显式填的 > 内置默认。
 *
 * 为什么用户填的排第一：设置页那个输入框存在的意义就是"我要指定自己的后端"
 * （本地自测、自建代理），这时候内置地址必须让位，否则用户改了不生效更困惑。
 *
 * @param {object} o { configured, builtin }
 * @returns {string} API 根地址；两者都不可用时返回 ''（调用方走本地兜底）
 */
export function resolveApiBase({ configured, builtin = BUILTIN_API_ORIGIN } = {}) {
  return apiBaseOf(configured) || apiBaseOf(builtin) || '';
}

/** 拼一个 API 完整地址；base 为空时返回 ''（调用方据此判定"没有后端可问"） */
export function apiUrl(base, path) {
  const b = apiBaseOf(base);
  if (!b) return '';
  return b + (String(path || '').startsWith('/') ? path : '/' + String(path || ''));
}
