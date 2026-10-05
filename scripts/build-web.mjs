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
  // README.md 是仓库文档，不是 App 资产。
  // 🔴 它进工作区的方式是 `git rebase`（远端 auto_init 那次提交的 README），
  //    归类闸门挡是对的 —— 挡的不是"文件新出现"，而是"文档被当成了要上线的资产"。
  'README.md',
  // 🔴 docs/ 同理：仓库文档 + 主题预览页（docs/album-theme-preview.html）。
  //    它是 PR#1 随分支规范一起进来的，归类清单当时漏了它，
  //    于是 `npm run build:web` / `npm run cap:sync` 在 main 上就直接抛错 ——
  //    闸门本身是对的（未归类即失败），错的是清单没跟上。
  'docs',
  // 🔴 functions/ = Cloudflare Pages Functions（/api/* 反代到 Worker）。
  //    它是**服务端代码**，只该进 Pages 部署包，**绝不进 www/**：
  //      ① 打进 APK 是纯浪费（用户下载用不到的服务端代码）；
  //      ② 里面含 Worker 上游地址，进包等于把后端地址分发给每个用户。
  //    它的去处在 build:web 末尾：单独复制进 _pages/ 部署根（见该段注释）。
  'functions',
  // _pages/ 是本脚本产出的「Pages 部署根」（静态资产 + functions），属构建产物
  '_pages',
  // _pages_probe/ 是验证代理方案时的一次性目录，已废弃
  '_pages_probe',
  // 🔴 assets/ 是**图标生成器的输入**（assets/icon/frame-glyph.png 字形位图 +
  //    测量 JSON），由 scripts/extract-icon-glyph.py 从设计稿产出、入库。
  //    它的产物是 icons/*.png（那才进包），源图本身不该被分发给用户 ——
  //    既是体积浪费，也把「设计中间物」当成了 App 资产。
  'assets',
  // app-icon-proposals/ = 历代图标设计提案（多轮 AI 出图 + 对比板 + 矢量化尝试），
  //    是**设计过程存档**，不是 App 资产。真正要留档的最终版已抄进 docs/。
  'app-icon-proposals',
  // concept-images/ = 产品概念图（主视觉 / 使用场景 / 核心功能），同样是设计存档。
  'concept-images',
  // PRODUCT-AUDIT-*.md = 全功能实测审计报告，是过程文档，不进 App 包。
  // 文件名带日期，用通配不方便，直接排除本次生成的具体文件；后续新增同模式文件需同步。
  'PRODUCT-AUDIT-2026-10-04.md',
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

/* ── ④ 生成 Pages 部署根 _pages/ ──────────────────────────────── */

/**
 * 🔴 为什么需要这一步（不是多此一举）：
 *    Cloudflare Pages Functions 要求 `functions/` 位于**部署根**，
 *    且**不能**在静态资产根（如 www/）里面 —— 官方文档明确写了这一点。
 *    所以不能只部署 www/，否则 /api/* 反代根本不会生效，
 *    表现为 App 请求 pages.dev/api/story 打到静态资源 → 404，
 *    而 App 会静默降级到本地兜底，界面上不报错（最难发现的那类故障）。
 *
 *    这个目录把两者拼在一起：
 *      _pages/          ← wrangler pages deploy _pages
 *        ├── (www/ 的内容，平铺)
 *        └── functions/ ← Pages Functions（/api/* → Worker）
 *
 *    与 www/ 严格分离：www/ 给 APK 用（cap copy android），**绝不能含 functions**
 *    （服务端代码进包既浪费又泄漏后端地址）；_pages/ 只给 Pages 用。
 */
const pagesOut = path.join(src, '_pages');
await rm(pagesOut, { recursive: true, force: true });
await mkdir(pagesOut, { recursive: true });
await cp(out, pagesOut, { recursive: true });
await cp(path.join(src, 'functions'), path.join(pagesOut, 'functions'), { recursive: true });

// 闸门：部署根必须同时具备「静态入口」与「函数入口」，缺一就是线上功能静默失效
const hasIndex = existsSync(path.join(pagesOut, 'index.html'));
const hasFn = existsSync(path.join(pagesOut, 'functions', 'api', '[[path]].js'));
if (!hasIndex || !hasFn) {
  console.error('[build:web] ✗ Pages 部署根不完整：');
  console.error('   index.html      :', hasIndex ? 'OK' : '缺失');
  console.error('   functions/api/  :', hasFn ? 'OK' : '缺失（/api/* 反代不会生效 → AI 文案静默退本地兜底）');
  throw new Error('incomplete pages deploy root');
}

// 闸门：functions/ 绝不能混进 www/（会跟着 cap copy 打进 APK）
if (existsSync(path.join(out, 'functions'))) {
  throw new Error('functions/ 泄漏进 www/ —— 会随 cap copy 打进 APK（浪费体积 + 分发后端地址）');
}

// 闸门：代理目标必须是可达域名。直连 workers.dev 在国内被阻断（实测），
// 一旦有人把内置地址改回 workers.dev，这里直接拦下。
const runtimeSrc = readFileSync(path.join(src, 'js', 'runtime.js'), 'utf8');
const mOrigin = runtimeSrc.match(/BUILTIN_API_ORIGIN\s*=\s*'([^']*)'/);
const builtinOrigin = mOrigin ? mOrigin[1] : '';
if (/\.workers\.dev/i.test(builtinOrigin)) {
  throw new Error(
    `BUILTIN_API_ORIGIN 指向 *.workers.dev（${builtinOrigin}）—— 该域名在国内被稳定阻断，`
    + '终端会连不上且静默降级。必须填站点自己的域名（由 functions/api 反代到 Worker）。'
  );
}

const pagesFiles = (await readdir(pagesOut, { recursive: true })).length;
console.log('[build:web] Pages 部署根 OK — _pages/（静态 + functions/api 反代）',
  pagesFiles, '条目；内置地址 =', builtinOrigin || '(空)');

