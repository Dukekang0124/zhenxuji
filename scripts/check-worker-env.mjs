#!/usr/bin/env node
/**
 * 帧叙集 · Worker 运行环境兼容性静态扫描
 *
 * 为什么需要它
 * -----------------------------------------------------------------
 * Cloudflare Workers 里**没有 `process` 对象**（那是 Node 的东西）。
 * 裸写 `process.env.X` 在本地 `node` 下跑得好好的，一上 Worker 就抛
 * `ReferenceError: process is not defined`，把整个请求打成 500 ——
 * **本地全绿、线上才炸**，是最贵的一类缺陷（已实际发生过一次）。
 *
 * 靠人记住"要写 typeof process"不可靠。本脚本把这条规则变成构建期闸门：
 * 任何**会被部署到 Worker** 的源码里出现裸 `process` 访问 → 直接判失败。
 *
 * 关键设计：区分「部署产物」与「本地工具」
 * -----------------------------------------------------------------
 * `worker/verify-llm.js` 这类是**本地 Node 单测脚本**，只在开发机跑，
 * 用 `process.env` 完全正确，不该被拦。所以扫描范围不是"整个 worker/ 目录"，
 * 而是**默认排除本机工具脚本**（见 LOCAL_TOOLS）。
 * 判断依据是"这个文件会不会被 wrangler 部署" —— 部署入口是 index.js，
 * 它 import 的东西才进产物。
 *
 * 跑法：node scripts/check-worker-env.mjs
 * 退出码：0 通过 / 1 发现问题
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = path.join(ROOT, 'worker');

/**
 * 只在本地 Node 跑的工具脚本，不参与 Worker 部署 → 允许裸 process。
 * 新增同类脚本时加到这里，并在文件头注释说明它是本地工具。
 */
const LOCAL_TOOLS = new Set([
  'verify-llm.js',
  'verify-deployed.cjs',
  'verify-version.js',
  'probe-models.cjs',
  'probe-multi.cjs',
]);

/** Worker 允许的 process 用法：必须先做存在性判断 */
const SAFE_PATTERNS = [
  /typeof\s+process\s*!==?\s*['"]undefined['"]/,
  /typeof\s+process\s*===?\s*['"]undefined['"]/,
  /typeof\s+process\s*!==?\s*['"]undefined['"]\s*&&/,
  /globalThis\s*\.\s*process/,
];

/** 命中即报：裸 process 访问 */
const BARE_PROCESS = /(?<![.\w])process\s*\.\s*(env|argv|versions|platform|cwd|exit|stdout|stderr|nextTick|hrtime)/;

/**
 * 剥掉注释，避免"注释里提到 process 就报错"（会制造假红把真缺陷淹掉）。
 *
 * 🔴 必须同时处理三种注释形态 —— 第一版只剥了 `//`，结果一块
 *    JSDoc 里描述"这里曾直接写 process.env"的说明文字被当成真代码，
 *    一次性报出 6 条假红。**假红比漏报更坏**：它会训练人忽略这个闸门。
 *      · 行注释   // ...
 *      · 块起止   /* ... * /（同一行内）
 *      · 块续行   * ...   ← 最容易被漏掉的那种
 *    用状态机跨行追踪"当前是否在块注释里"，不能按行孤立判断。
 */
function makeCommentStripper() {
  let inBlock = false;
  return (line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) return out;          // 整行仍在块注释内
        inBlock = false;
        i = end + 2;
        continue;
      }
      // 块注释开始
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      // 行注释开始（排除 http:// 这类 URL）
      if (line[i] === '/' && line[i + 1] === '/' && !/https?:$/.test(out.slice(-6))) {
        return out;
      }
      out += line[i];
      i += 1;
    }
    return out;
  };
}

const problems = [];
const scanned = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'build', '.wrangler', 'dist'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(js|mjs|cjs)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

if (!fs.existsSync(WORKER_DIR)) {
  console.error('[worker-env] 找不到 worker/ 目录');
  process.exit(1);
}

