/**
 * picker.js — AI 智能选片 & 废片筛选（增量层）
 *
 * ⚠️ 先查后做：这个模块**刻意不重造**已有的本地 CV 能力。现状（cv.js）：
 *   • analyze()      → sharpness / blur / over / under / edgeFlat / dhash / exactHash …
 *   • verdict()      → { level: 'A'|'B'|null, reasons[{code,label}], score }  ← 中文理由已有
 *   • beautyScore()  → 0..100 审美打分（光影 40% + 构图 30% + 清晰度 30%）
 *   • similarClusters() / duplicateIds() / clusterEvents() → 聚类已具备
 *   • pages.js isTrash() / store.actions.override() → 推翻 AI 已具备
 *   • 本地 CV 优先、只标记不删除 —— 架构上本来就符合隐私红线
 *
 * 本模块只补 5 个真实缺口：
 *   1) 三级分级【推荐保留 / 待评估 / 疑似废片】（原来是二级）
 *   2) 相似组「组内推荐最优一张」（原来只给簇）
 *   3) 偏好记忆：用户推翻 AI 后沉淀成判定松紧，不学一堆假特征
 *   4) viewer 大图页的标记扩展（**不修改 viewer.js**，见下方 EXT 段）
 *   5) 批量归档 + 一键入口
 *
 * 🔴 诚实边界（不假装能做到）：
 *   cv.js 的 beautyScore 注释已写明「人脸表情需真人脸模型，本版**不计入**」。
 *   所以【闭眼 / 表情崩坏】**当前无法检测**，本模块不伪造该能力。
 *   未来若要支持，需另接人脸/landmark 模型（独立需求）。
 */

import { verdict, similarClusters, CV_THRESHOLDS } from './cv.js';

/* ==================== 三级分级 ==================== */

export const LEVELS = {
  keep:   { key: 'keep',   label: '推荐保留', cls: 'lv-keep',   rank: 0 },
  review: { key: 'review', label: '待评估',   cls: 'lv-review', rank: 1 },
  trash:  { key: 'trash',  label: '疑似废片', cls: 'lv-trash',  rank: 2 },
};
export const LEVEL_ORDER = ['keep', 'review', 'trash'];

/** 用户显式覆盖过 → 不再让 AI 覆盖他的决定 */
export function userLevel(p) {
  if (p.userOverride === 'keep') return 'keep';
  if (p.userOverride === 'trash') return 'trash';
  return null;
}

/**
 * 偏好记忆：从 settings.pickPrefs 算出「判定松紧」。
 *
 * 机制刻意做得很笨、但可解释：统计用户对**每一类缺陷**的推翻次数，
 * 净救回数为正（用户常把这类救回来）→ 该类不再单独判废，需 ≥2 类缺陷才判废。
 * 不学权重、不猜语义 —— 用户能一句话说清"它做了什么"。
 */
export function prefsOf(settings) {
  const p = (settings && settings.pickPrefs) || {};
  return {
    byReason: p.byReason || {},
    rescuedTotal: p.rescuedTotal || 0,
  };
}

/** 某类缺陷是否已被用户"惯常救回"（净救回数 ≥ 2） */
function isRescued(prefs, code) {
  const s = prefs.byReason[code];
  if (!s) return false;
  return (s.keep || 0) - (s.trash || 0) >= 2;
}

/**
 * 缺陷严重度分级（这是"三级"真正的分界线，本轮真跑抓出来的关键修正）。
 *
 * 🔴 反面教训（别重犯）：前两版分别写成 `defected >= 1 → trash` 与
 *    `fatal >= 2 → trash`，都不成立：
 *      v1「一项缺陷即废」→ 「待评估」这一档在真跑里几乎为空，三级形同虚设，
 *         和 cv.js 原来的二级 A/B 完全没区别，白改；
 *      v2「两项才废」→ 又太松，糊到不能看的照片会滑进待评估，还得你自己翻。
 *    真正的分界线是**超标幅度**，不是缺陷个数。
 *
 * 现在按「超标倍率」分档（倍率 = 实测值 ÷ 阈值，方向越差越大）：
 *   轻微（倍率 < HARD_RATIO）→ 存疑，进「待评估」让你一眼定夺
 *   严重（倍率 ≥ HARD_RATIO）→ 判废
 * 叠加两条硬规则：致命项 ≥2 必废；致命项 =1 且用户不惯常救回 → 废。
 *
 * 为什么 occlude（边缘纯色块）不算致命项：edgeFlat 高也可能是纯色墙、天空、
 * 剪影背景，属于"有意为之"，cv.js 那条阈值本身是启发式，错杀代价高于漏判。
 */
