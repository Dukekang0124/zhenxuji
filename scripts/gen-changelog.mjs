/**
 * 发版工具：把「技术性的改动清单」改写成「普通用户能读懂的更新日志」，写回 version.json。
 *
 * 方案 §2.9.5 的硬约束：更新日志全文禁止技术术语（HTTP / API / 超时 / 降级 …）。
 * 人工写容易忘，所以这里做两层：
 *   ① 让 GLM 按约束生成；
 *   ② 生成结果再过一遍端侧同一份 sanitizeChangelog + hasTechJargon —— 不达标就**不落盘**。
 * 另外 scripts/build-web.mjs 还有第三道构建期闸门，同样调用端侧函数。
 * 三道闸门共用 js/update.js 里的一套规则，规则永远只有一处真相。
 *
 * 用法：
 *   # 真跑（需要已部署的 Worker）
 *   node scripts/gen-changelog.mjs --worker https://zhenxuji-api.<acct>.workers.dev \
 *        --notes "新增 8 套主题；修复更新检测；底部导航跟随明暗"
 *
 *   # 只看提示词与校验结果，不发网络请求（离线可用）
 *   node scripts/gen-changelog.mjs --dry --notes "..."
 *
 *   # 拿现成文案做校验（手工写完想先验一遍再发版）
 *   node scripts/gen-changelog.mjs --check "这次换主题更方便了。"
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeChangelog, hasTechJargon } from '../js/update.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const VJ = path.join(root, '..', 'version.json');

/** 提示词：把禁技术术语的要求写成模型能执行的具体规则，而不是一句"别说术语" */
export function buildPrompt(notes, version) {
  const system = [
    '你是手机 App 的更新日志编辑，写给完全不懂技术的普通用户看。',
    '硬性要求：',
    '1. 全文禁止出现任何技术术语，例如：接口、服务端、缓存、超时、降级、版本号、API、HTTP、错误码、部署、构建、组件。',
    '2. 不要提"修复了若干问题"这类空话，要说用户能感知到的变化（看到的、听到的、能做的事）。',
    '3. 中文，语气温和克制，不夸张、不网红、不用感叹号堆砌。',
    '4. 2~3 句，总长 120 字以内，不要分点、不要 markdown、不要引号。',
    '5. 直接输出正文，不要任何前后缀说明。',
  ].join('\n');
  const user = `本次改动（内部技术描述，请翻译成用户语言）：\n${notes}\n\n目标版本：${version}`;
  return { system, user };
}

/**
 * 校验并归一一段更新文案。
 * @returns {{ ok: boolean, text: string, reason?: string }}
 */
export function validateChangelog(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, text: '', reason: '空文案' };
  if (hasTechJargon(raw)) return { ok: false, text: '', reason: `含技术术语：${raw.slice(0, 40)}…` };
  const text2 = sanitizeChangelog(raw);
  if (!text2) return { ok: false, text: '', reason: '清洗后为空' };
  if (text2 !== raw) return { ok: false, text: text2, reason: '含被清洗的字符/空白（已给出清洗结果，请人工确认）' };
  return { ok: true, text: text2 };
}

/* ------------------------------ CLI ------------------------------ */

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : '';
}

async function main() {
  const vj = JSON.parse(readFileSync(VJ, 'utf8'));
  const version = vj.latest_version;

  // 纯校验模式：手工写完文案，发版前先验一遍
  const check = argOf('--check');
  if (check) {
    const r = validateChangelog(check);
    console.log(r.ok ? `✓ 文案可用（${check.length} 字）` : `✗ ${r.reason}`);
    if (!r.ok) process.exit(1);
    return;
  }

  const notes = argOf('--notes');
  if (!notes) {
    console.error('用法：node scripts/gen-changelog.mjs --notes "改动清单" [--worker <url>] [--dry]');
    console.error('      node scripts/gen-changelog.mjs --check "现成文案"');
    process.exit(2);
  }

  const { system, user } = buildPrompt(notes, version);
  if (process.argv.includes('--dry')) {
    console.log('[dry] 目标版本:', version);
    console.log('[dry] system:\n' + system);
    console.log('[dry] user:\n' + user);
    console.log('[dry] 不发网络请求。');
    return;
  }

  const worker = String(argOf('--worker') || process.env.ZHENXUJI_WORKER || '').replace(/\/+$/, '');
  if (!worker) {
    console.error('缺少 Worker 地址：--worker <url> 或环境变量 ZHENXUJI_WORKER');
    process.exit(2);
  }

  const res = await fetch(worker + '/api/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 🔴 Worker 有 Origin 精确白名单，Node 的 fetch 默认不带 Origin → 会被 403 拦掉
      //    （表现为 origin_not_allowed，排查时容易误以为是密钥问题）。
      //    这里显式声明成自家站点，等同于"以官方客户端身份调用"。
      Origin: 'https://zhenxuji.pages.dev',
    },
    body: JSON.stringify({ module: 'changelog', system, user, maxTokens: 300 }),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    console.error('生成失败：', JSON.stringify(data));
    process.exit(1);
  }

  const r = validateChangelog(data.text);
  console.log(`模型：${data.model || '?'}  耗时：${data.ms ?? '?'}ms${data.degraded ? '（已降级）' : ''}`);
  console.log('原文：' + data.text);
  if (!r.ok) {
    console.error('✗ ' + r.reason);
    console.error('未写入 version.json，请调整提示词或人工改写后重试。');
    process.exit(1);
  }

  vj.update_content = r.text;
  writeFileSync(VJ, JSON.stringify(vj, null, 2) + '\n', 'utf8');
  console.log(`✓ 已写入 version.json（${r.text.length} 字）`);
}

// 仅在被直接执行时跑 CLI；被 import 时只导出纯函数（便于单测）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