for (const file of walk(WORKER_DIR)) {
  const rel = path.relative(WORKER_DIR, file).replace(/\\/g, '/');
  const base = path.basename(file);
  if (LOCAL_TOOLS.has(base)) continue;

  scanned.push(rel);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const stripComment = makeCommentStripper();   // 每个文件一个独立状态机

  lines.forEach((raw, i) => {
    const code = stripComment(raw);
    if (!BARE_PROCESS.test(code)) return;

    // 同一行（或上文 3 行内）有存在性判断 → 放行
    const ctx = [lines[i - 3], lines[i - 2], lines[i - 1], raw].filter(Boolean).join('\n');
    if (SAFE_PATTERNS.some((re) => re.test(ctx))) return;

    problems.push({
      file: rel,
      line: i + 1,
      code: raw.trim().slice(0, 120),
    });
  });
}

/* ---------- 反向自检：闸门必须有鉴别力 ---------- */
// 拿一个"故意写错"的样本喂给检测逻辑，确认它真的会报。
// 否则规则写错（比如正则拼错）会导致永远 0 命中 —— 假绿比没闸门更坏。
function selfTest() {
  const mustCatch = [
    'const k = process.env.GLM_KEY_A;',
    'if (process.env.X) { doThing(); }',
    'const p = process.platform;',
  ];
  // 该放行的样本里，关键是把「块注释里的 process」也覆盖到 ——
  // 第一版就是漏了这种，导致 6 条假红。
  const mustPass = [
    "if (typeof process !== 'undefined' && process.env) raw = process.env.X;",
    '// 这里说明 process.env 在 Worker 里不存在',
    ' * 老版本这里直接写 process.env[k] —— 在 Worker 上会抛',
    ' *   🔴 Cloudflare Workers 里没有 process.env（那是 Node 的东西）。',
    'const x = globalThis.process?.env;',
  ];
  const strip1 = () => makeCommentStripper();
  const misses = [];
  let s = strip1();
  for (const sample of mustCatch) {
    const code = s(sample);
    if (!BARE_PROCESS.test(code) || SAFE_PATTERNS.some((re) => re.test(code))) misses.push(sample);
  }

  // 🔴 块注释样本必须**连同起始 `/*` 一起、连续喂给同一个状态机** ——
  //    第一次写自检时我只把孤立的 ` * ...` 行喂进去，状态机根本没进入
  //    块注释态，于是自检自己报了「该放没放」。**自检的样本也必须还原真实
  //    上下文**，否则自检本身会产生假红，把一个正确的扫描器判成坏的。
  const falsePos = [];
  const blockFixture = [
    '/*',
    ' * 说明：老版本这里直接写 process.env[k] —— 在 Worker 上会抛',
    ' *   🔴 Cloudflare Workers 里没有 process.env（那是 Node 的东西）。',
    ' */',
  ];
  const s2 = strip1();
  for (const sample of blockFixture) {
    const code = s2(sample);
    if (BARE_PROCESS.test(code) && !SAFE_PATTERNS.some((re) => re.test(code))) falsePos.push(sample);
  }
  const s3 = strip1();
  for (const sample of ['// 这里说明 process.env 在 Worker 里不存在',
                        "if (typeof process !== 'undefined' && process.env) raw = process.env.X;",
                        'const x = globalThis.process?.env;']) {
    const code = s3(sample);
    if (BARE_PROCESS.test(code) && !SAFE_PATTERNS.some((re) => re.test(code))) falsePos.push(sample);
  }
  return { misses, falsePos };
}

const { misses, falsePos } = selfTest();
if (misses.length || falsePos.length) {
  console.error('::error::扫描器自检失败 —— 闸门规则本身有问题，结果不可信');
  if (misses.length) console.error('  该拦没拦:', misses);
  if (falsePos.length) console.error('  该放没放:', falsePos);
  process.exit(1);
}

/* ---------- 输出 ---------- */
console.log(`[worker-env] 扫描 ${scanned.length} 个部署态文件（已排除 ${LOCAL_TOOLS.size} 个本地工具名）`);
scanned.forEach((f) => console.log(`  · ${f}`));

if (problems.length) {
  console.error(`\n::error title=worker-process-incompatible::发现 ${problems.length} 处 Worker 不兼容的 process 访问`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  ${p.code}`);
    console.error(`     ↳ Worker 里没有 process，这行会抛 ReferenceError 打成 500。`);
    console.error(`       修法：if (typeof process !== 'undefined' && process.env) { ... }`);
  }
  process.exit(1);
}

console.log('\n[worker-env] ✅ 无 Worker 不兼容的裸 process 访问；扫描器自检通过');
