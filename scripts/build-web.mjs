// 把"真正属于 App 的文件"拷贝到 www/，供 Capacitor 打包。
// 目的：webDir 不能指向仓库根（会把 node_modules/android 一起塞进 APK）。
// 三道防线沿用 Sinoky 实战经验：
//   ① 归类断言（新条目忘了归类 → 直接失败，防"该上线的没上线/内部文件被上线"）
//   ② 行尾 LF 规范化（本地 CRLF vs CI LF，否则逐行 diff 全噪，真实差异看不见）
//   ③ 依赖闭包校验（漏带 js 模块 → 页面静默挂掉，必须构建期暴露而非运行期）
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, '..');           // 帧叙集-app/
const out = path.join(src, 'www');

const DIRS = ['js', 'icons'];
const FILES = [
  'index.html', 'styles.css', 'sw.js', 'manifest.webmanifest',
  // 版本配置（方案 §2.9）：APK 内置一份兜底，同时线上 CF Pages 也能覆盖它
  'version.json',
  // CF Pages 响应头：给 version.json 加跨域许可。APK（origin=https://localhost）
  // 要跨域读线上版本清单，没有这个文件就会被 CORS 静默拦掉（详见 _headers 里的说明）
  '_headers',
];

const EXCLUDE = new Set([
  '.git', '.github', '.gitignore', '.wrangler', '.dev.vars', '.env',
  'node_modules', 'android', 'www', 'scripts', 'package.json', 'package-lock.json',
  'capacitor.config.json', '_selftest', '_internal', 'worker',
  '.workbuddy',
  // theme/ 是主题配置源（packs.json + 生成物），运行时用的是 js/theme.js，不进包
  'theme',
  // apk-dist/ 是出包产物目录，绝不进包（否则 APK 把自己套进去，体积翻倍）
  'apk-dist',
]);

/* ── ① 归类断言 ────────────────────────────────────────────── */
const unclassified = (await readdir(src, { withFileTypes: true }))
  .map((e) => e.name)
  .filter((n) => !DIRS.includes(n) && !FILES.includes(n) && !EXCLUDE.has(n) && !/\.(log|jks)$/.test(n));
if (unclassified.length) {
  console.error('[build:web] ✗ 仓库根有未归类条目：');
  unclassified.forEach((n) => console.error('   - ' + n));
  console.error('   → 该上线：加进 DIRS / FILES；不该上线：加进 EXCLUDE');
  throw new Error('unclassified root entries: ' + unclassified.join(', '));
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const d of DIRS) await cp(path.join(src, d), path.join(out, d), { recursive: true });
for (const f of FILES) {
  try { await cp(path.join(src, f), path.join(out, f)); }
  catch (e) { console.warn('skip missing file:', f); }
}

/* ── ② 行尾规范化 LF ────────────────────────────────────────── */
const TEXT_EXT = /\.(html?|js|mjs|cjs|json|webmanifest|css|txt|xml|md|svg)$/i;
let normalized = 0;
const walkText = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { await walkText(fp); continue; }
    if (!TEXT_EXT.test(e.name)) continue;
    const buf = readFileSync(fp);
    if (!buf.includes(13)) continue;
    writeFileSync(fp, Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
    normalized++;
  }
};
await walkText(out);
console.log('[build:web] 行尾规范化 LF —', normalized, '个文本文件已转换');

/* ── 版本号：单一事实源在 index.html，绝不手写 ────────────────── */
const html = readFileSync(path.join(src, 'index.html'), 'utf8');
const m = html.match(/window\.APP_VERSION = '([\d.]+)'/);
if (!m) throw new Error('APP_VERSION not found in index.html');
const version = m[1];

/* 版本四处同步闸门（漏一处 = 老缓存永不更新 / 页脚显示旧版本） */
const checks = [
  ['sw.js', new RegExp(`zhenxuji-v${version.replace(/\./g, '\\.')}`)],
  ['manifest.webmanifest', new RegExp(`"version":\\s*"${version.replace(/\./g, '\\.')}"`)],
];
for (const [f, re] of checks) {
  const txt = readFileSync(path.join(src, f), 'utf8');
  if (!re.test(txt)) throw new Error(`版本号不同步：${f} 未包含 ${version}`);
}

