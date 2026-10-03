/**
 * check-theme-contrast.mjs — 主题包无障碍对比度闸门（WCAG 2.1）
 *
 * 为什么需要它：
 *   方案风险条目 3「一致性风险」明确要求「所有主题做无障碍对比度校验，保证文字阅读清晰」。
 *   目测"看着行"不算数 —— 复古深色主题最容易出现深棕字压暖棕底、对比度掉到 3:1 以下的情况，
 *   而那在手机户外光下就是"看不清"。所以把校验固化成命令，改任何色值都必须过这道闸。
 *
 * 判定阈值（WCAG 2.1）：
 *   ≥ 7.0  AAA 正文    → ink/paper、ink/card
 *   ≥ 4.5  AA 正文     → ink2、muted、brand、alert 当文字用，按钮字 onBrand/brand
 *   ≥ 1.15 非文字可见  → line/paper（分割线只需可感知，不适用文字标准）
 *
 * 两组规则：
 *   ① 页面级 9 条：文字压在**页面底色 / 卡片底**上
 *   ② 导航级 2 条：文字压在**导航自身底色**上（半透底先与纸底合成，渐变取两端最坏值）
 *   —— 这两组必须分开算：导航是浮层，底色来自 navStyles 而非页面。曾因为没有②，
 *      深色磨砂导航在浅色模式下掉到 1.27:1 却全绿（详见证报告与工作日志）。
 *
 * 用法：node scripts/check-theme-contrast.mjs [--json]
 *   退出码 0 = 全部达标；1 = 有不达标项（CI / 自测可据此卡住）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'theme', 'packs.json');

const hex2rgb = (h) => {
  const s = String(h).replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const chan = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

const lum = (hex) => {
  const [r, g, b] = hex2rgb(hex);
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
};

export function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 每项：名称 / 前景 token / 背景 token / 阈值 / 用途说明 */
const CHECKS = [
  { id: 'body-on-paper',    fg: 'ink',     bg: 'paper',     min: 7.0,  use: '一级正文压页面底色' },
  { id: 'sub-on-paper',     fg: 'ink2',    bg: 'paper',     min: 4.5,  use: '次要文字压页面底色' },
  { id: 'muted-on-paper',   fg: 'muted',   bg: 'paper',     min: 4.5,  use: '导出图注 / 日期' },
  { id: 'brand-on-paper',   fg: 'brand',   bg: 'paper',     min: 4.5,  use: '品牌色当文字/图标' },
  { id: 'alert-on-paper',   fg: 'alert',   bg: 'paper',     min: 4.5,  use: '警示文字' },
  { id: 'body-on-card',     fg: 'ink',     bg: 'card',      min: 7.0,  use: '一级正文压卡片' },
  { id: 'sub-on-card',      fg: 'ink2',    bg: 'card',      min: 4.5,  use: '次要文字压卡片' },
  { id: 'btn-label',        fg: 'onBrand', bg: 'brand',     min: 4.5,  use: '主按钮文字压按钮底' },
  { id: 'line-on-paper',    fg: 'line',    bg: 'paper',     min: 1.15, use: '分割线可感知（非文字）' },
];

/* ── 导航栏：独立一组规则，因为导航是「自己一块底色」的浮层 ──────────────
   为什么单列：导航底色由 navStyles 决定（半透纸底 / 渐变 / 近黑磨砂），
   与页面底色无关。早期版本让 .tab 直接吃 brand/ink-2，于是深色磨砂导航
   （胶片叙忆 / 轻复古手账）在**浅色模式**下，字压在近黑底上只有 1.27:1 与 1.63:1 ——
   不是"有点难看"，是根本读不出来。而当时 9 条规则全绿，因为没有一条在看导航。
   故：前景色必须按导航自身底色校验，渐变取两端的最坏值。 */
