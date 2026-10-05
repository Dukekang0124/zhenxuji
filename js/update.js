/**
 * update.js — ★版本更新系统（V1.2 新增，方案 §2.9）
 *
 * 方案硬约束（逐条对应实现，勿删）：
 *  1. 冷启动**后台静默**检测，不阻塞首页加载；APP 切后台热启动**不自动检测**。
 *  2. 可选更新 / 强制更新双模式；强制更新仅用于重大安全或接口故障。
 *  3. 防骚扰：点「稍后提醒」后本地记时间戳，**24h 内不再自动弹窗**；
 *     **手动检查不受冷却限制**。
 *  4. 设置页入口【检查版本更新】，展示当前版本号。
 *  5. 更新日志全文必须是用户能读懂的话，禁止技术报错术语。
 *  6. 离线/弱网：静默失败不弹报错；仅手动检测时才提示网络异常。
 *  7. 双端适配：APK 跳下载链接；PWA 提示刷新页面更新。
 *
 * 设计要点：
 *  - 纯逻辑（版本比较、冷却判定）与副作用（fetch/UI）分离，便于浏览器内 import() 直接断言。
 *  - 永不抛错：网络异常一律归一成 { ok:false, silent:true }，由调用方决定要不要提示。
 */

/** 冷却窗口：24 小时（方案 §2.9.3 硬性要求） */
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 静默检测超时：3s。超时即视为"无网络"，绝不拖慢冷启动。 */
const SILENT_TIMEOUT_MS = 3000;
/** 手动检测超时：8s。手动是用户主动等待，可以多给一点。 */
const MANUAL_TIMEOUT_MS = 8000;

const LS_SNOOZE = 'zhenxuji.update.snoozeAt';

/** 记录用户**上次运行的本机版本号**（跨会话/刷新都留得住）。 */
const LS_APP_VERSION = 'zhenxuji.appVersion';

/* ==================== 版本源解析（P0-1 修复的核心） ==================== */

/**
 * 🔴 根因（v0.5.0 及之前）：版本检测的地址取的是**用户在高级设置里手填的服务地址**
 *    （settings.glmEndpoint）。用户不填 → checkUpdate 直接回 not_configured →
 *    「点击检查更新没反应 / 提示还没配置服务地址」。而站点根目录本来就有 version.json，
 *    它和 App 是同一次部署发布的，**根本不需要用户配置**。
 *
 * 修法：版本源改为「同源优先 + 配置地址兜底」。
 *   ① `${同源}/version.json` —— 权威源。与 App 同一次部署，永远和 App 自身一致。
 *   ② `${配置地址}/api/version` —— Worker 形态的动态接口（KV 可改，不用重部署前端）。
 *   ③ `${配置地址}/version.json` —— 配置地址本身就是一个静态站点时的形态。
 * ②③ 只在①不可达时兜底，且**只有用户真的填了地址才存在**。
 *
 * 为什么不是「多源取最高版本」：那样一旦 KV 被手滑写进 9.9.9，全员被卡在假更新上，
 * 风险和 is_force 手滑同级。同源是发布真相，配置源只是容灾。
 */
export const VERSION_PATH = '/version.json';
export const WORKER_API_VERSION_PATH = '/api/version';

/**
 * APK 端的**内置远端版本源**。
 *
 * 🔴 这是本轮发现的第二个真缺陷（比"没反应"更隐蔽）：
 *    APK 里 WebView 的 origin 恒为 `https://localhost`（capacitor androidScheme=https），
 *    同源 `/version.json` 读到的就是**包内自带的那一份** —— 它永远等于当前版本。
 *    于是 APK 每次检查都是「已是最新版本✨」，更新功能对 APK **彻底失效**，
 *    而 Web 端一切正常、自测也全绿（自测跑在 127.0.0.1，同源就是真站点）。
 *    ⇒ APK 必须问**包外**的远端；同源那条对它只会在"自己问自己"。
 *
 * 为什么是硬编码域名：这就是产品自己的更新服务器地址（等同 App 的 update server），
 * 不该要求用户手填。站长换域名时改这一处即可。
 */
export const BUILTIN_REMOTE_ORIGIN = 'https://zhenxuji.pages.dev';

/**
 * 是否是「APK 内置本地壳」的 origin（Capacitor 把包内资源挂在 localhost 上）。
 * 只用于识别"同源其实是自己"，不是安全判定。
 */
