/**
 * verify-gen-theme.mjs — 主题生成器三重校验
 *
 * 要证明的命题（对应方案风险条目 1 的应对）：
 *   「建立 CSS变量/样式配置表，新增主题只需要修改配置文件，不用重写页面代码」。
 *
 * 三道闸门，各管一件事：
 *   ① 黄金快照回归  —— 配置改动是否**静默改变了界面色值**
 *      为什么需要：配色配置是最容易被顺手改坏的东西（改个 hex 谁看得出来？），
 *      而对比度闸门只管「读得清」，不管「还是原来那套颜色」。故把当前已验收的
 *      token 全量冻结成 theme/golden-tokens.json，任何漂移都必须显式重签（--bless）。
 *   ② 生成器无损性（ABA）—— 生成器能不能 1:1 复现线上 js/theme.js
 *      「生成器跑通」≠「生成器正确」：跑通只说明没抛异常。把线上产物反构造成
 *      配置再喂回生成器、逐值比对，才能证明这条链路可替换。
 *   ③ CSS 同步闸门  —— styles.css 的主题区是否 = 配置的生成结果
 *      为什么需要：promise 是「只改配置文件」。若改了 packs.json 忘了跑 gen:theme，
 *      就会得到「theme.js 有 8 套、CSS 只有 4 套」的静默错配 —— 界面纹丝不动且极难定位。
 *
 * 用法：
 *   node scripts/verify-gen-theme.mjs            # 校验
 *   node scripts/verify-gen-theme.mjs --bless    # 确认色值变更是有意的 → 重签黄金快照
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveTokens, buildThemeCss, CSS_BEGIN, CSS_END } from './gen-theme.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GOLDEN = join(ROOT, 'theme', 'golden-tokens.json');
const BLESS = process.argv.includes('--bless');

const live = await import(pathToFileURL(join(ROOT, 'js', 'theme.js')).href);
const rawPacks = JSON.parse(readFileSync(join(ROOT, 'theme', 'packs.json'), 'utf8'));
const selfTest = { rawPacks, live };

let failed = 0;
const line = (s) => console.log(s);

/* ============================================================
   闸门 ①：黄金快照回归
   ============================================================ */
const snapshot = {};
for (const pack of rawPacks.packs) {
  const t = deriveTokens(pack, rawPacks);
  snapshot[pack.key] = { light: t.light, dark: t.dark };
}

if (BLESS) {
  writeFileSync(GOLDEN, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  line(`[check:theme] 已重签黄金快照：${Object.keys(snapshot).length} 套主题 × 2 模式`);
}

const goldenDiff = [];
if (!existsSync(GOLDEN)) {
  goldenDiff.push('黄金快照文件缺失（先跑 node scripts/verify-gen-theme.mjs --bless 生成）');
} else {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const keys = new Set([...Object.keys(golden), ...Object.keys(snapshot)]);
  for (const k of keys) {
    if (!golden[k]) { goldenDiff.push(`${k}: 快照里没有这套主题（新增主题 → 需 --bless 重签）`); continue; }
    if (!snapshot[k]) { goldenDiff.push(`${k}: 配置里已经没有这套主题了`); continue; }
    for (const mode of ['light', 'dark']) {
      const a = golden[k][mode] || {};
      const b = snapshot[k][mode] || {};
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (String(a[f]) !== String(b[f])) {
          goldenDiff.push(`${k}/${mode}.${f}: 快照=${a[f]} 现在=${b[f]}`);
        }
      }
    }
  }
}

/* ============================================================
   闸门 ②：生成器无损性（把线上 theme.js 反构造成配置，再生成回来）
   ============================================================ */
const toColorObj = (t) => ({
  paper: t.paper,
  brand: t.brand,
  accent: t.mint,
  ink: t.ink,
  ink2: t['ink-2'],
  line: t.line,
  card: t.card,
  privacyBg: t['privacy-bg'],
  muted: t.muted,
  onBrand: t['on-ink'],
  // alert 以前写死成 '#C87B6E' 占位（"旧 theme.js 未纳入 alert"）—— 那是历史遗留：
  // 现在 alert 已经进了 token 表，再写死就会在暗色模式下比出一个**假红**
  // （暗色 alert 是 #E0918A，跟占位值不等），把真问题淹掉。所以从线上值反解。
  alert: t.alert,
});