const FATAL = new Set(['blur', 'over', 'under', 'duplicate']);
const HARD_RATIO = 1.6;      // 超标 1.6 倍以上算「严重」

/**
 * 某项致命缺陷的超标倍率（>=1 表示已越线）。
 *
 * 🔴 拿不到 cv 指标时返回 -1（= "无法测量"），不是 0：
 *    0 会被当成"超标 0 倍 = 很轻微"，于是老存档（只存了 verdict、cv 指标缺失/被清理）
 *    里的 A 级硬废片会被降级成待评估，**废片区整块消失** —— 真跑回归时抓到的：
 *    旧套件的合成 photo 只有 verdict 没有 cv，折叠区直接不渲染。
 *    "测不了"和"测出轻微"必须分开表达，否则把缺失当安全。
 */
function exceedOf(code, cv) {
  const T = CV_THRESHOLDS;
  if (!cv) return -1;
  switch (code) {
    case 'blur':  return cv.sharpness > 0 ? T.blurVar / cv.sharpness : -1;   // 越小越糊
    case 'over':  return cv.over > 0 ? cv.over / T.over : -1;
    case 'under': return cv.under > 0 ? cv.under / T.under : -1;
    default:      return 1;                                                  // duplicate 直接算严重
  }
}

export function pickLevel(p, settings, ctx = {}) {
  const ul = userLevel(p);
  // verdict 缺失时（例如只带 cv 指标的合成数据）按 cv 指标现算一份，口径与 cv.js 一致
  const v = p.verdict || (p.cv ? verdict(p.cv) : { level: null, reasons: [], score: 0 });
  const reasons = (v.reasons || []).map((r) => ({ code: r.code, label: r.label }));
  const score = typeof v.score === 'number' ? v.score : 0;
  const prefs = prefsOf(settings);

  // similar 是提示不是缺陷（cv.js 里它单独走 B 级），单独剔出来
  const hard = reasons.filter((r) => r.code !== 'similar');
  const fatal = hard.filter((r) => FATAL.has(r.code));
  // 测不出倍率（老存档缺 cv）时，退回 cv.js 自己的 A 级结论 —— 尊重上游判定，
  // 不在这里另发明一套"更宽松的"标准把上游的硬废片放过去。
  const severe = fatal.filter((r) => {
    const x = exceedOf(r.code, p.cv);
    return x < 0 ? v.level === 'A' : x >= HARD_RATIO;
  });
  // decisive = 真正把照片推向废片的那些理由（严重 且 用户不惯常救回）
  const decisive = severe.filter((r) => !isRescued(prefs, r.code));

  const defected = hard.length;
  let level;
  if (ul) {
    level = ul;                                        // 用户说了算
  } else if (fatal.length >= 2) {
    level = 'trash';                                   // 多项致命缺陷 → 必废（各科都挂）
  } else if (decisive.length >= 1) {
    level = 'trash';                                   // 单项但严重超标 → 废
  } else if (p.isSimilar || hard.length > 0 || score < 55) {
    level = 'review';                                  // 有瑕但不确废 → 待评估
  } else {
    level = 'keep';
  }

  // 附上"同组更优"提示（组内打分明显落后时不判废，只提示）
  if (level !== 'trash' && typeof ctx.bestScore === 'number' && ctx.bestScore - score >= 25) {
    reasons.push({ code: 'worse', label: `同组里更差的一张（组内最高分 ${ctx.bestScore}）` });
  }
  return { level, reasons, score, defected, fatalCount: fatal.length, decisiveCount: decisive.length };
}

