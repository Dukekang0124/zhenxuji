#!/usr/bin/env node
/**
 * 帧叙集 · Android 构建配置漂移闸门
 *
 * 为什么需要它
 * -----------------------------------------------------------------
 * 方案 A 的全部价值建立在一个前提上：**CI 与本地跑的是同一份构建配置**。
 * 但"入库了"只是前提的一半 —— 只要有人（或某个自动化步骤）悄悄改了
 * `build.gradle` / `AndroidManifest.xml`，两套配置又会重新分叉，而且
 * **照样能构建成功、照样全绿**，没人会发现。
 *
 * 原先 CI 里只有一条 `grep -q "keystoreProps"` —— 那是"形似即通过"：
 * 只要文件里还留着一个叫 keystoreProps 的字符串，哪怕签名逻辑被整段删掉、
 * 权限被改、R8 规则被清空，它都放行。本脚本把它升级为**逐字节哈希比对**。
 *
 * 用法（两种模式）
 * -----------------------------------------------------------------
 *   node scripts/check-android-config.mjs            # 校验（CI + 本地都跑）
 *   node scripts/check-android-config.mjs --bless    # 显式重建基准（改配置后）
 *
 * 🔴 `--bless` 必须是**显式人工动作**：如果它在普通构建路径里自动跑，
 *    基准就会跟着改动一起漂，"防漂移"退化成"自我证明"。这是从主题
 *    黄金快照那次踩坑学来的（改色时顺手重签 = 闸门失效）。
 *
 * 版式设计
 * -----------------------------------------------------------------
 * 基准文件 `android/build-config.lock.json` 入库，内容含每个文件的
 * SHA-256 + 行数 + 一句话用途。它**必须入库**，否则 CI 拿不到基准。
 *
 * 为什么锁定的是这几个文件（而不是整个 android/）
 * -----------------------------------------------------------------
 * 锁"会改变构建行为"的配置：Gradle 脚本、清单、proguard、gradle.properties。
 * 不锁源码（MainActivity.java）、不锁资源图（改图标属正常迭代）。
 * 粒度选择原则：**锁住那些"改了就可能导致 CI/本地行为分叉"的东西**，
 * 而不是无差别锁全目录（那会让每次正常迭代都要 bless，闸门很快被忽略）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'android', 'build-config.lock.json');

/**
 * 受管控的构建配置文件 + 用途说明。
 * `why` 会出现在报错里 —— 让人一眼知道"改动这个意味着什么"。
 */
const GUARDED = [
  ['android/app/build.gradle',
   '签名配置 / v2+v3 签名 / R8 排除 WebView 桥接 / versionCode·versionName 宿主'],
  ['android/build.gradle',
   '顶层 AGP 版本与仓库源'],
  ['android/settings.gradle',
   '模块包含关系（含 capacitor-cordova-android-plugins，漏了会构建失败）'],
  ['android/variables.gradle',
   'Capacitor 各版本变量（minSdk/targetSdk/compileSdk）'],
  ['android/gradle.properties',
   'JVM 参数 / AndroidX 开关'],
  ['android/app/proguard-rules.pro',
   'R8 保留规则（WebView JS 桥接类靠它不被混淆）'],
  ['android/app/src/main/AndroidManifest.xml',
   '相册两级权限 / INTERNET / 网络状态权限'],
  ['android/app/capacitor.build.gradle',
   'Java 21 兼容级别 + apply cordova.variables.gradle'],
  ['android/capacitor-cordova-android-plugins/cordova.variables.gradle',
   'cordova 插件扩展点（被 capacitor.build.gradle 第 10 行引用）'],
  ['android/capacitor-cordova-android-plugins/build.gradle',
   'cordova 插件子工程定义'],
];

/**
 * 🔴 这些文件在 CI 流程中会被**合法改写**，因此不纳入哈希比对：
 *   · android/app/build.gradle 的 versionCode/versionName 会被 stamp 步骤改
 *     → 但它的"其余部分"必须不变，所以下面另有归一化比对（见 normalize）。
 *   · android/keystore.properties、android/zhenxuji-release.keystore
 *     是 CI 从 Secrets 现场生成的，不入库也不比对。
 */
const NORMALIZE_BUILD_GRADLE = true;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把 versionCode / versionName 这两行抹平后再算哈希。
 * 理由：CI 的 stamp 步骤会合法改写它们，但**其它任何字符的变化**
 * （签名逻辑被删、R8 规则被改）都必须被发现。
 * 这样既不被版本号干扰，又保住了"配置本体不变"的语义。
 */
function normalize(file, text) {
  if (!NORMALIZE_BUILD_GRADLE || !file.endsWith('app/build.gradle')) return text;
  return text
    .replace(/^([ \t]*)versionCode[ \t]+\d+/m, '$1versionCode <STAMPED>')
    .replace(/^([ \t]*)versionName[ \t]+"[^"]*"/m, '$1versionName "<STAMPED>"');
}