const ONE = rawPacks.packs[0];
const packOf = (k) => rawPacks.packs.find((p) => p.key === k) || ONE;

// 反构造时沿用「线上那套」共享表参数，才能逐值对齐（新主题的字体/圆角不在比对范围内）
// 🔴 textures / cardStyles / motions 三张表必须一起带上：落一个，deriveTokens 就会
//    要么抛「引用了不存在的 textures」、要么按 undefined 派生出空变量 —— 闸门自己先崩。
const abaShared = {
  radiusScales: rawPacks.radiusScales,
  fontSets: rawPacks.fontSets,
  navStyles: rawPacks.navStyles,
  iconStyles: rawPacks.iconStyles,
  storyTemplates: rawPacks.storyTemplates,
  textures: rawPacks.textures,
  cardStyles: rawPacks.cardStyles,
  motions: rawPacks.motions,
};

const abaPacks = live.THEMES.map((t) => {
  const src = packOf(t.key);
  const t2 = deriveTokens(src, rawPacks);
  // 阴影浓度从线上 shadow 字符串里反解（.06→0.06），保证配置能表达线上的一切，
  // 而不是让断言去迁就生成器的固定值（曾因此抓出「生成器把设计自由度压平」）。
  const alphaOf = (s) => {
    const m = String(s).match(/rgba\([^)]*?,\s*([\d.]+)\)\s*$/);
    return m ? Number(m[1]) : 0.06;
  };
  const toShadow = (tk) => ({ base: alphaOf(tk.shadow), lift: alphaOf(tk['shadow-lift']) });
  return {
    ...src,
    key: t.key,
    name: t.name,
    tagline: t.desc,
    shadow: { light: toShadow(t.tokens), dark: toShadow(t.tokensDark || t.tokens) },
    modes: {
      light: { colors: toColorObj(t.tokens) },
      dark: { colors: toColorObj(t.tokensDark || t.tokens) },
    },
    // 反构造只比对色值字段，其余维度保持不变
    _abaRadius: t2.light.r,
  };
});

const FIELDS = [
  'paper', 'paper-rgb', 'brand', 'brand-rgb', 'mint', 'mint-rgb', 'ink', 'ink-rgb',
  'ink-2', 'line', 'card', 'privacy-bg', 'muted', 'on-ink', 'alert', 'shadow', 'shadow-lift',
];

let checked = 0;
const mismatches = [];
const abaModes = ['light', 'dark'];
for (const lp of abaPacks) {
  const original = live.THEMES.find((t) => t.key === lp.key);
  const genAll = deriveTokens(lp, abaShared);
  for (const mode of abaModes) {
    const liveTk = mode === 'dark' ? (original.tokensDark || original.tokens) : original.tokens;
    const genTk = mode === 'dark' ? (genAll.dark || genAll.light) : genAll.light;
    // 🔴 比对**全部 token**，不再只比 FIELDS 里那 17 项色值。
    //    放水的代价是实测出来的：只比色值时，tex-image / card-* / mo-* 这一整批新变量
    //    即便"线上有、生成器没有"（或反过来）也照样全绿 —— 闸门说 OK，线上却缺变量。
    //    ABA 的命题本来就是"配置能表达线上的每一个值"，比少了等于没比。
    //    同时把暗色也纳入：暗色才是回归最爱藏的地方（深浅两套混着改，容易只改一套）。
    const keys = new Set([...Object.keys(liveTk), ...Object.keys(genTk)]);
    for (const f of keys) {
      checked++;
      if (String(liveTk[f]) !== String(genTk[f])) {
        mismatches.push({
          theme: `${lp.key}/${mode}`,
          field: FIELDS.includes(f) ? f : `${f}（非色值）`,
          live: liveTk[f],
          generated: genTk[f],
        });
      }
    }
  }
}

/* ============================================================
   闸门 ③：styles.css 主题区 = 配置生成结果
   ============================================================ */
