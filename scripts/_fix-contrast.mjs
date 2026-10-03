/**
 * _fix-contrast.mjs（一次性脚本，跑完即删）
 * 把 packs.json 里不达标的色值自动求解到达标：保持色相与饱和，只调明度。
 * 为什么自动求解而不手调：8 套 × 11 色 × 9 条规则 = 792 个组合，
 * 手调必然顾此失彼（改了 ink2 又踩了 brand），求解器一次到位且可复现。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const packsPath = join(HERE, '..', 'theme', 'packs.json');
const data = JSON.parse(readFileSync(packsPath, 'utf8'));

/* ---------- 色彩工具 ---------- */
const hex2rgb = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const rgb2hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const chan = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (hex) => { const [r, g, b] = hex2rgb(hex); return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b); };
const ratio = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };

const rgb2hsl = (h) => {
  let [r, g, b] = hex2rgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hh = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hh = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hh = ((b - r) / d + 2) / 6;
    else hh = ((r - g) / d + 4) / 6;
  }
  return { h: hh, s, l };
};
const hsl2hex = ({ h, s, l }) => {
  if (s === 0) { const v = l * 255; return rgb2hex(v, v, v); }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return rgb2hex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
};

/** 保持 h/s，把 l 朝目标方向步进，直到 ratio 达标 */
function solve(fg, bg, min, dir) {
  if (ratio(fg, bg) >= min) return { hex: fg, changed: false };
  let hsl = rgb2hsl(fg);
  for (let step = 0; step < 100; step++) {
    hsl = { ...hsl, l: Math.max(0.02, Math.min(0.98, hsl.l + dir * 0.01)) };
    const cand = hsl2hex(hsl);
    if (ratio(cand, bg) >= min) return { hex: cand, changed: true };
  }
  return { hex: fg, changed: false, unsolved: true };
}

/* ---------- 规则（fg 往哪调：文字变深 / 浅色文字变浅） ---------- */
const RULES = [
  { fg: 'ink', bg: 'paper', min: 7.0, dir: -1 },
  { fg: 'ink', bg: 'card', min: 7.0, dir: -1 },
  { fg: 'ink2', bg: 'paper', min: 4.5, dir: -1 },
  { fg: 'ink2', bg: 'card', min: 4.5, dir: -1 },
  { fg: 'muted', bg: 'paper', min: 4.5, dir: -1 },
  { fg: 'brand', bg: 'paper', min: 4.5, dir: -1 },
  { fg: 'alert', bg: 'paper', min: 4.5, dir: -1 },
  { fg: 'onBrand', bg: 'brand', min: 4.5, dir: +1 },
  { fg: 'line', bg: 'paper', min: 1.15, dir: -1 },
];

let fixed = 0;
const log = [];
for (const pack of data.packs) {
  for (const mode of ['light', 'dark']) {
    const c = pack.modes[mode].colors;
    for (const r of RULES) {
      // onBrand 变浅可能仍不够（brand 太浅）→ 先试 onBrand，不行再压 brand
      let res = solve(c[r.fg], c[r.bg], r.min, r.dir);
      if (res.changed) {
        log.push(`${pack.key}/${mode} ${r.fg} ${c[r.fg]} → ${res.hex}  (对 ${r.bg})`);
        c[r.fg] = res.hex; fixed++;
      }
      if (r.fg === 'onBrand' && ratio(c.onBrand, c.brand) < r.min) {
        const b2 = solve(c.brand, c.onBrand, r.min, -1);
        log.push(`${pack.key}/${mode} brand ${c.brand} → ${b2.hex}  (按钮底太浅，压深)`);
        c.brand = b2.hex; fixed++;
      }
    }
  }
}

writeFileSync(packsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(`[fix] 调整 ${fixed} 处：`);
for (const l of log) console.log('  ' + l);
