#!/usr/bin/env node
/**
 * tune-contrast-headroom.mjs — 为主题色买回「肌理预算」的对比度余量
 *
 * 为什么会有这个脚本（P0-3 的连锁结论）：
 *   P0-3 给每套主题加了纸肌理，肌理会把底色朝文字色方向偏移 delta，
 *   而对比度闸门就是按 delta 算最坏值的。实测（scripts/check-texture-render.cjs）
 *   之后把 delta 改成诚实值，问题立刻暴露：
 *
 *     paper/light 的 ink2 压纸底只有 4.53，AA 线是 4.5 —— **余量 0.03**。
 *     把 delta=0.035 的肌理叠上去，二级文字直接掉到 4.36，破 AA。
 *
 *   也就是说：这几套浅色主题**一点肌理都装不下**。想让肌理看得见、又不许破 AA，
 *   唯一出路是把二级色的对比度余量做大 —— 这正是本脚本干的事。
 *
 * 做法（最小改动原则）：
 *   把不达标的颜色朝**该主题自己的 ink** 混合（不是朝纯黑/纯白），
 *   这样色调、色相都留在原来的色系里，只是深浅微调；
 *   用二分法找**刚好达标**的最小混合量，不做多余改动。
 *
 * 达标线：contrast(fg, paper) ≥ 4.5 + 肌理代价(delta) + 余量(默认 0.15)
 *   余量 0.15 是给"以后再加一层轻柔效果"留的，不是随手填的。
 *
 * ⚠️ 只动 ink2 / muted / brand / alert 这四个「可微调」的色。
 *    ink 与 paper 是骨架，动它们等于换主题，脚本不碰。
 *
 * 用法：
 *   node scripts/tune-contrast-headroom.mjs           # 只报告需要动哪些色
 *   node scripts/tune-contrast-headroom.mjs --write   # 写回 theme/packs.json
 *
 * 改完必须跑：gen-theme --write → check-theme-contrast → check-texture-render
 *            → verify-gen-theme --bless（色值有意的变更需重签黄金快照）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'theme', 'packs.json');
const WRITE = process.argv.includes('--write');
const MARGIN = Number(process.env.MARGIN || 0.15);
const AA = 4.5;

const hex2rgb = (h) => {
  const s = String(h).replace('#', '').trim();
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const chan = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
const contrast = (a, b) => {
  const la = lum(hex2rgb(a)), lb = lum(hex2rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const mix = (a, b, t) => {
  const A = hex2rgb(a), B = hex2rgb(b);
  return toHex(A.map((v, i) => v * (1 - t) + B[i] * t));
};

const data = JSON.parse(readFileSync(PACKS, 'utf8'));
// 按用途分档：文字类要 AA(4.5) + 0.15 余量；分隔线是非文字指示，阈值只有 1.15，
// 给它 0.15 的余量等于要求 1.30 —— 那是把线加深一大截，属于过度修正。
// 所以非文字项用小绝对值余量（0.02），刚好越过"被肌理吃掉最后一位小数"的边界。
// （踩过：sweet/light 的 line-on-paper 叠加 delta 后算出 1.1499，报成 1.15 < 1.15。）
const TUNE = [
  { key: 'ink2', min: AA, margin: MARGIN },
  { key: 'muted', min: AA, margin: MARGIN },
  { key: 'brand', min: AA, margin: MARGIN },
  { key: 'alert', min: AA, margin: MARGIN },
  { key: 'line', min: 1.15, margin: 0.02 },
];
const changes = [];

for (const pack of data.packs) {
  const tex = data.textures[pack.texture] || {};
  const delta = typeof tex.delta === 'number' ? tex.delta : 0;
  for (const mode of ['light', 'dark']) {
    const c = pack.modes[mode].colors;
    for (const { key, min, margin } of TUNE) {
      const fg = c[key];
      if (!fg) continue;
      const base = contrast(fg, c.paper);
      // 肌理代价：底色朝该前景色偏移 delta 后，对比度掉多少
      const cost = base - contrast(fg, mix(c.paper, fg, delta));
      const need = min + cost + margin;
      if (base >= need) continue;
      // 二分找最小混合量（朝 ink 走 = 提高对比度）
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (contrast(mix(fg, c.ink, mid), c.paper) >= need) hi = mid; else lo = mid;
      }
      const next = mix(fg, c.ink, hi);
      const after = contrast(next, c.paper);
      changes.push({ pack: pack.key, mode, key, from: fg, to: next, delta,
        base: Number(base.toFixed(3)), cost: Number(cost.toFixed(3)),
        need: Number(need.toFixed(3)), after: Number(after.toFixed(3)) });
      if (WRITE) c[key] = next;
    }
  }
}

if (!changes.length) {
  console.log('===== 对比度余量：全部达标，无需改动 =====');
  process.exit(0);
}

console.log(`===== 对比度余量${WRITE ? '（已写回）' : '（干跑）'}：${changes.length} 个色低于「AA + 肌理代价 + ${MARGIN}」 =====`);
let cur = '';
for (const ch of changes) {
  const head = `${ch.pack}/${ch.mode}`;
  if (head !== cur) { cur = head; console.log(`\n-- ${head}  肌理 delta=${ch.delta}`); }
  console.log(`   ${ch.key.padEnd(6)} ${ch.from} → ${ch.to}   原 ${String(ch.base).padStart(5)}`
    + `  肌理代价 -${ch.cost}  →  目标 ${ch.need}  实得 ${ch.after}`);
}
if (WRITE) {
  writeFileSync(PACKS, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log('\n已写回 theme/packs.json');
  console.log('接着必须跑：gen-theme --write → check-theme-contrast → check-texture-render');
  console.log('            → verify-gen-theme --bless（色值变更是有意的，需重签快照）');
}