const cssText = readFileSync(join(ROOT, 'styles.css'), 'utf8');
const expectCss = buildThemeCss(rawPacks);
const b = cssText.indexOf(CSS_BEGIN);
const e = cssText.indexOf(CSS_END);
const cssProblems = [];
if (b < 0 || e < b) {
  cssProblems.push('styles.css 里找不到 THEME-PACKS 哨兵（BEGIN/END）→ 生成器无法定位替换区');
} else {
  const actual = cssText.slice(b, e + CSS_END.length);
  if (actual !== expectCss) cssProblems.push('styles.css 主题区 ≠ 配置生成结果（改了 packs.json 没跑 npm run gen:theme）');
}
/* 🔴 2026-10-04 修正：这里的正则原来只写 `/\[data-theme='/`，于是把
   `[data-theme='forest'] .album-texture{…}` 这类**主题专属组件规则**
   也数成了"主题块"。9f709fd（相册大图预览 viewer）一口气加了 18 条这种
   规则，计数就从 16 涨到 34 —— 闸门开始报 FAIL，而它真正要防的那件事
   （主题被手写块悄悄覆盖）一次都没发生：紧邻上面的 sentinel 区逐字节比对
   是过的，16 个 token 块也一个不差。

   危害在于**闸门被误报废掉**：一旦有人习惯性忽略这条 FAIL，真正的漂移
   就再也没人看见。而且它是 CI 出包的前置闸门 —— 误报等于发版被堵死
   （实测：d449c090 那次 APK 构建成功时还没有 9f709fd，之后工作流再没跑过）。

   修法：只匹配**真正开启一个主题 token 块**的选择器 ——
     `[data-theme='x']{`                       亮色 token 块
     `[data-theme='x'][data-mode='dark']{`     暗色 token 块
   后面跟着 ` .class{` 的组件规则不再计入。保护没有丢：裸写在 sentinel 区
   外的主题块仍会被数到（17 ≠ 16 照样拦），鉴别力见下方自检。 */
