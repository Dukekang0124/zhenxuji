/**
 * _merge-classic.mjs（一次性脚本，跑完即删）
 * 把线上 js/theme.js 的旧四套主题合并进 theme/packs.json，归入 classic 分组。
 * 为什么用脚本而不是手抄：色值手抄一个字就错，读线上文件是唯一真相源。
 * dark 版本线上没有 → 这里给出设计值，随后由 check-theme-contrast 卡达标。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const live = await import(pathToFileURL(join(ROOT, 'js', 'theme.js')).href);
const packsPath = join(ROOT, 'theme', 'packs.json');
const data = JSON.parse(readFileSync(packsPath, 'utf8'));

// 旧主题的元信息（沿用现有命名与描述，不篡改已经过验证的文案）
const META = {
  paper: { name: '纸感原生', desc: '米白纸底 + 雾棕线条，最像一本没写字的册子', scenes: ['日常记录', '书桌碎片'], template: 'minimal-ins', font: 'sans-thin', nav: 'solid-light', icon: 'line-thin', radius: 'compact' },
  cream: { name: '奶油奶茶', desc: '暖调奶油底，像一杯加了奶的下午茶', scenes: ['下午茶', '咖啡馆'], template: 'sweet-scrap', font: 'rounded-soft', nav: 'gradient-soft', icon: 'hand-line', radius: 'soft' },
  magazine: { name: '杂志冷调', desc: '偏冷的灰白底，接近纸质感杂志的内页', scenes: ['街拍', '建筑'], template: 'minimal-ins', font: 'sans-thin', nav: 'solid-light', icon: 'line-thin', radius: 'compact' },
  retro: { name: '轻复古手账', desc: '偏黄的旧纸底 + 深棕线，像用了半年的手账', scenes: ['旧照片', '手账'], template: 'film-memo', font: 'handwrite', nav: 'frosted-dark', icon: 'bold-retro', radius: 'large' },
};

// 旧四套的深色版（线上没有，本次新增；由对比度脚本校验后定稿）
const DARK = {
  paper: { paper: '#1C1A18', brand: '#C9C0B6', accent: '#7E9A8C', ink: '#F2EEE9', ink2: '#A79F97', line: '#33302D', card: '#242220', privacyBg: '#272422', muted: '#A79F97', onBrand: '#1C1A18', alert: '#DE9086' },
  cream: { paper: '#1E1815', brand: '#D9BFA6', accent: '#A8846B', ink: '#F6EDE3', ink2: '#B29C8A', line: '#34291F', card: '#262019', privacyBg: '#2A231C', muted: '#B29C8A', onBrand: '#1E1815', alert: '#E09C7E' },
  magazine: { paper: '#16181A', brand: '#C3CBC6', accent: '#7C8A83', ink: '#EDF0EE', ink2: '#9BA5A0', line: '#2B3033', card: '#1E2123', privacyBg: '#212527', muted: '#9BA5A0', onBrand: '#16181A', alert: '#E09A92' },
  retro: { paper: '#191310', brand: '#D9B194', accent: '#9C7B54', ink: '#F5E9DC', ink2: '#B79C82', line: '#322619', card: '#211A15', privacyBg: '#251D17', muted: '#B79C82', onBrand: '#191310', alert: '#E4917A' },
};

const alphaOf = (s) => { const m = String(s).match(/rgba\([^)]*?,\s*([\d.]+)\)\s*$/); return m ? Number(m[1]) : 0.06; };

const classic = live.THEMES.map((t) => {
  const m = META[t.key];
  const tk = t.tokens;
  const light = {
    paper: tk.paper, brand: tk.brand, accent: tk.mint, ink: tk.ink, ink2: tk['ink-2'],
    line: tk.line, card: tk.card, privacyBg: tk['privacy-bg'], muted: tk.muted,
    onBrand: tk['on-ink'], alert: '#B5645A',
  };
  return {
    key: t.key,
    group: 'classic',
    name: m.name,
    isDefault: false,
    tagline: m.desc,
    scenes: m.scenes,
    iconStyle: m.icon,
    navStyle: m.nav,
    fontSet: m.font,
    radiusScale: m.radius,
    storyTemplate: m.template,
    shadow: { light: { base: alphaOf(tk.shadow), lift: alphaOf(tk['shadow-lift']) }, dark: { base: 0.5, lift: 0.6 } },
    launch: { style: 'paper-plain', titleWeight: 400, showMark: true },
    desktopIcon: `icon-${t.key}`,
    modes: { light: { colors: light }, dark: { colors: DARK[t.key] } },
  };
});

// 新四套标 scene 分组
for (const p of data.packs) p.group = 'scene';

data.packs = [...data.packs, ...classic];
data.defaultPack = 'origin';
data.defaultMode = 'auto';
data.readme.push('group: scene = 场景主题（新四套，女性向场景化），classic = 经典主题（V1.5 四套，素雅耐看）');
data.readme.push('defaultMode: auto = 跟随系统亮暗；也可强制 light / dark');

writeFileSync(packsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(`[merge] 合并完成：${data.packs.length} 套主题（scene ${data.packs.filter((p) => p.group === 'scene').length} + classic ${data.packs.filter((p) => p.group === 'classic').length}）`);
console.log('[merge] keys:', data.packs.map((p) => p.key).join(', '));
