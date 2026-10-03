/** _apply-theme-css.mjs（一次性脚本，跑完即删）：把生成的主题块换进 styles.css */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const cssPath = join(ROOT, 'styles.css');
let css = readFileSync(cssPath, 'utf8');
const gen = readFileSync(join(ROOT, 'theme', 'generated', 'theme.generated.css'), 'utf8');

const START = css.indexOf('/* ================= V1.5 主题皮肤');
const lastRetro = css.indexOf("[data-theme='retro']{");
if (START < 0 || lastRetro < 0) throw new Error('未找到旧主题块边界，拒绝盲替换');
const end = css.indexOf('}', css.indexOf('{', lastRetro)) + 1;

css = css.slice(0, START) + gen.trimEnd() + '\n' + css.slice(end);

// 校验：:root 必须仍在所有 [data-theme] 块之前（否则主题不生效，这是本项目最高危坑）
const iRoot = css.indexOf('\n:root{');
const iFirst = css.indexOf("[data-theme='origin']");
if (!(iRoot > 0 && iFirst > iRoot)) throw new Error('🔴 :root 未排在主题块之前，拒绝写入');

writeFileSync(cssPath, css, 'utf8');
const n = (css.match(/\[data-theme='/g) || []).length;
console.log(`[css] 已替换主题块：${n} 段（8 主题 × light/dark）`);
console.log(`[css] :root@${iRoot} < 首个主题块@${iFirst} ✓`);