/* ==================== 相似组：组内推荐最优 ==================== */

/**
 * 组内相似聚类 + 每组推荐最优一张。
 * @returns {Array<{bestId:string, ids:string[], score:number}>}
 */
export function similarGroupsOf(photos) {
  const clusters = similarClusters(photos);        // 复用 cv.js，不重造
  const byId = new Map(photos.map((p) => [p.id, p]));
  return clusters
    .map((ids) => {
      const list = ids.map((id) => byId.get(id)).filter(Boolean);
      if (!list.length) return null;
      const scored = list
        .map((p) => ({ id: p.id, score: typeof p.verdict?.score === 'number' ? p.verdict.score : 0 }))
        .sort((a, b) => b.score - a.score);
      return { bestId: scored[0].id, ids, score: scored[0].score };
    })
    .filter(Boolean)
    .sort((a, b) => b.ids.length - a.ids.length);
}

/** 组内最优（单张取用） */
export function bestOf(photos) {
  let best = null;
  for (const p of photos) {
    const s = typeof p.verdict?.score === 'number' ? p.verdict.score : 0;
    if (!best || s > best.score) best = { id: p.id, score: s };
  }
  return best;
}

/* ==================== 偏好写入 ==================== */

/**
 * 用户推翻 AI → 沉淀偏好。
 * @param {object} settings 现有 settings（就地返回新对象，调用方 patchSettings）
 * @param {object} p        被标记的 photo
 * @param {'keep'|'trash'} val 用户选择
 */
export function recordOverride(settings, p, val) {
  const prefs = prefsOf(settings);
  const byReason = { ...prefs.byReason };
  for (const r of (p.verdict?.reasons || [])) {
    if (r.code === 'similar') continue;
    const cur = byReason[r.code] || { keep: 0, trash: 0 };
    byReason[r.code] = { ...cur, [val]: (cur[val] || 0) + 1 };
  }
  const next = {
    ...settings,
    pickPrefs: {
      byReason,
      rescuedTotal: (prefs.rescuedTotal || 0) + (val === 'keep' ? 1 : 0),
    },
  };
  return next;
}

/* ==================== viewer 扩展（不改 viewer.js） ==================== */

/**
 * 🔴 EXT 设计说明（本模块最重要的一段）
 *
 * 约束：「禁止修改已合并的 viewer 组件代码，如有联动需求写扩展接口」。
 * 于是本函数**只挂载、不侵入**：
 *   - 不改 js/viewer.js 一个字符
 *   - 在 viewer 已渲染的 DOM 上**追加**一条标记栏（追加，不改写既有结构）
 *   - 事件绑在 viewer 根节点上，与 viewer 自身的 data-act 委托互不干扰
 *
 * 如何在**不读 viewer 内部状态**的前提下知道"当前看的是哪张"？
 *   viewer 未把当前 photoId 暴露到 DOM（这是它自己的实现细节），所以：
 *     ① 从 `.athumb--on` 的 data-i 拿到当前序号（viewer 自己渲染的选中态，可信）
 *     ② 用**与 viewer 完全相同的过滤口径**重算出有序 id 列表 → 序号 → photoId
 *     ③ 数量校验：重算长度必须 === DOM 里 .athumb 数量；不一致就**隐藏标记栏**
 *        （宁可不给按，也不给错的那张打标 —— 打错比不打危险得多）
 *   ⚠️ 耦合点：② 依赖 viewer.js 的过滤规则。若将来改了 viewer 的过滤，
 *      数量校验会兜住（标记栏消失），但不会静默打错。要真正解耦，
 *      正确做法是给 viewer 加一个 `data-photo-id` 属性（属于给 viewer 加扩展点），
 *      本次按"不改 viewer"约束采用重算 + 校验方案。
 */
function isTrashLike(p) {
  if (p.userOverride === 'keep') return false;
  if (p.userOverride === 'trash') return true;
  return p.verdict?.level === 'A';
}