/* 安卓侧版本闸门（v0.4.0 踩过的坑）
   versionName 写 0.4.0、versionCode 却忘了改（还是 0.3.1 的 301）→ 已装 0.3.1 的机器
   判定"同版本/降级"，包根本装不上去，而 Web 侧四处同步闸门是全绿的、看不出来。
   规则：MA*10000 + MI*100 + PA（0.5.0 → 500）。 */
const gradlePath = path.join(src, 'android', 'app', 'build.gradle');
if (existsSync(gradlePath)) {
  const gradle = readFileSync(gradlePath, 'utf8');
  const [MA, MI, PA] = version.split('.').map((n) => parseInt(n, 10));
  const wantCode = MA * 10000 + MI * 100 + PA;
  const gotName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
  const gotCode = parseInt((gradle.match(/versionCode\s+(\d+)/) || [])[1], 10);
  if (gotName !== version) {
    throw new Error(`安卓 versionName 不同步：build.gradle 是 ${gotName}，index.html 是 ${version}`);
  }
  if (gotCode !== wantCode) {
    throw new Error(`安卓 versionCode 不对：build.gradle 是 ${gotCode}，按 ${version} 应为 ${wantCode}（否则老版本用户装不上新包）`);
  }
  console.log(`[build:web] android versionName=${gotName} versionCode=${gotCode} OK`);
}
console.log('[build:web] version =', version, '| 四处同步 OK');

/* 内置服务地址闸门（P0-1 同源问题在 AI 文案上的第二现场）
   产品自有的服务地址必须**内置**，不能指望用户在设置页手填 ——
   真机反馈里「未配置模型服务地址，使用本地文案」就是这条漏了。
   留空不中断构建（本地开发、只测界面时是合法的），但必须**喊得足够响**：
   出包前一眼看不见，就会把一个"智能文案永远用不了"的包发出去。 */
{
  const rt = readFileSync(path.join(src, 'js', 'runtime.js'), 'utf8');
  const got = (rt.match(/BUILTIN_API_ORIGIN\s*=\s*'([^']*)'/) || [])[1];
  if (got === undefined) throw new Error('js/runtime.js 里找不到 BUILTIN_API_ORIGIN 声明');
  if (!got) {
    console.warn('\n' + '='.repeat(66));
    console.warn('⚠️  内置服务地址为空：BUILTIN_API_ORIGIN = \'\'');
    console.warn('    → 智能文案 / 手记生成会**一直**走本地兜底（不是 AI 写的）');
    console.warn('    → 部署 Worker 后把地址填进 js/runtime.js，用户端零配置即可生效');
    console.warn('='.repeat(66) + '\n');
  } else if (!/^https?:\/\//i.test(got)) {
    throw new Error(`BUILTIN_API_ORIGIN 必须是 http(s) 绝对地址，当前是 ${JSON.stringify(got)}`);
  } else {
    console.log('[build:web] 内置服务地址 =', got);
  }
}

/* 版本服务清单闸门（P0-1）
   版本更新能不能用，全看这份 version.json 是否合法。它是**运营手写**的文件，
   最容易出的三类错都不在运行期暴露、而是让用户看到莫名其妙的坏体验：
     ① JSON 写坏 → 端侧 bad_config → 点了检查更新说"读不到更新信息"
     ② 文案带技术术语（HTTP 500 / API）→ 用户看到黑话（方案 §2.9.5 明令禁止）
     ③ is_force 为真却没有下载地址 → 强制更新弹窗点下去没反应，用户被彻底卡死
   闸门直接 import 端侧同一份规则（js/update.js），规则只有一处真相，不会两边漂。 */
