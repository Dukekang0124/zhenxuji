/**
 * appearance.js — 外观运行态解析（用户偏好 → 实际生效值）
 *
 * 为什么单独成文件（而不是塞进 app.js 或 theme.js）：
 *   ① app.js 要用它（把结果写进 <html data-theme/data-mode>）；
 *   ② export.js 也要用它（导出九宫格/长图/分享页时，必须画成"用户此刻看到的那套色"）；
 *   ③ 但 export.js 不能 import app.js —— app.js 拉着 router/pages，会成环。
 *   ⇒ 于是把这段纯逻辑抽出来，两边共用一份，避免"app 里是深色、导出还是浅色"这种漂移。
 *
 * 为什么不能放进 theme.js：
 *   theme.js 是 scripts/gen-theme.mjs 的生成物，手加的函数会被下次生成覆盖。
 *   theme.js 只负责「把已解析的 light|dark 翻译成 token」，不认识 matchMedia。
 */

import { normalizeTheme } from './theme.js';

export const MODE_PREFS = ['light', 'dark', 'auto'];

/** 界面用词（与主题页的三选按钮、设置页入口文案共用一份，避免三处各写各的） */
export const MODE_LABEL = { light: '亮色', dark: '暗色', auto: '跟随系统' };

/** 偏好归一：非法的（老存档被手改 / null / 未知字符串）一律回落 auto */
export const normalizeModePref = (m) => (MODE_PREFS.includes(m) ? m : 'auto');

/** 系统当前是否深色（无 matchMedia 的老 WebView 视为浅色） */
export const systemDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

/** 用户偏好 light/dark/auto → 实际生效的明暗 */
export function resolveMode(pref) {
  return pref === 'auto' ? (systemDark() ? 'dark' : 'light') : (pref === 'dark' ? 'dark' : 'light');
}

/**
 * 一次性取出「当前该用哪套主题 + 哪个明暗」。
 * @param {object} settings store 里的 settings 对象（可能缺字段，函数内已兜底）
 * @returns {{theme: string, pref: string, mode: 'light'|'dark'}}
 */
export function currentAppearance(settings) {
  const s = settings || {};
  const pref = normalizeModePref(s.mode);
  return { theme: normalizeTheme(s.theme), pref, mode: resolveMode(pref) };
}
