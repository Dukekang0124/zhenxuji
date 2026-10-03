/**
 * gen-theme.mjs — 主题配置 → 代码生成器
 *
 * 存在理由（对应方案风险条目 1「开发工作量风险」的应对）：
 *   方案要求「建立 CSS变量/样式配置表，新增主题只需要修改配置文件，不用重写页面代码」。
 *   这句话必须能被验证，否则就是空话。本脚本把 theme/packs.json 编译成：
 *     ① js/theme.js 的 THEMES 结构（JS 侧色值真相源）
 *     ② styles.css 的 [data-theme=...] 变量块（CSS 侧覆盖层）
 *   新增一套主题 = packs.json 加一项 + 跑一次本脚本，页面代码零改动。
 *
 * 派生规则（不要在 JSON 里手写，避免漂移）：
 *   -rgb 通道串   ← 由 hex 算出（老 WebView 不支持 color-mix，必须预生成逗号通道）
 *   shadow        ← 由 brand 派生：light 用 rgba(brand,.06/.10)，dark 用 rgba(0,0,0,.5/.6)
 *   ink-rgb       ← 取 ink 通道：toast/遮罩靠它做半透底，两模式自洽
 *                    （light：深底浅字；dark：浅底深字，无需分支）
 *                    ⚠️ 曾同时吐出一个 on-ink-rgb，值也是 ink 通道 —— 名字与 --on-ink
 *                    （亮色是 #FFFFFF）对不上，属于"名字说谎的 token"，已删除收敛为 ink-rgb。
 *   --r / --r-sm  ← radiusScales
 *   --font        ← fontSets
 *   nav/icon 变量 ← navStyles / iconStyles
 *   --tex-*       ← textures（SVG data-URI 噪声 / 主题色柔光；delta 供对比度闸门算最坏值）
 *   --card-*      ← cardStyles（描边/内高光/装饰）
 *   --mo-*        ← motions（时长/缓动/位移；reduced-motion 由 CSS 覆盖，配置不分支）
 *
 * 用法：
 *   node scripts/gen-theme.mjs              # 生成到 theme/generated/（对照产物，不动线上）
 *   node scripts/gen-theme.mjs --write      # 直接覆盖 js/theme.js 与 styles.css 的主题区
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const PACKS_PATH = join(ROOT, 'theme', 'packs.json');

export const hexToRgbTriplet = (hex) => {
  const s = String(hex).replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(',');
};

/**
 * 导航前景色解析：允许两种写法
 *   ① 色板里的 token 名（如 'brand'）→ 取当前模式的实际色值
 *   ② 十六进制字面量（如 '#F6EFE4'）→ 直接用
 * 为什么允许字面量：磨砂深底导航的底色是固定近黑（不随明暗变），
 * 前景自然也不能跟着明暗变，而色板里的 token 都是随明暗翻转的 —— 表达不了。
 */