export function isLocalShellOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(origin || '').trim());
}

/**
 * 把 origin / href 归一成站点根（`https://host[:port]`）。
 * 🔴 只接受 http(s)：file:// 下 fetch 必然失败，留着只会白等一个超时。
 * @returns {string} 站点根；不可用时返回 ''
 */
export function siteOrigin(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch (_) {
    return '';
  }
}

/**
 * 解析版本源候选列表（有序 = 优先级）。
 *
 * 同源优先是 Web 端的正解（同一份部署里 version.json 与 App 一起发布，永远一致）；
 * 但 **APK 端必须跳过同源**（同源 = 包内自带的自己，问不出更新），改用内置远端源。
 *
 * @param {object} o { origin, baseUrl, isApk }
 * @returns {string[]} 完整 URL 列表；一个都没有时返回 []
 */
export function resolveVersionSources({ origin, baseUrl, isApk = false } = {}) {
  const out = [];
  const seen = new Set();
  const push = (url) => {
    const u = String(url || '').trim();
    if (!u) return;
    const key = u.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u);
  };

  const home = siteOrigin(origin);
  const homeIsSelf = isApk && isLocalShellOrigin(home);
  // APK 的"同源"是包内自己 → 跳过，免得报一个假的"已是最新"
  if (home && !homeIsSelf) push(home + VERSION_PATH);
  // APK 真正的第一源：包外的线上站点
  if (homeIsSelf) push(BUILTIN_REMOTE_ORIGIN + VERSION_PATH);

  // 用户配置的服务地址：**兜底**，不再是唯一来源
  const base = siteOrigin(baseUrl);
  if (base) {
    push(base + WORKER_API_VERSION_PATH);
    push(base + VERSION_PATH);
  }
  return out;
}

/**
 * 把 version.json 里的 update_url 解析成可直接打开的绝对地址。
 * 支持两种写法：
 *   - 绝对地址 `https://host/a.apk` —— 直通（换 CDN / 换仓库都用这种）
 *   - 站点根相对路径 `/apk/zhenxuji-latest.apk` —— 用**版本源自己的 origin** 补齐。
 *     相对写法让同一份配置在 pages.dev / 自定义域名 / APK 内置 www 下都能用，
 *     不用把域名写死进配置。
 * 🔴 明确拒绝 `//evil.com/x` 这种 protocol-relative 写法：它会被浏览器当成外站，
 *    运营手滑或被注入时就是一条静默外链。
 * @returns {string} 绝对地址；不可用时 ''
 */