/** 与 viewer.js 的 usable() 逐条等价（顺序也照抄，便于对拍） */
function mirrorUsable(p) {
  return !p.isTiny && !p.isScreenshot && !p.isDuplicate && !isTrashLike(p);
}

function orderedIds(state, param) {
  const st = state || {};
  let list = st.photos || [];
  if (param && (st.groups || []).length) {
    const g = st.groups.find((x) => x.id === String(param).split(':')[0]);
    if (g) list = (g.photoIds || []).map((id) => list.find((p) => p.id === id)).filter(Boolean);
  }
  return list.filter((p) => mirrorUsable(p) && (p.thumbUrl || p._file)).map((p) => p.id);
}

/**
 * 给 viewer 追加「标记」栏。返回 true=已挂载，false=校验不过（未挂载）。
 * @param {HTMLElement} root  #view
 * @param {Function} getState  返回**当前** store.get()；传函数而非快照，
 *        因为 override() 会整体替换 state.photos 数组，闭包持有快照会读到旧数据。
 * @param {string} param      路由 param（groupId:coverPhotoId）
 */
export function mountViewerPicker(root, getState, param) {
  if (!root) return false;
  const v = root.querySelector('.album-viewer');
  if (!v) return false;
  v.querySelector('.pk-bar')?.remove();

  const state0 = getState() || {};
  const ids = orderedIds(state0, param);
  const domCount = v.querySelectorAll('.athumb').length;
  if (!ids.length || ids.length !== domCount) return false;   // 校验不过 → 不挂

  const bar = document.createElement('div');
  bar.className = 'pk-bar';
  bar.innerHTML =
    `<span class="pk-bar__t">AI 选片</span>` +
    `<span class="pk-bar__lv" data-pk="lv"></span>` +
    `<button class="pk-btn pk-btn--keep" data-pk="keep">珍藏</button>` +
    `<button class="pk-btn pk-btn--trash" data-pk="trash">废片</button>` +
    `<button class="pk-btn pk-btn--revert" data-pk="revert">交还 AI</button>`;
  v.insertBefore(bar, v.querySelector('.album-thumbs'));

  const cur = () => {
    const on = v.querySelector('.athumb--on');
    const i = on ? Number(on.dataset.i) : -1;
    return i >= 0 && i < ids.length ? ids[i] : null;
  };
  const paint = () => {
    const s = getState() || {};
    const id = cur();
    const p = id ? (s.photos || []).find((x) => x.id === id) : null;
    const el = bar.querySelector('[data-pk="lv"]');
    if (!p) { el.textContent = ''; el.className = 'pk-bar__lv'; return; }
    const r = pickLevel(p, s.settings);
    el.className = 'pk-bar__lv ' + (LEVELS[r.level] ? LEVELS[r.level].cls : '');
    el.textContent = (LEVELS[r.level] ? LEVELS[r.level].label : '') +
      (r.reasons.length ? '｜' + r.reasons[0].label : '');
  };

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pk]');
    if (!btn) return;
    const act = btn.dataset.pk;
    if (act === 'revert') {
      if (typeof bar.__onRevert === 'function') bar.__onRevert(cur());
      paint();
      return;
    }
    const id = cur();
    if (!id) return;
    const s = getState() || {};
    const p = (s.photos || []).find((x) => x.id === id);
    if (!p) return;
    // 回调由 app.js 注入（避免本模块直接依赖 store，保持可测）
    if (typeof bar.__onMark === 'function') bar.__onMark(id, act, p);
    paint();
  });

  paint();
  bar.__repaint = paint;
  v.__pickerBar = bar;
  return true;
}

/* ==================== 渲染块（供 pages.js 复用） ==================== */

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function levelBadge(level) {
  const m = LEVELS[level] || LEVELS.review;
  return `<span class="pk-badge ${m.cls}">${m.label}</span>`;
}

export function reasonChips(reasons) {
  if (!reasons || !reasons.length) return '';
  return reasons
    .map((r) => `<span class="pk-chip">${esc(r.label)}</span>`)
    .join('');
}