const cssBlockCount = (cssText.match(/\[data-theme='[^']+'\](?:\[data-mode='dark'\])?\{/g) || []).length;
const wantBlockCount = rawPacks.packs.length * 2;
if (cssBlockCount !== wantBlockCount) {
  cssProblems.push(`styles.css 主题块 ${cssBlockCount} 段 ≠ 期望 ${wantBlockCount} 段（${rawPacks.packs.length} 套 × 亮暗）`);
}
/* 🔴 仪器自检（鉴别力）：旧正则的行为必须与预期一致 —— 数"组件规则"时虚高，
   数"token 块"时准确。若哪天有人把正则改回去，这条会把事实摆出来。 */
const PROBE = `[data-theme='origin']{--paper:#fff}\n[data-theme='forest'] .album-texture{display:block}`;
const probeTight = (PROBE.match(/\[data-theme='[^']+'\](?:\[data-mode='dark'\])?\{/g) || []).length;
const probeLoose = (PROBE.match(/\[data-theme='/g) || []).length;
if (probeTight !== 1 || probeLoose !== 2) {
  cssProblems.push(`计数正则鉴别力异常：探针里 1 个 token 块 + 1 条组件规则，紧正则应得 1、宽正则应得 2，实测 ${probeTight}/${probeLoose}`);
}
const iRoot = cssText.indexOf('\n:root{');
const iFirst = cssText.indexOf("\n[data-theme='");
if (!(iRoot > 0 && iFirst > iRoot)) cssProblems.push(':root 未排在主题块之前 → 主题会被 :root 覆盖（界面纹丝不动）');

/* ============================================================
   闸门 ④：新增字段齐全 + 深色非复制
   ============================================================ */
const NEW_FIELDS = ['r', 'r-sm', 'r-chip', 'font', 'font-w-body', 'font-w-title', 'font-ls',
  'icon-stroke', 'nav-kind', 'nav-bg', 'nav-hairline',
  'nav-fg', 'nav-fg-2', 'nav-fg-rgb', 'nav-chip-a',
  // P0-3 新增三组：纸肌理 / 卡片形态 / 动效
  'tex-image', 'tex-size', 'tex-blend',
  'card-border', 'card-hairline', 'card-inner', 'card-deco',
  'mo-dur', 'mo-ease', 'mo-shift'];
const missingNew = [];
for (const pack of rawPacks.packs) {
  const gen = deriveTokens(pack, rawPacks).light;
  for (const f of NEW_FIELDS) {
    if (!gen[f] || /undefined|NaN/.test(String(gen[f]))) missingNew.push(`${pack.key}.${f}`);
  }
}

const darkCopy = [];
for (const pack of rawPacks.packs) {
  const t = deriveTokens(pack, rawPacks);
  if (t.light.paper === t.dark.paper || t.light.ink === t.dark.ink) darkCopy.push(pack.key);
}

/* ============================================================
   闸门 ⑤：配置字段投影完整性
   为什么需要：生成器曾漏掉 pack.group，导致主题页「经典/场景」分组静默退化成
   全在一个标题下 —— 界面看着"能跑"，分组没了。凡是配置里声明、代码要读的字段，
   都必须能被投影到 theme.js，漏一个就是一处静默功能缺失。
   ============================================================ */
const PROJECT = {
  key: (p) => p.key,
  group: (p) => p.group || 'scene',
  name: (p) => p.name,
  desc: (p) => p.tagline,          // 配置里叫 tagline，运行时叫 desc
  isDefault: (p, d) => p.key === d.defaultPack,
  // 注意：数组比较统一走 JSON，别用 join('|') —— 运行时的 String([a,b]) 是逗号连接，
  // 分隔符不一致会造出一整片假红，把真缺陷（group/isDefault 缺失）淹掉（已踩）
  scenes: (p) => JSON.stringify(p.scenes || []),
  iconStyle: (p) => p.iconStyle,
  navStyle: (p) => p.navStyle,
  fontSet: (p) => p.fontSet,
  storyTemplate: (p) => p.storyTemplate,
  desktopIcon: (p) => p.desktopIcon || '',
  // P0-3：纸肌理 / 卡片形态 / 动效三件套也必须投影到 theme.js
  texture: (p) => p.texture,
  cardStyle: (p) => p.cardStyle,
  motion: (p) => p.motion,
};
const projMiss = [];
const byKey = Object.fromEntries(rawPacks.packs.map((p) => [p.key, p]));
for (const t of live.THEMES) {
  const p = byKey[t.key];
  if (!p) { projMiss.push(`${t.key}: 运行时存在但配置里没有`); continue; }
  for (const [field, get] of Object.entries(PROJECT)) {
    const want = String(get(p, rawPacks));
    const raw = t[field];
    const got = raw === undefined || raw === null ? '<undefined>'
      : (Array.isArray(raw) ? JSON.stringify(raw) : String(raw));
    if (got !== want) projMiss.push(`${t.key}.${field}: 配置=${want} 运行时=${got}`);
  }
}
for (const p of rawPacks.packs) {
  if (!live.THEMES.some((t) => t.key === p.key)) projMiss.push(`${p.key}: 配置里有但运行时没有`);
}

/* ============================================================
   闸门 ⑥：CSS 变量覆盖度（不许有"死变量"）
   为什么需要：配置里声明了 token、而消费方写死数值，是最隐蔽的一类缺陷 ——
   界面"看着完全正常"，只是**换了主题也不跟着变**，没人会把它当 bug 报上来。
   本闸门第一次跑就抓到三个真家伙（都已在 P0-3 修掉，留档做回归）：
     · --r-chip     每套主题都在吐（8/10/12/14），而 .chip 的圆角硬编码 8px
     · --ink-rgb    toast/遮罩要用 ink 通道做半透底，却写成名字对不上的 --on-ink-rgb
     · nav-fg-2-rgb 全库零消费者（生成器顺手吐出来的副产品）
   判定「有消费者」的四条通路，缺一条就会造出假红把真问题淹掉：
     ① CSS 消费   var(--x) / var(--x, 兜底)
     ② JS 变量名  '--x'（setProperty / 字符串拼接）
     ③ JS 属性读  tokens(k).muted
     ④ JS 下标读  tokens(k)['nav-kind']
   搜索范围只含**消费侧**（styles.css / index.html / js/ / _selftest/），
   **不含 scripts/** —— 生成器与校验脚本只是"声明和罗列"token 名，
   把它们算进去就等于"token 只要被列进某个数组就算活着"，闸门立刻失去意义。
   ============================================================ */
const consumerChunks = [cssText];
for (const [dir, re] of [['js', /\.js$/], ['_selftest', /\.(cjs|js|mjs)$/]]) {
  for (const f of readdirSync(join(ROOT, dir))) {
    if (re.test(f)) consumerChunks.push(readFileSync(join(ROOT, dir, f), 'utf8'));
  }
}
try { consumerChunks.push(readFileSync(join(ROOT, 'index.html'), 'utf8')); } catch { /* 可选 */ }
const consumerText = consumerChunks.join('\n');

const tokenNames = new Set();
for (const pack of rawPacks.packs) {
  const t = deriveTokens(pack, rawPacks);
  for (const k of Object.keys(t.light)) tokenNames.add(k);
  for (const k of Object.keys(t.dark)) tokenNames.add(k);
}
const deadVars = [];
for (const name of tokenNames) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const used = new RegExp(
    `var\\(\\s*--${esc}\\s*[,)]`                  // ① CSS
    + `|['"]--${esc}['"]`                          // ② JS 变量名
    + `|\\.${esc}\\b`                              // ③ JS 属性
    + `|\\[\\s*['"]${esc}['"]\\s*\\]`,             // ④ JS 下标
  ).test(consumerText);
  if (!used) deadVars.push(name);
}

/* ============================================================
   报告
   ============================================================ */
line('===== 生成器校验（黄金快照 / 无损性 / CSS 同步）=====');
line(`  ① 黄金快照：${Object.keys(snapshot).length} 套主题 × 2 模式，对比 ${Object.keys(snapshot).length * 2} 组`);
if (goldenDiff.length === 0) {
  line('     ✓ 与快照逐值一致（没有静默改色）');
} else {
  failed++;
  line(`     ✗ 与快照不一致 ${goldenDiff.length} 处：`);
  for (const d of goldenDiff.slice(0, 20)) line(`         ${d}`);
  line('       → 若这次改色是有意的，跑 `node scripts/verify-gen-theme.mjs --bless` 重签快照');
}
line(`  ② 无损性（ABA）：反构 ${abaPacks.length} 套 × ${abaModes.length} 模式，比对 ${checked} 项（全 token，含非色值/暗色）`);
if (mismatches.length === 0) {
  line(`     ✓ 全等 ${checked}/${checked}`);
} else {
  failed++;
  line(`     ✗ 不等 ${mismatches.length} 处：`);
  for (const m of mismatches.slice(0, 20)) line(`         ${m.theme}.${m.field}: 线上=${m.live} 生成=${m.generated}`);
}
line(`  ③ CSS 同步：期望 ${wantBlockCount} 段主题块，实测 ${cssBlockCount} 段`);
if (cssProblems.length === 0) {
  line('     ✓ styles.css 主题区 = 配置生成结果，且 :root 顺序正确');
} else {
  failed++;
  for (const p of cssProblems) line(`     ✗ ${p}`);
}
line(`  ④ 字段齐全 / 深色非复制：`);
line(`     ${missingNew.length === 0 ? '✓' : '✗'} 新增字段齐全（圆角/字体/图标/导航/肌理/卡片/动效）：${missingNew.length === 0 ? '是' : missingNew.join(', ')}`);
line(`     ${darkCopy.length === 0 ? '✓' : '✗'} 深色模式与浅色实质不同：${darkCopy.length === 0 ? `是（${rawPacks.packs.length}/${rawPacks.packs.length} 套）` : `疑似复制交差 → ${darkCopy.join(', ')}`}`);
if (missingNew.length || darkCopy.length) failed++;

line(`  ⑤ 配置字段投影完整性：${Object.keys(PROJECT).length} 字段 × ${live.THEMES.length} 套`);
if (projMiss.length === 0) {
  line('     ✓ 配置里声明的字段全部投影到 theme.js（无静默丢失）');
} else {
  failed++;
  for (const m of projMiss.slice(0, 20)) line(`     ✗ ${m}`);
}

line(`  ⑥ CSS 变量覆盖度：${tokenNames.size} 个变量 × 4 条消费通路`);
if (deadVars.length === 0) {
  line('     ✓ 没有死变量：生成器吐出的每个变量都真的有人消费');
} else {
  failed++;
  line(`     ✗ 死变量 ${deadVars.length} 个（配置声明了却没人用 → 换主题也不会变）：`);
  for (const d of deadVars) line(`         --${d}`);
  line('       → 要么让消费方吃这个变量，要么从生成器里删掉，二者必选其一');
}

line(`\n===== 结果：${failed === 0 ? 'PASS — 改配置即可换肤，且没有静默漂移' : 'FAIL'} =====`);
process.exit(failed === 0 ? 0 : 1);

// 防"未使用变量"误报：selfTest 仅在调试蓝图时用
void selfTest;
