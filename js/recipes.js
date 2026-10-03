/**
 * recipes.js — 素材配方的人话化层（P0-Bug2 修复）
 *
 * 🔴 Bug 现象（真跑确认）：配方卡片直接渲染 `JSON.stringify(r.params)`，
 *    渲染进 `<span class="muted">` 里；`.row--between` 不换行，
 *    于是长 JSON 串横向溢出卡片，界面观感就是"乱码式超长字符串"。
 *
 * 本模块职责：**把底层存储 JSON 翻译成人话标签**，主界面一个字符的 JSON 都不给用户看。
 * 原始 JSON 只在「查看全部参数」里以参数表形式呈现（不是原始串），供高级用户抄备份。
 *
 * 为什么单独成文件而不是塞进 pages.js：
 *   pages.js 是纯渲染层（state 进 HTML 出），而这份映射同时要被
 *   导出/批量套用/成套绑定复用 —— 单一真相源，别在多处各抄一份（抄必漂移）。
 */

/**
 * 配方参数的中文标签与展示规则。
 *
 * 🔴 键名与取值域**实测抄自 js/imaging.js 的 applyAdjust() 预设表**，
 *    现有配方只含这 5 个键：bright / soft / warm / sat / contrast。
 *    （第一版这里多写了 grain/fade/sharpen 三个 —— 那三个 applyAdjust 根本不认，
 *     写进标签就是"界面承诺了一个实际不生效的效果"，比显示 JSON 更糟，是骗人。）
 *    将来 imaging 新增参数时，在此补一条即可；未知键走 paramTags 的兜底分支，
 *    会原样显示键名（不静默吞掉），自测里有"标签覆盖率"断言守住这一点。
 */
export const PARAM_META = {
  bright:   { label: '亮度', step: 1,   hint: '整体提亮或压暗' },
  contrast: { label: '对比', step: 1,   hint: '明暗反差' },
  sat:      { label: '饱和', step: 1,   hint: '颜色浓淡' },
  warm:     { label: '色温', step: 1,   hint: '偏暖或偏冷' },
  soft:     { label: '柔化', step: 0.1, hint: '磨皮柔焦程度' },
};

/**
 * 🔴 取舍：**排序按"用户最常调"，不按对象键顺序**。
 *    第一版按 PARAM_META 的声明顺序取前 4 个，结果「柔化」这类同样是核心
 *    手感的参数被切掉了 —— 真跑断言里"必须出现柔化"直接红了。
 *    卡片只有一行高度，能露 4 个，就得挑对。bright/sat/contrast 是最常动的三项，
 *    warm 次之，soft 排最后（但它仍在展开表里，信息不丢）。
 */
const PREVIEW_ORDER = ['bright', 'sat', 'contrast', 'warm', 'soft'];

/**
 * 取配方的人类可读参数列表（按 PREVIEW_ORDER 优先排序，未知键兜底放最后）。
 * @returns {Array<{key,label,value,text,tip}>}
 */
export function paramTags(params) {
  const p = params && typeof params === 'object' ? params : {};
  const keys = Object.keys(p);
  const known = PREVIEW_ORDER.filter((k) => keys.includes(k));
  const extraKnown = Object.keys(PARAM_META).filter((k) => keys.includes(k) && !known.includes(k));
  const unknown = keys.filter((k) => !PARAM_META[k]);
  return [...known, ...extraKnown, ...unknown].map((k) => {
    const meta = PARAM_META[k];
    const v = p[k];
    const num = typeof v === 'number' ? v : Number(v);
    const val = Number.isFinite(num) ? num : v;
    // 显示值：整数不带小数点（6 而不是 6.0），小数保留一位（0.3）
    const text = Number.isFinite(num) ? String(Math.round(num * 10) / 10) : String(v ?? '');
    return {
      key: k,
      label: meta ? meta.label : k,
      value: val,
      text,
      tip: meta ? meta.hint : '自定义参数',
    };
  });
}

/** 紧凑摘要串：亮度6｜柔化0.3｜色温8 —— 卡片上那一句 */
export function summaryLine(params, sep = '｜') {
  const tags = paramTags(params);
  if (!tags.length) return '未设置参数';
  return tags.map((t) => `${t.label}${t.text}`).join(sep);
}

/**
 * 卡片上默认显示前 N 个标签，其余折叠。
 * 为什么限 4 个：配方卡是横向一行的，超出会把卡片撑变形；
 * 剩下的交给「查看全部参数」，保证信息完整但不撑破排版。
 */
export const PREVIEW_TAGS = 4;

/**
 * 🔴 导出专用：给「导出历史」等处用的单行纯文本摘要（无标签结构，纯字符串）。
 */
export function oneLine(params) {
  return summaryLine(params, ' ');
}

/**
 * 生成人类可读的配方名兜底（用户没起名时）。
 * 「我的配方 3」这种序号名在成套绑定场景下很难分辨，改用参数特征命名。
 */
export function autoName(params, fallback = '我的配方') {
  const tags = paramTags(params);
  if (!tags.length) return fallback;
  const top = [...tags].sort((a, b) => {
    const av = typeof a.value === 'number' ? Math.abs(a.value) : 0;
    const bv = typeof b.value === 'number' ? Math.abs(b.value) : 0;
    return bv - av;
  }).slice(0, 2);
  const mood = top.map((t) => `${t.label}${t.text}${t.label === '色温' ? (Number(t.value) > 0 ? '暖' : '冷') : ''}`).join('');
  return `${fallback}·${mood}`;
}