const hex2rgbv = (h) => {
  const s = String(h).replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** 把半透明前景压到底色上，得到"肉眼实际看到的颜色" */
const composite = (fg, alpha, bg) => {
  const A = hex2rgbv(fg), B = hex2rgbv(bg);
  return toHex(A.map((v, i) => v * alpha + B[i] * (1 - alpha)));
};
const resolveColor = (v, colors, fallbackKey) => {
  if (typeof v === 'string' && /^#/.test(v)) return v.toUpperCase();
  return colors[v] || colors[fallbackKey];
};
const mix = (a, b, t) => {
  const A = hex2rgbv(a), B = hex2rgbv(b);
  return toHex(A.map((v, i) => v * (1 - t) + B[i] * t));
};

/* ── 纸肌理的最坏影响（P0-3）────────────────────────────────────────────
   肌理是铺在 body 上的第二背景层（background-image + background-blend-mode），
   所以**只有直接压在页面底色上的东西**会受影响：卡片 / 分段控件 / 面板的底色都是
   不透明色（card / privacy-bg），肌理被它们整块盖住，一点都透不过来。
   最坏方向建模：底色朝**文字色**偏移 delta 比例。对比度随两者亮度靠近而单调下降，
   所以"底色往文字色走"就是最坏情形 —— 这也是 textures[].delta 的定义。
   ⚠️ delta 不是拍脑袋的"看着差不多"。浅色主题的余量薄到危险（paper 的 ink2/paper 是
     4.53，只高出 AA 线 0.03），肌理只要超过这点余量就是**真的读不清**，不是挑刺。
      判据：闸门用 delta 算最坏值，同时自测在真 Chrome 里量渲染后的实际像素再核一遍。 */
const texDelta = (pack) => {
  const t = (data.textures || {})[pack.texture];
  return t && typeof t.delta === 'number' ? t.delta : 0;
};

/** 导航级规则：返回 { rows, failures }。写成函数是为了能在 `data`/`failed` 之后调用
    （ESM 的 const 有 TDZ，写在前面直接调用会 ReferenceError）。 */
function buildNavRows(data) {
  const out = [];
  let failures = 0;
  for (const pack of data.packs) {
    const ns = data.navStyles[pack.navStyle];
    if (!ns) {
      out.push({ pack: pack.key, mode: '-', id: 'nav-style', ratio: null, min: 4.5, ok: false, use: `未知导航样式 ${pack.navStyle}` });
      failures++;
      continue;
    }
    for (const mode of ['light', 'dark']) {
      const c = pack.modes[mode].colors;
      // 导航底面的候选色集合：
      //   solid/blur → 半透底压页面纸底后的实际色
      //   gradient   → 顶部（from）与**底部实际可见色**
      //     ⚠️ 不能直接用 to：`linear-gradient(180deg, from 0%, to stop%)` 的 stop 是
      //        相对元素高度的，stop=150% 时元素底部只走到 from→to 的 2/3，
      //        用 to 当端点会把"实际读得清"的渐变异化成假红（已踩）。
      // 导航是**半透浮层**：纸底上的肌理会透过它显出来（solid 的 .97 只是轻微透，
      // blur 那类 0.8 出头的半透底透得明显）。所以纸底要先按 delta 朝该条规则的
      // 前景色偏移，再与导航底色合成 —— 否则等于假设"导航底下那张纸没有肌理"。
      const delta = texDelta(pack);
      const surfacesFor = (fgColor) => {
        const paper = delta > 0 ? mix(c.paper, fgColor, delta) : c.paper;
        if (ns.kind === 'solid') return [composite(c[ns.base], ns.alpha, paper)];
        if (ns.kind === 'blur') return [composite(ns.base, ns.alpha, paper)];
        // gradient：顶部（from）与**底部实际可见色**
        //   ⚠️ 不能直接用 to：`linear-gradient(180deg, from 0%, to stop%)` 的 stop 是
        //      相对元素高度的，stop=150% 时元素底部只走到 from→to 的 2/3，
        //      用 to 当端点会把"实际读得清"的渐变异化成假红（已踩）。
        const stop = parseFloat(String(ns.stop || '100%')) || 100;
        const t = Math.min(1, 100 / stop);
        return [c[ns.from], mix(c[ns.from], c[ns.to], t)];
      };
      const fg = resolveColor(ns.fg, c, 'brand');
      const fg2 = resolveColor(ns.fg2, c, 'ink2');
      for (const [id, color, use] of [['nav-on', fg, '导航选中项文字/图标压导航底'],
        ['nav-off', fg2, '导航未选中项文字/图标压导航底']]) {
        const surfaces = surfacesFor(color);
        const worst = Math.min(...surfaces.map((s) => contrast(color, s)));
        const ok = worst >= 4.5;
        if (!ok) failures++;
        out.push({
          pack: pack.key, mode, id, fg: color,
          bg: surfaces.length > 1 ? surfaces.join(' / ') : surfaces[0],
          ratio: Number(worst.toFixed(2)), min: 4.5, ok, use,
        });
      }
      // 选中态色块：渐变/磨砂导航的前景色已被 AA 压成同一个 ink，选中与未选中
      // 在颜色上不再区分，全靠这块底色 —— 它要是看不见，选中态就等于消失了。
      // 属非文字指示，按 1.15 判定。
      const chipA = ns.chipAlpha === undefined ? 0.10 : ns.chipAlpha;
      const chipSurfaces = surfacesFor(fg);
      const chipWorst = Math.min(...chipSurfaces.map((s) => contrast(composite(fg, chipA, s), s)));
      const chipOK = chipWorst >= 1.15;
      if (!chipOK) failures++;
      out.push({
        pack: pack.key, mode, id: 'nav-chip', fg: `rgba(${fg}, ${chipA})`,
        bg: chipSurfaces.length > 1 ? chipSurfaces.join(' / ') : chipSurfaces[0],
        ratio: Number(chipWorst.toFixed(3)), min: 1.15, ok: chipOK,
        use: '选中项底色块可感知（非文字）',
      });
    }
  }
  return { rows: out, failures };
}const data = JSON.parse(readFileSync(PACKS, 'utf8'));
const asJson = process.argv.includes('--json');
const rows = [];
let failed = 0;

for (const pack of data.packs) {
  const delta = texDelta(pack);
  for (const mode of ['light', 'dark']) {
    const c = pack.modes[mode].colors;
    for (const chk of CHECKS) {
      const fg = c[chk.fg], bg = c[chk.bg];
      if (!fg || !bg) {
        rows.push({ pack: pack.key, mode, id: chk.id, ratio: null, min: chk.min, ok: false, note: '缺色值' });
        failed++;
        continue;
      }
      // 只有压在**页面底色**上的条目才吃肌理：卡片的 --card 是不透明色，整块盖住肌理。
      const d = chk.bg === 'paper' ? delta : 0;
      const bgEff = d > 0 ? mix(bg, fg, d) : bg;
      const r = contrast(fg, bgEff);
      const ok = r >= chk.min;
      if (!ok) failed++;
      rows.push({
        pack: pack.key, mode, id: chk.id, fg,
        bg: d > 0 ? `${bg} → 肌理最坏 ${bgEff}` : bg,
        ratio: Number(r.toFixed(2)), min: chk.min, ok, use: chk.use, texDelta: d,
      });
    }
  }
}

/* ── 导航栏规则（调用点必须在 data / failed 声明之后）── */
const navRes = buildNavRows(data);
rows.push(...navRes.rows);
failed += navRes.failures;

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, failed, rows }, null, 2));
} else {
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.pack}/${r.mode}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const [k, list] of byKey) {
    const bad = list.filter((r) => !r.ok);
    console.log(`\n===== ${k}  ${bad.length ? `❌ ${bad.length} 项不达标` : '✅ 全达标'} =====`);
    for (const r of list) {
      const mark = r.ok ? '✓' : '✗';
      const ratio = r.ratio === null ? '  n/a' : String(r.ratio).padStart(6);
      console.log(`  ${mark} ${r.id.padEnd(16)} ${ratio}  (需 ≥${r.min})  ${r.use || ''}`);
    }
  }
  console.log(`\n===== 结果：${rows.length - failed}/${rows.length} 项达标 =====`);
  if (failed) {
    console.log('\n不达标清单（照这个改 theme/packs.json）：');
    for (const r of rows.filter((x) => !x.ok)) {
      console.log(`  - ${r.pack}/${r.mode} ${r.id}: ${r.ratio} < ${r.min}`);
    }
  }
}

process.exit(failed ? 1 : 0);