const { hasTechJargon, resolveUpdateUrl } = await import('../js/update.js');
{
  const vjPath = path.join(src, 'version.json');
  let vj;
  try {
    vj = JSON.parse(readFileSync(vjPath, 'utf8'));
  } catch (e) {
    throw new Error(`version.json 不是合法 JSON：${e.message}`);
  }
  const lv = String(vj.latest_version || '').trim();
  if (!/^\d+(\.\d+){0,3}$/.test(lv)) throw new Error(`version.json latest_version 非法：${JSON.stringify(vj.latest_version)}`);

  const content = String(vj.update_content || '');
  if (!content.trim()) throw new Error('version.json update_content 为空（更新弹窗会是空白）');
  if (content.length > 600) throw new Error(`version.json update_content 过长（${content.length} > 600）`);
  if (hasTechJargon(content)) throw new Error(`version.json update_content 含技术术语，普通用户看不懂：${content.slice(0, 60)}…`);

  const url = String(vj.update_url || '').trim();
  // 🔴 用**端侧同一个函数**判定，绝不在这里另写一份规则。
  //    实测踩过：自写规则写成「以 / 开头就算合法」，于是 `//evil.com/a.apk`
  //    构建期放行、端侧 resolveUpdateUrl 却把它丢掉 —— 闸门说 OK、运行时静默失效，
  //    这种"闸门自己撒谎"比没有闸门更坏。规则只有一处真相，就不会漂。
  //    （origin 用占位域名：构建期不知道最终部署在 pages.dev 还是自定义域名，
  //      相对路径本来就该跟着运行时域名走。）
  const resolvedUrl = resolveUpdateUrl(url, 'https://example.invalid/version.json');
  if (url && !resolvedUrl) {
    throw new Error(`update_url 解析不出可打开的地址：${JSON.stringify(url)}（只接受 https://… 或 / 开头的站点根相对路径；//host/… 会被浏览器当外站，不受支持）`);
  }
  if (vj.is_force === true && !resolvedUrl) {
    throw new Error(`is_force=true 但 update_url 不是可用的 http(s) 绝对地址（${JSON.stringify(url)}）—— 强制更新没有下载地址会把用户卡死`);
  }
  console.log(`[build:web] version.json OK — latest=${lv} force=${vj.is_force === true} url=${resolvedUrl || '(空，将明确提示暂无下载地址)'}`);
}

/* ── 体积基线（cap sync 不读 .gitignore，混入归档会把 APK 撑爆）── */
const size = async (p) => {
  let total = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      const st = await stat(fp);
      if (st.isDirectory()) await walk(fp); else total += st.size;
    }
  };
  await walk(p);
  return total;
};
const mb = Math.round((await size(out)) / 1024 / 1024 * 100) / 100;
if (mb > 20) throw new Error(`web 资产 ${mb}MB 超过 20MB 上限，检查是否混入 node_modules/归档`);
console.log('[build:web] www size =', mb, 'MB');

/* ── ③ 依赖闭包校验 ────────────────────────────────────────── */
const missing = [];
const jsFiles = [];
const walkJs = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) await walkJs(fp);
    else if (/\.m?js$/.test(e.name)) jsFiles.push(fp);
  }
};
await walkJs(out);

const IMPORT_RE = /(?:^|[^\w$])(?:import\s+[^'"]*?from\s*|import\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/gm;
for (const f of jsFiles) {
  for (const mm of readFileSync(f, 'utf8').matchAll(IMPORT_RE)) {
    const target = path.join(path.dirname(f), mm[1]);
    if (!existsSync(target)) missing.push(`${path.relative(out, f).replace(/\\/g, '/')} → ${mm[1]}`);
  }
}

// HTML 的本地 script src / stylesheet href（相对路径必须相对**本文件所在目录**解析）
const htmlFiles = [];
const walkHtml = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) await walkHtml(fp);
    else if (/\.html?$/i.test(e.name)) htmlFiles.push(fp);
  }
};
await walkHtml(out);
for (const f of htmlFiles) {
  const txt = readFileSync(f, 'utf8');
  const rel = path.relative(out, f).replace(/\\/g, '/');
  const dir = path.dirname(f);
  const local = (u) => u && !/^(https?:|\/\/|data:|mailto:|#)/.test(u);
  const resolveLocal = (u) => (u.startsWith('/') ? path.join(out, u) : path.join(dir, u));
  for (const mm of txt.matchAll(/<script[^>]+src=["']([^"'#:?]+)["']/g)) {
    if (local(mm[1]) && !existsSync(resolveLocal(mm[1]))) missing.push(`${rel} → ${mm[1]}`);
  }
  for (const tag of txt.match(/<link[^>]*>/g) || []) {
    if (!/rel=["']stylesheet["']/i.test(tag)) continue;
    const h = tag.match(/href=["']([^"'#:?]+)["']/);
    if (h && local(h[1]) && !existsSync(resolveLocal(h[1]))) missing.push(`${rel} → ${h[1]}`);
  }
}

if (missing.length) {
  console.error('[build:web] ✗ 包内依赖缺失：');
  missing.forEach((x) => console.error('   - ' + x));
  throw new Error('missing packaged dependency: ' + missing.join(', '));
}
console.log('[build:web] dependency closure OK —', jsFiles.length, 'js files checked');