export function resolveUpdateUrl(rawUrl, sourceUrl = '') {
  const u = String(rawUrl || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//') || !u.startsWith('/')) return '';   // 只认站点根相对路径
  try {
    return new URL(u, sourceUrl || 'https://invalid.local').href;
  } catch (_) {
    return '';
  }
}

/* ==================== 纯逻辑层（可独立断言） ==================== */

/**
 * 语义化版本比较：'0.3.1' vs '0.3.0'
 * @returns {number} >0 表示 a 更新；0 相同；<0 表示 a 更旧
 */
export function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 远端配置是否比当前版本新 */
export function hasUpdate(current, remote) {
  return compareVersion(remote, current) > 0;
}

/** 读取"稍后提醒"时间戳；无记录返回 0 */
export function readSnooze() {
  try {
    return Number(localStorage.getItem(LS_SNOOZE) || 0) || 0;
  } catch (_) {
    return 0;   // 隐私模式下 localStorage 可能抛错，不许因此崩掉启动
  }
}

export function writeSnooze(at = Date.now()) {
  try { localStorage.setItem(LS_SNOOZE, String(at)); } catch (_) { /* 忽略 */ }
}

export function clearSnooze() {
  try { localStorage.removeItem(LS_SNOOZE); } catch (_) { /* 忽略 */ }
}

/**
 * 是否允许**自动**弹窗。
 * @param {object} o { now, snoozeAt, isForce }
 * 🔴 强制更新**不受冷却限制**（方案只约束"自动弹窗"的骚扰，
 *    而强制更新的定义就是"必须更新"，被 24h 挡住等于形同虚设）。
 */
export function shouldAutoPrompt({ now = Date.now(), snoozeAt = 0, isForce = false } = {}) {
  if (isForce) return true;
  if (!snoozeAt) return true;
  return now - snoozeAt >= COOLDOWN_MS;
}

/** 距离下次可自动弹窗还有多久（ms）；0 = 现在就能弹 */
export function cooldownLeft(now = Date.now(), snoozeAt = 0) {
  if (!snoozeAt) return 0;
  return Math.max(0, snoozeAt + COOLDOWN_MS - now);
}

/** 把剩余毫秒说成人话（更新日志与提示里要用） */
export function humanizeCooldown(ms) {
  if (ms <= 0) return '';
  const h = Math.ceil(ms / 3600000);
  if (h < 24) return `${h} 小时`;
  return `${Math.ceil(h / 24)} 天`;
}

/* ==================== 配置读取层 ==================== */

/**
 * 远端 version.json 的形状校验。
 * 方案给的字段：latest_version / is_force / update_url / update_content / update_time
 * 🔴 任何字段缺失/类型不对都必须归一成安全值，**绝不把脏数据带进 UI**。
 * @param {any} raw       远端原始 JSON
 * @param {object} opts   { sourceUrl } 该份配置是从哪个源拿到的，用于补全相对 update_url
 */
export function normalizeConfig(raw, { sourceUrl = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const ver = String(raw.latest_version || '').trim();
  if (!/^\d+(\.\d+){0,3}$/.test(ver)) return null;      // 不是合法版本号 → 视为配置损坏
  const updateUrl = resolveUpdateUrl(raw.update_url, sourceUrl);
  return {
    latestVersion: ver,
    // 🔴 端侧也要做「强制 + 无下载地址 → 降级为可选」。
    //    Worker 的 handleVersion 有这条降级，但端侧直连 CF Pages 的静态
    //    /version.json 时**根本不经过 Worker**，降级不会生效。
    //    缺地址还硬报强制更新 → performUpdate 在 PWA 端会谎报"刷新即更新"，
    //    用户 reload 完发现什么都没变，体验比不提示更糟。
    isForce: raw.is_force === true && !!updateUrl,
    updateUrl,
    // 方案 §2.9.5：更新文案禁止技术术语。若运营写了技术文案，前端兜底成中性表述。
    content: sanitizeChangelog(String(raw.update_content || '')),
    updateTime: String(raw.update_time || '').trim(),
  };
}

/** 技术术语黑名单：出现即替换（方案 §2.9.5 硬性要求） */
// 🔴 带裸词的条目一律加 \b 词边界：`/api/` 会把 rapid、captain 里的
//    "api" 也替换掉，更新日志里混一个英文单词就被误伤，用户看到
//    "这是 rapid 的优化" 这种莫名其妙的话。
// 🔴 但 `HTTP + 3位数字`（HTTP 500）必须**整体替换**，不能拆成两个词处理 ——
//    方案 §2.9.5 禁的是"HTTP 后面跟状态码"这个整体，只把 HTTP 换掉、
//    留下 500 反而更容易让人困惑。所以它排在裸词条目**之前**，先被吃掉。
const TECH_JARGON = [
  /\bhttp\s*\d{3}\b/gi,
  /\bapi\b/gi, /\bsdk\b/gi, /\bendpoint/gi, /\btoken/gi, /\blatency\b/gi, /\btimeout\b/gi,
  /\bcache\s*miss\b/gi, /\bnull\s*pointer\b/gi, /\bexception/gi, /\bstack\s*trace\b/gi,
  /\bjson\b/gi, /\bbug\b/gi, /\bcrash\b/gi, /\bdebug\b/gi, /\bworker/gi, /\bkv\b/gi,
  /\bsql\b/gi, /\bgcc\b/gi, /\bide\b/gi, /\blocalhost\b/gi, /\bgpu\b/gi, /\bcpu\b/gi,
  /\bhttp\b/gi,
];

/**
 * 文案里是否残留技术术语。
 * 给**构建期闸门**用（scripts/build-web.mjs 直接 import 本文件，Node 侧跑）：
 * 运营手写 version.json 时把「HTTP 500」写进去，必须在构建就拦下，
 * 而不是等用户看到「优化 500 的优化」这种鬼话。
 * 🔴 必须每次新建 RegExp：带 /g 的正则 test() 会消耗 lastIndex，
 *    复用同一个实例做多次 test 会漏判（第一次命中后 lastIndex 停住）。
 */
export function hasTechJargon(text) {
  const s = String(text || '');
  return TECH_JARGON.some((re) => new RegExp(re.source, re.flags).test(s));
}

/**
 * 清洗更新文案：去技术术语 + 收敛空白 + 限长。
 *
 * 🔴 踩坑（已实测确认，勿再改回一行写法）：
 *    `str.replace(/正则数组/, 'x')` **完全无效** —— replace 的第一个参数
 *    只能是 RegExp 或 string，传数组会被 toString() 成 "/api/gi,/crash/gi"，
 *    永远匹配不上。改成回调形式 `() => '优化'` 同样无效。
 *    正确写法只有逐个串接这一种。
 */
export function sanitizeChangelog(text, max = 300) {
  let s = String(text || '').replace(/[<>]/g, '');   // 防注入：文案会被插进 innerHTML
  for (const re of TECH_JARGON) s = s.replace(re, '优化');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

/* ==================== 网络层 ==================== */

/**
 * 拉取**某一个**版本源。
 * @param {string} sourceUrl  完整 URL（由 resolveVersionSources 产出）
 * @param {object} opts       { manual }
 * @returns {Promise<{ok, config?, code, silent}>}
 *   silent=true 表示"静默失败"，调用方在自动模式下**不得**弹任何提示（方案 §2.9.6）。
 */
export async function fetchVersionConfig(sourceUrl, opts = {}) {
  const url = String(sourceUrl || '').trim();
  if (!url) return { ok: false, code: 'no_source', silent: true };

  const ms = opts.manual ? MANUAL_TIMEOUT_MS : SILENT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return { ok: false, code: 'bad_status', status: res.status, silent: true };
    const json = await res.json().catch(() => null);
    // sourceUrl 带进归一化：version.json 里写相对路径的 update_url 靠它补齐
    const cfg = normalizeConfig(json, { sourceUrl: url });
    if (!cfg) return { ok: false, code: 'bad_config', silent: true };
    return { ok: true, config: cfg, source: url };
  } catch (e) {
    const code = e?.name === 'AbortError' ? 'timeout' : 'offline';
    return { ok: false, code, message: String(e?.message || e), silent: !opts.manual };
  } finally {
    clearTimeout(timer);
  }
}

/* ==================== 编排层 ==================== */

/**
 * 检查更新。
 * @param {object} o
 *   baseUrl  用户配置的服务地址（**可选**，只作为同源不可达时的兜底源）
 *   sources  显式指定版本源列表（测试用；给了就完全接管解析）
 *   origin   站点根，默认取 location.origin
 *   current  当前版本号
 *   manual   是否为用户手动触发（手动绕过 24h 冷却，且失败必须给交代）
 *   isApk    是否 APK 环境（决定跳转下载 vs 提示刷新）
 * @returns {Promise<Object>} { ok, needUpdate, isForce, config, code, silent, msg, cooldownLeft }
 */
export async function checkUpdate({
  baseUrl, sources, origin, current, manual = false, isApk = null,
} = {}) {
  const inApk = isApk == null ? detectApk() : isApk;

  const home = origin === undefined || origin === null
    ? (typeof location !== 'undefined' ? location.origin : '')
    : origin;
  const list = Array.isArray(sources)
    ? sources.filter(Boolean)
    : resolveVersionSources({ origin: home, baseUrl, isApk: inApk });

  // 一个源都没有：只可能发生在 file:// 且用户没填地址时。
  // 🔴 用户主动点的必须给交代，且文案要是人话（方案 §2.9.4 网络异常口径）。
  if (!list.length) {
    return { ok: false, code: 'no_source', needUpdate: false, silent: false, inApk,
             msg: '网络暂时无法获取版本信息，请稍后重试' };
  }

  // 🔴 并行发全部源，取**优先级最高的成功者**。
  //    串行会让静默检测的总耗时随源数量线性增长（冷启动最贵的资源就是这几秒）；
  //    并行下总耗时 ≈ 最慢的那一个，源数量翻倍也不加等待。
  const tries = await Promise.all(list.map((u) => fetchVersionConfig(u, { manual })));
  const hit = tries.find((r) => r.ok) || null;

  if (!hit) {
    // 全部失败 → 用**优先级最高那个源**的失败原因归因（不是一个笼统的"网络异常"）
    const first = tries[0] || { code: 'offline', silent: true };
    return {
      ok: false, code: first.code, needUpdate: false, inApk,
      // 🔴 自动检测一律静默（方案 §2.9.6）；手动检测才提示
      silent: !manual,
      msg: manual ? '网络暂时无法获取版本信息，请稍后重试' : '',
    };
  }

  const cfg = hit.config;
  const need = hasUpdate(current, cfg.latestVersion);
  if (!need) {
    // 方案 §2.9.4：已是最新 → 轻提示「已是最新版本✨」
    return { ok: true, needUpdate: false, isForce: false, config: cfg, source: hit.source,
             inApk, silent: false, msg: manual ? '已是最新版本✨' : '' };
  }

  // 强制更新直接放行；可选更新要过冷却
  const snoozeAt = readSnooze();
  const allow = manual || shouldAutoPrompt({ isForce: cfg.isForce, snoozeAt });
  if (!allow) {
    const left = cooldownLeft(Date.now(), snoozeAt);
    return { ok: true, needUpdate: true, isForce: false, config: cfg, source: hit.source, inApk,
             suppressed: true, cooldownLeft: left, silent: true,
             msg: manual ? '' : `已经提醒过你啦，${humanizeCooldown(left)}后再来打扰` };
  }

  return { ok: true, needUpdate: true, isForce: cfg.isForce, config: cfg, source: hit.source,
           inApk, silent: false, msg: '' };
}

/** 点「稍后提醒」→ 记时间戳，进入 24h 冷却 */
export function snooze() { writeSnooze(Date.now()); }

/** 用户点了「立即更新」→ 清掉冷却记录（否则下次冷启动还会再拦一次没意义） */
export function markUpdated() { clearSnooze(); }

/* ==================== 本机版本追踪（应用版本变更检测） ==================== */

/**
 * 读取上次运行记录的本机版本号；无记录返回 ''。
 * 用 localStorage 而非 sessionStorage —— 后者跨刷新/跨版本切换照样留得住，
 * 这正是旧实现"版本更新后没再弹"的根因之一。
 */
export function readAppVersion() {
  try { return String(localStorage.getItem(LS_APP_VERSION) || ''); } catch (_) { return ''; }
}

/** 写入本次运行的本机版本号（隐私模式抛错也不许崩） */
export function writeAppVersion(v) {
  try { localStorage.setItem(LS_APP_VERSION, String(v)); } catch (_) { /* 忽略 */ }
}

/**
 * 判断**本机版本**是否相对上次运行发生了变化。
 *
 * 🔴 这是"应用版本变更时自动弹出版本信息"的核心判定：
 *    - 首装（无记录）→ 不算变更，不弹（首装就弹"你已更新"是废话）。
 *    - 上次 == 当前 → 没变，不弹。
 *    - 上次存在且 != 当前 → 应用自身刚被更新（新 APK / PWA 刷到新版本）→ 视为变更。
 *      同时**就地把记录更新成当前版本**，避免下次又误判成"又变了一次"。
 *
 * @param {string} current 当前 window.APP_VERSION
 * @returns {{changed:boolean, from:string, to:string}}
 */
export function detectAppVersionChange(current) {
  const last = readAppVersion();
  const cur = String(current || '');
  if (!last) { writeAppVersion(cur); return { changed: false, from: '', to: cur }; }
  if (last === cur) return { changed: false, from: last, to: cur };
  writeAppVersion(cur);
  return { changed: true, from: last, to: cur };
}

/* ==================== 平台适配（方案 §2.9.7） ==================== */

/**
 * 是否运行在 APK 里。
 * 判定顺序：Capacitor 注入的全局 > URL scheme（Capacitor Android 固定 https://localhost）
 */
export function detectApk() {
  try {
    const g = globalThis;
    if (g.Capacitor?.isNativePlatform?.()) return true;
    if (g.Capacitor?.getPlatform?.() === 'android') return true;
    // 供 CI / 调试强制指定
    if (localStorage.getItem('zhenxuji.forceApk') === '1') return true;
    const sch = String(location.protocol || '');
    if (sch === 'capacitor:' || sch === 'ionic:') return true;
  } catch (_) { /* 忽略 */ }
  return false;
}

/** 判断是否真正在 Capacitor 原生环境（而不是浏览器/PWA 但 forceApk=1 的测试环境） */
function isNativeCapacitor() {
  try {
    return globalThis.Capacitor?.isNativePlatform?.() === true;
  } catch (_) { return false; }
}

/** 把 ArrayBuffer 转成 base64 字符串，供 Filesystem 写二进制文件（不指定 encoding 时传 base64） */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  if (len === 0) return '';
  const chunk = 32768; // 避免一次性 String.fromCharCode.apply 参数过多
  let binary = '';
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 在真正的 APK 原生环境里：下载新版 APK → 写到缓存目录 → 调用系统安装器。
 * 不离开应用（除 Android 系统强制的「允许安装未知应用」设置页）。
 *
 * @param {string} url APK 下载地址
 * @returns {Promise<{ok:boolean, msg:string}>}
 */
async function installApkInApp(url) {
 const Plugins = globalThis.Capacitor?.Plugins;
  if (!Plugins?.AppInstallPlugin || !Plugins?.Filesystem) {
    throw new Error('原生安装组件未就绪');
  }

  const AppInstallPlugin = Plugins.AppInstallPlugin;
  const Filesystem = Plugins.Filesystem;

  // 1. 检查安装未知应用权限（Android 8+ 必需）
  const { granted } = await AppInstallPlugin.canInstallUnknownApps();
  if (!granted) {
    // 系统会跳到设置页，用户开启后需再点一次「立即更新」
    await AppInstallPlugin.openInstallUnknownAppsSettings();
    return { ok: false, msg: '请在系统设置中允许「安装未知应用」后，再次点击立即更新' };
  }

  // 2. 下载 APK（走 WebView fetch；GitHub Release 下载地址允许跨域）
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const blob = await res.blob();
  const ab = await blob.arrayBuffer();

  // 3. 写到应用缓存目录（base64 字符串，不指定 encoding，Filesystem 会解码）
  const fileName = 'zhenxuji-update.apk';
  await Filesystem.writeFile({
    path: fileName,
    directory: 'CACHE',
    data: arrayBufferToBase64(ab),
  });

  // 4. 取绝对路径并去掉 file:// 前缀（installApk 需要绝对路径）
  const uriResult = await Filesystem.getUri({ path: fileName, directory: 'CACHE' });
  const filePath = String(uriResult?.uri || '').replace(/^file:\/\//, '');
  if (!filePath) throw new Error('无法取得 APK 文件路径');

  // 5. 触发系统安装器
  const result = await AppInstallPlugin.installApk({ filePath });
  return { ok: true, msg: result?.message || '安装器已打开，请确认安装' };
}

/**
 * 执行更新。
 * APK  → 真正原生环境：应用内下载并安装；测试/PWA：打开下载地址
 * PWA  → 提示刷新页面（Service Worker 接管新资源，刷新即生效）
 * @returns {Promise<{mode:'apk'|'pwa', ok:boolean, msg:string}>}
 */
export async function performUpdate(config, inApk) {
  const url = String(config?.updateUrl || '').trim();
  if (inApk) {
    if (!url) return { mode: 'apk', ok: false, msg: '暂时没有可用的下载地址' };

    // 真正 APK 原生环境：走应用内下载安装
    if (isNativeCapacitor()) {
      try {
        const r = await installApkInApp(url);
        return { mode: 'apk', ok: r.ok, msg: r.msg };
      } catch (e) {
        return { mode: 'apk', ok: false, msg: `更新失败：${e.message || '请稍后重试'}` };
      }
    }

    // 非原生环境（浏览器测试 / PWA 强制 APK 模式）：保留旧行为，便于测试和兜底
    try {
      window.open(url, '_blank', 'noopener');
      return { mode: 'apk', ok: true, msg: '已经开始下载新版本' };
    } catch (e) {
      return { mode: 'apk', ok: false, msg: '没能打开下载页面，请稍后再试' };
    }
  }
  // 🔴 PWA 端同样要验地址：没有下载地址就只刷新 = 什么都没更新，
  //    还跟用户说"新版本就生效啦"是骗人。宁可明确说没配好。
  if (!url) return { mode: 'pwa', ok: false, msg: '还没有配置新版本下载地址，暂时无法更新' };
  return { mode: 'pwa', ok: true, msg: '页面即将刷新，新版本就生效啦' };
}