const resolveNavColor = (v, colors, fallbackKey) => {
  if (typeof v === 'string' && /^#/.test(v)) return v.toUpperCase();
  return colors[v] || colors[fallbackKey];
};

/**
 * 肌理图案 → CSS 值。
 *
 * 为什么用 SVG data-URI 而不是 PNG：零位图体积，APK 不会被肌理撑大；
 * 而且改密度/缩放只动配置、不动资产文件。
 * ⚠️ 里面的 `<` `>` `#` 必须百分号编码，否则 CSS 解析器会在 `#` 处当成颜色/片段标识截断。
 * ⚠️ feTurbulence 必须带 stitchTiles='stitch'，否则平铺边界会有肉眼可见的接缝。
 * ⚠️ 浓度（opacity）**烘进图案本身**，不做成 --tex-opacity 变量：纹理是铺在 body 上的
 *    一层背景，用 background-blend-mode 与纸底混合，没有"单独给这层调透明度"的钩子；
 *    硬造一个没人能用的变量就是死字段（本项目的规矩：生成了就必须有规则真的吃它）。
 */
export function textureImage(tex, colors) {
  if (!tex || tex.kind === 'none') return 'none';
  const op = Number(tex.opacity === undefined ? 1 : tex.opacity);
  if (tex.kind === 'noise') {
    const n = tex.tile || 160;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${n}' height='${n}'>`
      + `<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/></filter>`
      + `<rect width='100%' height='100%' filter='url(%23g)' opacity='${op}'/></svg>`;
    const enc = svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');
    return `url("data:image/svg+xml,${enc}")`;
  }
  if (tex.kind === 'glow') {
    // 柔光用主题自己的 accent 着色，才不会所有主题都发同一种白光
    const a = hexToRgbTriplet(colors.accent);
    const peak = (0.18 * op).toFixed(2).replace(/^0/, '');
    return `radial-gradient(120% 80% at 50% -10%,rgba(${a},${peak}) 0%,rgba(${a},0) 68%)`;
  }
  return 'none';
}

/** 卡片装饰 → background-image 值（不占伪元素、不改定位，零副作用） */
export function cardDecoImage(card, colors) {
  if (!card || card.deco === 'none') return 'none';
  if (card.deco === 'tape') {
    const b = hexToRgbTriplet(colors.brand);
    return `linear-gradient(115deg,rgba(${b},.16) 0 10%,rgba(${b},0) 10.6%)`;
  }
  return 'none';
}

/**
 * 把一套主题包（含 light/dark）编译成该主题的 token 表。
 * @returns {{light: Record<string,string>, dark: Record<string,string>}}
 */
export function deriveTokens(pack, shared) {
  const radius = shared.radiusScales[pack.radiusScale];
  const font = shared.fontSets[pack.fontSet];
  const nav = shared.navStyles[pack.navStyle];
  const icon = shared.iconStyles[pack.iconStyle];
  const tex = shared.textures[pack.texture];
  const card = shared.cardStyles[pack.cardStyle];
  const mo = shared.motions[pack.motion];
  // 配置里写了表里没有的 key（拼错/漏定义）绝不能静默兜底成 undefined：
  // 那会生成 --tex-image:undefined，CSS 整条声明失效，界面「看着没变」而配置已经错了。
  for (const [what, def, key] of [['textures', tex, pack.texture], ['cardStyles', card, pack.cardStyle], ['motions', mo, pack.motion]]) {
    if (!def) throw new Error(`[gen:theme] 主题「${pack.key}」引用了不存在的 ${what}: ${JSON.stringify(key)}`);
  }
  // 阴影浓度是**逐套主题的设计自由度**（暖底/深底要多给一点才压得住），
  // 不能统一成固定值 —— 那会把上一版手工调好的节奏压平（由 verify-gen-theme 卡住）。
  const sh = pack.shadow || { light: { base: 0.06, lift: 0.1 }, dark: { base: 0.5, lift: 0.6 } };
  // 线上格式是 `.06` 而非 `0.06`，且统一保留两位（`.10` 不能写成 `.1`），
  // 否则生成字符串与线上不逐字相等（verify-gen-theme 会卡住）
  const fmtAlpha = (a) => Number(a).toFixed(2).replace(/^0/, '');

  const out = {};
  for (const mode of ['light', 'dark']) {
    const c = pack.modes[mode].colors;
    const brandRgb = hexToRgbTriplet(c.brand);
    const shadowBase = mode === 'light' ? brandRgb : '0,0,0';
    const sa = sh[mode] || sh.light;
    const t = {
      // —— 色彩 ——
      paper: c.paper,
      'paper-rgb': hexToRgbTriplet(c.paper),
      brand: c.brand,
      'brand-rgb': brandRgb,
      mint: c.accent,
      'mint-rgb': hexToRgbTriplet(c.accent),
      alert: c.alert,
      ink: c.ink,
      'ink-rgb': hexToRgbTriplet(c.ink),
      'ink-2': c.ink2,
      line: c.line,
      card: c.card,
      'privacy-bg': c.privacyBg,
      muted: c.muted,
      // —— 反色（toast / 遮罩 / 实底按钮） ——
      // 只派生 on-ink（品牌/深底上的文字色）。半透底一律复用上面的 ink-rgb，
      // 不再另造一个通道串 —— 多一个名字就多一个会被误用的机会，见文件头说明。
      'on-ink': c.onBrand,
      // —— 阴影 ——
      shadow: `0 2px 10px rgba(${shadowBase},${fmtAlpha(sa.base)})`,
      'shadow-lift': `0 4px 16px rgba(${shadowBase},${fmtAlpha(sa.lift)})`,
      // —— 圆角 ——
      r: `${radius.card}px`,
      'r-sm': `${radius.control}px`,
      'r-chip': `${radius.chip}px`,
      // —— 字体 ——
      font: font.family,
      'font-w-body': String(font.bodyWeight),
      'font-w-title': String(font.titleWeight),
      'font-ls': font.letterSpacing,
      // —— 图标线稿风格 ——
      'icon-stroke': String(icon.strokeWidth),
      // —— 导航栏样式 ——
      'nav-kind': nav.kind,
      'nav-hairline': c[nav.hairline] || c.line,
      // 导航前景色：按**导航自身底色**取名。
      // ⚠️ 早期版本这里只派生了一个 nav-icon 且没人用，同时 .tab 直接吃 brand/ink-2 ——
      //    结果深色磨砂导航（胶片/复古）的浅色模式下，字压在近黑底上只有 1.27:1，
      //    基本读不出来。前景色必须属于导航样式，不能跟着页面底色走。
      'nav-fg': resolveNavColor(nav.fg, c, 'brand'),
      'nav-fg-2': resolveNavColor(nav.fg2, c, 'ink2'),
      // 只有 nav-fg 需要通道串（.tab--on 的选中底块要半透）。nav-fg-2 目前只做纯色文字，
      // 原先一并吐出的 nav-fg-2-rgb 全库零消费者 —— 按「变量不许留死」的原则删掉了，
      // 将来真需要在它上面叠 alpha，这里补一行即可。
      'nav-fg-rgb': hexToRgbTriplet(resolveNavColor(nav.fg, c, 'brand')),
      // 选中项底色块浓度：渐变/磨砂导航的选中态主要靠它表达（前景色已被 AA 压成同一个 ink）
      'nav-chip-a': String(nav.chipAlpha === undefined ? 0.1 : nav.chipAlpha),
      // —— 纸肌理（P0-3）——
      // 由 styles.css 的 body 当**第二背景层**铺（background-image + background-blend-mode），
      // 不是 position:fixed 浮层 —— 浮层要动 z-index/层叠上下文，压错层就盖内容或吃点击。
      // 浓度烘进图案本身（见 textureImage），而它的**对比度代价**由 textures[].delta 建模，
      // check-theme-contrast 会按它算最坏值。
      'tex-image': textureImage(tex, c),
      // 平铺尺寸只在噪声图案下有意义；柔光是整屏渐变，交给 auto
      'tex-size': tex.kind === 'noise' ? `${tex.tile}px ${tex.tile}px` : 'auto',
      'tex-blend': tex.blend,
      // —— 卡片形态（P0-3）——
      'card-border': card.borderWidth ? `${card.borderWidth}px solid` : '0',
      'card-hairline': c[card.hairline] || c.line,
      // 恒为合法 box-shadow 片段（无操作时是全透明零阴影），拼在 --shadow 后面用
      'card-inner': card.inner,
      'card-deco': cardDecoImage(card, c),
      // —— 动效（P0-3）——
      // prefers-reduced-motion 下会被 CSS 覆盖成 0s（见 styles.css），不在这里分支
      'mo-dur': mo.duration,
      'mo-ease': mo.ease,
      'mo-shift': `${mo.shift}px`,
    };

    if (nav.kind === 'solid') {
      t['nav-bg'] = `rgba(${hexToRgbTriplet(c[nav.base])},${nav.alpha})`;
    } else if (nav.kind === 'gradient') {
      t['nav-bg'] = `linear-gradient(180deg,${c[nav.from]} 0%,${c[nav.to]} ${nav.stop})`;
    } else if (nav.kind === 'blur') {
      t['nav-bg'] = `rgba(${hexToRgbTriplet(nav.base)},${nav.alpha})`;
      t['nav-blur'] = `${nav.blur}px`;
    }

    out[mode] = t;
  }
  return out;
}

const jsStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** token 键能否裸写：必须是合法 JS 标识符（含 `-` 的如 font-w-body、ink-2 必须加引号） */
const bare = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
const keyStr = (k) => (bare(k) ? k : `'${k}'`);

/** 生成 js/theme.js 全文 */
export function buildThemeJs(data) {
  const packs = data.packs.map((pack) => {
    const tk = deriveTokens(pack, data);
    const lightLines = Object.entries(tk.light).map(([k, v]) => `      ${keyStr(k)}: ${jsStr(v)},`).join('\n');
    const darkLines = Object.entries(tk.dark).map(([k, v]) => `      ${keyStr(k)}: ${jsStr(v)},`).join('\n');
    return `  {
    key: ${jsStr(pack.key)},
    group: ${jsStr(pack.group || 'scene')},
    name: ${jsStr(pack.name)},
    desc: ${jsStr(pack.tagline)},
    isDefault: ${pack.key === data.defaultPack},
    scenes: [${pack.scenes.map(jsStr).join(', ')}],
    iconStyle: ${jsStr(pack.iconStyle)},
    navStyle: ${jsStr(pack.navStyle)},
    fontSet: ${jsStr(pack.fontSet)},
    storyTemplate: ${jsStr(pack.storyTemplate)},
    desktopIcon: ${jsStr(pack.desktopIcon)},
    // 设计语言三元组：纹理 / 卡片形态 / 动效（P0-3 新增，投影闸门 ⑤ 会逐个核对）
    texture: ${jsStr(pack.texture)},
    cardStyle: ${jsStr(pack.cardStyle)},
    motion: ${jsStr(pack.motion)},
    tokens: {
${lightLines}
    },
    tokensDark: {
${darkLines}
    },
  },`;
  }).join('\n');

  return `/**
 * theme.js — 主题包系统（由 scripts/gen-theme.mjs 从 theme/packs.json 生成，请勿手改）
 *
 * 手改会被下次 npm run gen:theme 覆盖。要改色值/圆角/字体/导航样式，改 theme/packs.json。
 * 生成时间基准：schemaVersion ${data.schemaVersion}
 */

export const THEMES = [
${packs}
];

export const DEFAULT_THEME = ${jsStr(data.defaultPack)};
export const DEFAULT_MODE = ${jsStr(data.defaultMode)};
const KEYS = THEMES.map((t) => t.key);
const MAP = new Map(THEMES.map((t) => [t.key, t]));

export const THEME_KEYS = KEYS;

/** 主题 key + 明暗模式 → token 表；非法值一律回落默认，绝不写脏数据进存档 */
export function tokens(key, mode) {
  const t = MAP.get(normalizeTheme(key)) || THEMES[0];
  return normalizeMode(mode) === 'dark' ? t.tokensDark : t.tokens;
}

export function normalizeTheme(key) {
  return typeof key === 'string' && MAP.has(key) ? key : DEFAULT_THEME;
}

export function normalizeMode(mode) {
  return mode === 'dark' ? 'dark' : 'light';
}

export function themeName(key) {
  return (MAP.get(normalizeTheme(key)) || THEMES[0]).name;
}

export function themeMeta(key) {
  return MAP.get(normalizeTheme(key)) || THEMES[0];
}

/** 应用主题：写 data-theme + data-mode 两个属性，同步 PWA 状态栏色。幂等 */
export function applyTheme(key, mode) {
  const k = normalizeTheme(key);
  const m = normalizeMode(mode);
  const root = document.documentElement;
  if (root.dataset.theme === k && root.dataset.mode === m) return k;
  root.dataset.theme = k;
  root.dataset.mode = m;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', tokens(k, m).paper);
  return k;
}
`;
}

/** 生成 CSS 变量块（含每主题的 light / dark 两段） */
export const CSS_BEGIN = '/* >>> THEME-PACKS:BEGIN —— 由 scripts/gen-theme.mjs 生成，请勿手改 / 勿删本行 >>> */';
export const CSS_END = '/* <<< THEME-PACKS:END —— 请勿删本行（生成器靠它定位替换区） <<< */';

export function buildThemeCss(data) {
  const blocks = [];
  for (const pack of data.packs) {
    const tk = deriveTokens(pack, data);
    const fmt = (t) => Object.entries(t).map(([k, v]) => `  --${k}:${v};`).join('\n');
    blocks.push(`/* ${pack.name} —— ${pack.tagline} */\n[data-theme='${pack.key}']{\n${fmt(tk.light)}\n}`);
    blocks.push(`[data-theme='${pack.key}'][data-mode='dark']{\n${fmt(tk.dark)}\n}`);
  }
  return `${CSS_BEGIN}
/* 主题包变量层
   ⚠️ 这些块必须排在 :root 之后：两者特异性同为 (0,1,0)，靠源码顺序取胜。
      放前面会被 :root 覆盖，主题切了但界面纹丝不动。
   ⚠️ 每套主题两段：默认 light，[data-mode='dark'] 覆盖。 */

${blocks.join('\n\n')}
${CSS_END}`;
}

/**
 * 把生成结果写回 styles.css 的主题区。
 * 为什么必须自动做：方案承诺「新增主题只改配置文件」。若 CSS 侧还要人工粘贴，
 * 那么漏粘贴 = theme.js 有 8 套、CSS 只有 4 套 → 界面纹丝不动，且错误极难定位。
 * 兼容两种情况：已有 sentinel（正常路径）/ 只有旧注释头（首次迁移）。
 */
export function syncStylesCss(cssText, generated) {
  const b = cssText.indexOf(CSS_BEGIN);
  const e = cssText.indexOf(CSS_END);
  if (b >= 0 && e > b) {
    return cssText.slice(0, b) + generated + cssText.slice(e + CSS_END.length);
  }
  // 首次迁移：旧注释头 → 找到最后一个 [data-theme] 块的收尾 }
  const legacy = cssText.indexOf('主题包变量层');
  if (legacy < 0) {
    throw new Error('[gen:theme] styles.css 里找不到主题区（既无 sentinel 也无旧注释头），已中止以免写坏文件');
  }
  const start = cssText.lastIndexOf('/*', legacy);
  const lastBlock = cssText.lastIndexOf("\n[data-theme='");
  if (lastBlock < 0) throw new Error('[gen:theme] styles.css 里找不到任何 [data-theme] 变量块，已中止');
  const close = cssText.indexOf('\n}', lastBlock);
  if (close < 0) throw new Error('[gen:theme] 主题块结构异常（找不到收尾大括号），已中止');
  return cssText.slice(0, start) + generated + cssText.slice(close + 2);
}

function main() {
  const data = JSON.parse(readFileSync(PACKS_PATH, 'utf8'));
  const js = buildThemeJs(data);
  const css = buildThemeCss(data);

  const outDir = join(ROOT, 'theme', 'generated');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'theme.generated.js'), js, 'utf8');
  writeFileSync(join(outDir, 'theme.generated.css'), css, 'utf8');

  const packCount = data.packs.length;
  // 变量数按**所有主题的并集**算，不是只看第一套：
  // nav-blur 只在磨砂型导航（胶片/复古）里出现，只看 packs[0] 会少报一个，
  // 读日志的人会以为漏生成了。并集才是"这套配置一共产出多少变量"的正确答案。
  const names = new Set();
  for (const p of data.packs) {
    const t = deriveTokens(p, data);
    for (const k of Object.keys(t.light)) names.add(k);
    for (const k of Object.keys(t.dark)) names.add(k);
  }
  const tokenCount = names.size;

  if (process.argv.includes('--write')) {
    writeFileSync(join(ROOT, 'js', 'theme.js'), js, 'utf8');
    console.log('[gen:theme] 已覆盖 js/theme.js');
    // styles.css 必须一起同步：只写 JS 不写 CSS 会得到「theme.js 有 8 套、CSS 只有 4 套」
    // 的静默错配，界面纹丝不动且极难定位（已踩）。
    const cssPath = join(ROOT, 'styles.css');
    const before = readFileSync(cssPath, 'utf8');
    const after = syncStylesCss(before, css);
    if (after === before) {
      console.log('[gen:theme] styles.css 主题区已是最新，无需改写');
    } else {
      writeFileSync(cssPath, after, 'utf8');
      console.log('[gen:theme] 已同步 styles.css 主题区（变量块整体替换，其余规则原样保留）');
    }
    return;
  }

  console.log(`[gen:theme] ${packCount} 套主题 × 2 模式 → theme/generated/`);
  console.log(`[gen:theme] 每模式最多 ${tokenCount} 个变量（色彩/反色/阴影/圆角/字体/图标/导航/肌理/卡片/动效）`);
  console.log('[gen:theme] 加 --write 可覆盖 js/theme.js 与 styles.css 主题区（当前为对照模式，未动线上文件）');
}

// 直接执行时跑 main（被 import 做校验时不跑）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/gen-theme.mjs')) main();