function readGuarded() {
  const out = [];
  const missing = [];
  for (const [rel, why] of GUARDED) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    const raw = fs.readFileSync(abs, 'utf8');
    const norm = normalize(rel, raw);
    out.push({
      path: rel,
      why,
      sha256: sha256(Buffer.from(norm, 'utf8')),
      lines: norm.split(/\r?\n/).length,
    });
  }
  return { out, missing };
}

const isBless = process.argv.includes('--bless');
const { out: current, missing } = readGuarded();

if (missing.length) {
  console.error('::error title=android-config-missing::受管控的构建配置文件缺失');
  missing.forEach((m) => console.error(`  ✗ ${m}`));
  console.error('  → 入库的 android 工程不完整，CI 构建即使侥幸成功也会与本地不一致。');
  process.exit(1);
}

/* ==================== bless：重建基准 ==================== */
if (isBless) {
  const doc = {
    _what: '帧叙集 Android 构建配置基准 —— 用于 CI/本地一致性闸门',
    _why: '方案 A 的核心前提是 CI 与本地跑同一份构建配置；本文件把该前提变成可校验的事实。',
    _howto: '改过任何受管控配置后，必须显式跑 `npm run bless:android` 重建基准，并连同代码一起提交评审。普通构建路径不会自动重建（否则闸门退化成自我证明）。',
    _note: 'app/build.gradle 的 versionCode/versionName 已被抹平为 <STAMPED>，因为 CI 会按 tag 合法改写它们；其余每一个字节都受保护。',
    generated_at: new Date().toISOString(),
    files: current,
  };
  fs.writeFileSync(LOCK, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`[android-config] 已重建基准 → ${path.relative(ROOT, LOCK)}`);
  current.forEach((f) => console.log(`  · ${f.path}  ${f.sha256.slice(0, 12)}…`));
  process.exit(0);
}

/* ==================== 校验 ==================== */
if (!fs.existsSync(LOCK)) {
  console.error('::error title=android-config-lock-missing::基准文件不存在');
  console.error(`  期望路径：${path.relative(ROOT, LOCK)}`);
  console.error('  首次启用请跑一次：npm run bless:android');
  process.exit(1);
}

const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
const baseline = new Map(lock.files.map((f) => [f.path, f]));

const changed = [];
const added = [];
const removed = [];

for (const cur of current) {
  const base = baseline.get(cur.path);
  if (!base) { added.push(cur); continue; }
  if (base.sha256 !== cur.sha256) {
    changed.push({ cur, base });
  }
}
for (const base of lock.files) {
  if (!current.some((c) => c.path === base.path)) removed.push(base);
}

if (!changed.length && !added.length && !removed.length) {
  console.log(`[android-config] ✅ ${current.length} 个受管控构建配置与基准逐字节一致`);
  console.log(`  基准生成于 ${lock.generated_at || '(未知)'}`);
  process.exit(0);
}

console.error('::error title=android-config-drift::Android 构建配置与基准不一致');
if (changed.length) {
  console.error(`\n【被修改 ${changed.length} 个】`);
  for (const { cur, base } of changed) {
    console.error(`  ✗ ${cur.path}`);
    console.error(`      用途：${cur.why}`);
    console.error(`      基准 ${base.sha256.slice(0, 16)}…  →  当前 ${cur.sha256.slice(0, 16)}…`);
    console.error(`      行数 ${base.lines} → ${cur.lines}`);
  }
}
if (added.length) {
  console.error(`\n【新增 ${added.length} 个（未纳入基准）】`);
  added.forEach((a) => console.error(`  + ${a.path}`));
}
if (removed.length) {
  console.error(`\n【基准里有、当前缺失 ${removed.length} 个】`);
  removed.forEach((r) => console.error(`  - ${r.path}`));
}

console.error(`
────────────────────────────────────────────────────────
这意味着「CI 跑的配置」与「基准（本机已验证过的那份）」已经不是同一份。
方案 A 的价值正建立在这两者一致之上，故此处必须人工确认，不能自动放行。

若这是**你有意为之**的配置变更：
  1. 先本地出包验证（npm run apk:debug 或 assembleRelease）
  2. 校验签名指纹：apksigner verify --print-certs -v <apk>
  3. 确认无误后显式重建基准：npm run bless:android
  4. 连同代码一起提交，并在 PR 里说明改了什么、为什么改

若你**没有**主动改过这些文件 → 说明有自动化步骤在悄悄改写配置，
这正是本闸门要拦的情况，请先排查来源。
────────────────────────────────────────────────────────`);
process.exit(1);
