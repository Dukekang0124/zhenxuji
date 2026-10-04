/**
 * pages.js — 页面渲染（纯函数：state 进，HTML 串出）
 *
 * 纪律：所有页面都是纯函数，不读全局、不碰 DOM，便于在浏览器里 import() 后
 *       直接断言产出字符串。事件一律走 data-act 委托，由 app.js 统一处理。
 * 层级：一级 = 4 个 Tab；二级 = 其余页面；三级仅弹窗/浮层。禁止四层嵌套。
 */

import { COPY } from './prompts.js';
import { SCENE_LABEL } from './cv.js';
import { dateRangeText } from './ai.js';
import { THEMES, normalizeTheme, themeName, tokens } from './theme.js';
import { MODE_PREFS, MODE_LABEL } from './appearance.js';
import { paramTags, summaryLine, PREVIEW_TAGS, PARAM_META, PARAM_KEYS, clampParams, SCENE_PRESET } from './recipes.js';
import { KIND_LABEL, fmtWhen } from './exportdl.js';
// AI 选片增量层（三级分级 / 相似组推荐 / 偏好记忆）
import { pickLevel, bestOf, similarGroupsOf, prefsOf, levelBadge, reasonChips } from './picker.js';
// 原图显示源（作品详情页全宽大图用；有 _file 走原图 blobURL，无则回落缩略图）
import { displaySrc } from './imaging.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ==================== 一级：新建 ==================== */

export function pageCreate({ state }) {
  const drafts = state.stories.filter((s) => !s.publishedAt).slice(0, 3);
  return `
    <h1 class="page-title">新建</h1>
    <p class="page-sub">${esc(COPY.homeLead)}</p>

    <button class="entry" data-act="pickAlbum">
      <span class="entry__i">${ICON_BOOK}</span>
      <span class="spacer">
        <span class="entry__t">从手机相册批量整理</span>
        <span class="entry__d">扫描整个相册，AI 自动聚类成事件分组</span>
      </span>
      <span class="entry__arrow">${ICON_ARROW}</span>
    </button>

    <button class="entry" data-act="pickFew">
      <span class="entry__i">${ICON_PLUS}</span>
      <span class="spacer">
        <span class="entry__t">手动选择照片</span>
        <span class="entry__d">勾选少量照片，直接进入故事制作</span>
      </span>
      <span class="entry__arrow">${ICON_ARROW}</span>
    </button>

    ${state.photos.length ? `
      <h2>相册总览</h2>
      <button class="entry" data-act="goAlbum">
        <span class="entry__i">${ICON_GRID}</span>
        <span class="spacer">
          <span class="entry__t">已整理 ${state.photos.length} 张 · ${state.groups.length} 个分组</span>
          <span class="entry__d">查看事件分组，继续制作</span>
        </span>
        <span class="entry__arrow">${ICON_ARROW}</span>
      </button>` : ''}

    ${drafts.length ? `<h2>最近未完成</h2>${drafts.map((s) => storyCard(s, state, true)).join('')}` : ''}

    <div class="privacy">
      <span class="privacy__i">${ICON_LOCK}</span>
      <span class="privacy__t">${esc(COPY.privacyNote)}</span>
    </div>`;
}

/* —— 纤细单线图标（统一 1.25 描边、圆角端点，无填充块） —— */
const S = 'fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"';

const ICON_BOOK = `<svg viewBox="0 0 24 24" width="24" height="24" ${S}>
  <path d="M12 6.4C10.6 5.3 9 4.8 7.4 4.8H6.2A1.8 1.8 0 0 0 4.4 6.6v10.8a1.8 1.8 0 0 0 1.8 1.8h1.2c1.6 0 3.2-.5 4.6-1.6"/>
  <path d="M12 6.4c1.4-1.1 3-1.6 4.6-1.6h1.2a1.8 1.8 0 0 1 1.8 1.8v10.8a1.8 1.8 0 0 1-1.8 1.8h-1.2c-1.6 0-3.2-.5-4.6-1.6"/>
  <path d="M5.2 12.6q3.4-3.2 6.8 0t6.8 0" stroke-width="1.1" opacity=".85"/></svg>`;

const ICON_PLUS = `<svg viewBox="0 0 24 24" width="24" height="24" ${S}>
  <path d="M12 5.8v12.4M5.8 12h12.4"/></svg>`;

const ICON_GRID = `<svg viewBox="0 0 24 24" width="24" height="24" ${S}>
  <rect x="4" y="4.5" width="6.4" height="6.4" rx="2"/><rect x="13.6" y="4.5" width="6.4" height="6.4" rx="2"/>
  <rect x="4" y="13.1" width="6.4" height="6.4" rx="2"/><rect x="13.6" y="13.1" width="6.4" height="6.4" rx="2"/></svg>`;

const ICON_ARROW = `<svg viewBox="0 0 24 24" width="18" height="18" ${S}>
  <path d="M9.5 5.5l7 6.5-7 6.5"/></svg>`;

const ICON_LOCK = `<svg viewBox="0 0 24 24" width="15" height="15" ${S}>
  <rect x="5" y="10.5" width="14" height="9.5" rx="3.2"/><path d="M8.4 10.5V8a3.6 3.6 0 0 1 7.2 0v2.5"/></svg>`;

/**
 * 空状态专用大插画（64px，纤细单线雾棕）。
 * 比 24px 的 ICON_BOOK 更"插画"一点：加了两条内容线表示"等待被填写的故事"，
 * 但**不加任何填充块**——规范明令禁止厚重填充图形。
 *
 * 🔴 描边必须用 ${S.replace(...)} 改写后再拼，不能在 ${S} 之后另写一个
 *    stroke-width：同属性后者不会覆盖前者，写了等于没写（实测插画被渲染成 1.25px）。
 */
const S_THIN = S.replace('stroke-width="1.25"', 'stroke-width="1.1"');
const ICON_BOOK_LARGE = `<svg viewBox="0 0 64 64" width="64" height="64" ${S_THIN}>
  <path d="M32 17.5C28.9 15 25.4 14.1 22 14.1h-2.4A4.1 4.1 0 0 0 15.5 18.2v27.6a4.1 4.1 0 0 0 4.1 4.1h2.4c3.4 0 6.8-1 10-3.4"/>
  <path d="M32 17.5c3.1-2.5 6.6-3.4 10-3.4h2.4a4.1 4.1 0 0 1 4.1 4.1v27.6a4.1 4.1 0 0 1-4.1 4.1H42c-3.4 0-6.8-1-10-3.4"/>
  <path d="M18.6 32.5q6.8-6 13.4 0t13.4 0" stroke-width=".95" opacity=".8"/>
  <path d="M22.5 25.8h5M22.5 39.4h5" stroke-width=".85" opacity=".45"/>
</svg>`;

/* ==================== 二级：相册扫描与事件分组 ==================== */

export function pageAlbum({ state }) {
  if (!state.photos.length) {
    return `<h1 class="page-title">相册总览</h1>${softEmpty('还没有照片哦', '回新建页选几张照片，就可以开始整理故事了')}
      <button class="btn btn--block" data-act="pickAlbum">导入照片</button>
      <button class="btn btn--block btn--ghost" data-act="openViewer">预览相册（四主题查看器）</button>`;
  }
  const scan = state.ui.scan;
  const groups = state.groups.map(groupCard).join('');
  return `
    <h1 class="page-title">相册总览</h1>
    <p class="page-sub">共 ${state.photos.length} 张照片，AI 识别出 ${state.groups.length} 个事件分组</p>

    ${scan && scan.running ? `
      <div class="card">
        <div class="row row--between">
          <span class="muted">正在扫描… ${scan.done}/${scan.total}</span>
          <button class="btn btn--sm btn--ghost" data-act="scanCancel">取消</button>
        </div>
        <div class="progress"><div class="progress__bar" style="width:${pct(scan.done, scan.total)}%"></div></div>
      </div>` : `
      <div class="row" style="gap:8px;margin-bottom:14px">
        <button class="btn btn--sm btn--ghost" data-act="pickAlbum">补充导入</button>
        <button class="btn btn--sm btn--ghost" data-act="regroup">重新聚类</button>
        <button class="btn btn--sm btn--ghost" data-act="openViewer">查看大图</button>
        <button class="btn btn--sm" data-act="aiPickAll">AI 帮我选片</button>
      </div>`}

    ${state.groups.length ? groups : softEmpty('暂时还没分出组', '照片再多一些，或者回到新建页重新整理一次就会好')}`;
}

/**
 * 事件分组卡（规范六.2）：照片作封面大图，标题以半透雾棕叠在照片下缘。
 * 叠加层用渐变遮罩保证任何亮度照片上文字都读得清 —— 规范禁止厚重色块，
 * 渐变遮罩是保证可读性的最小手段，不构成"网红渐变装饰"。
 * 🔴 方案A（2026-10-03）：卡片本体改为可点，点开该分组大图浏览。
 *    传 groupId + 封面照片 **id**（不用序号 —— viewer 会过滤废片，序号必然错位）。
 *    卡内 .gcard__acts 三个按钮自带 data-act，事件委托 closest([data-act]) 会优先
 *    命中按钮本身，故「制作故事 / 重命名 / 删除」不会被卡片点击劫持。
 *    不改动任何分组数据读取逻辑，只增加一个交互入口。
 */
function groupCard(g) {
  const hasCover = Boolean(g.coverThumb);
  return `
    <div class="gcard ${hasCover ? '' : 'gcard--nophoto'}"
         data-act="openViewer" data-id="${esc(g.id)}" data-start="${esc(g.coverId || '')}">
      <div class="gcard__cover">
        ${hasCover
          ? `<img src="${esc(g.coverThumb)}" alt=""><span class="gcard__veil"></span>
             <span class="gcard__txt">
               <span class="gcard__t">${esc(g.title)}</span>
               <span class="gcard__m">${g.photoIds.length} 张 · ${esc(SCENE_LABEL[g.sceneTag] || '日常')}</span>
             </span>`
          : `<span class="gcard__txt gcard__txt--plain">
               <span class="gcard__t">${esc(g.title)}</span>
               <span class="gcard__m">${g.photoIds.length} 张 · ${esc(SCENE_LABEL[g.sceneTag] || '日常')}</span>
             </span>`}
      </div>
      <div class="gcard__acts">
        <button class="btn btn--sm" data-act="startStory" data-id="${esc(g.id)}">制作故事</button>
        <button class="btn btn--sm btn--text" data-act="renameGroup" data-id="${esc(g.id)}">重命名</button>
        <button class="btn btn--sm btn--text" data-act="delGroup" data-id="${esc(g.id)}">删除</button>
      </div>
    </div>`;
}

/* ==================== 二级：AI 选片 ==================== */

/**
 * AI 选片（2026-10-03 升级为三级 + 相似组推荐 + 批量归档）
 *
 * 🔴 保持不破坏原有链路：
 *   • pageEdit / pageCompose / doFinish 仍按 isTrash() 过滤，语义**未变**
 *   • 「点照片切换 保留/废片」的交互沿用 togglePhoto，用户推翻 AI 的路径没变
 *   • 本次只把**展示层**从二级换成三级，并新增相似组推荐与批量操作
 */
export function pagePick({ state, param }) {
  const g = state.groups.find((x) => x.id === param);
  if (!g) return `<h1 class="page-title">AI 选片</h1>${softEmpty('找不到这组照片了', '可能已经被整理走了，回新建页重新选一批吧')}`;
  const photos = g.photoIds.map((id) => state.photos.find((p) => p.id === id)).filter(Boolean);
  const settings = state.settings || {};

  // 三级分级（含组内"更差"提示）
  const best = bestOf(photos);
  const rows = photos.map((p) => ({ p, r: pickLevel(p, settings, { bestScore: best ? best.score : undefined }) }));
  const bucket = (lv) => rows.filter((x) => x.r.level === lv);
  const keep = bucket('keep');
  const review = bucket('review');
  const trash = bucket('trash');

  // 相似组：每组推荐组内最优一张
  const simGroups = similarGroupsOf(photos);
  const inGroup = new Set();
  for (const sg of simGroups) {
    if (sg.ids.length > 1) sg.ids.forEach((i) => inGroup.add(i));
  }
  const simRows = rows.filter((x) => inGroup.has(x.p.id));

  const card = (x) => `
    <div class="pk-cell">
      ${photoCard(x.p)}
      <div class="pk-cell__m">
        ${levelBadge(x.r.level)}
        <span class="pk-score" title="审美打分（光影40%+构图30%+清晰度30%）">${x.r.score}</span>
      </div>
      ${reasonChips(x.r.reasons)}
    </div>`;

  const section = (title, list, hint) => (list.length ? `
    <h2>${title} ${list.length} 张</h2>
    ${hint ? `<p class="muted" style="margin:-6px 0 10px">${hint}</p>` : ''}
    <div class="grid pk-grid">${list.map(card).join('')}</div>` : '');

  // 偏好提示：说清 AI 因为你的纠正而改了什么（可解释性核心）
  const prefs = prefsOf(settings);
  const rescued = Object.entries(prefs.byReason)
    .filter(([, v]) => (v.keep || 0) - (v.trash || 0) >= 2)
    .map(([code]) => REASON_CN[code] || code);

  return `
  <h1 class="page-title">AI 选片</h1>
  <p class="page-sub">${esc(g.title)} · ${photos.length} 张 · ${esc(COPY.trustNote)}</p>

  <div class="note">
    AI 只做<b>标记</b>，<b>绝不删除你的原图</b>。你随时可以推翻它 —— 推翻了，AI 会记住你的口径。
    ${rescued.length ? `<br>已记住：<b>${esc(rescued.join('、'))}</b> 这类你常救回来，以后不再单独判废。` : ''}
  </div>

  ${simGroups.length ? `
    <h2>相似连拍 ${simGroups.length} 组</h2>
    <p class="muted" style="margin:-6px 0 10px">同场景高度相似的照片，AI 已各挑一张最优，其余可一键归档</p>
    ${simGroups.map((sg) => {
      const members = sg.ids.map((id) => rows.find((x) => x.p.id === id)).filter(Boolean);
      const bestRow = members.find((x) => x.p.id === sg.bestId) || members[0];
      const others = members.filter((x) => x.p.id !== sg.bestId);
      return `
      <div class="pk-sim">
        <div class="pk-sim__h">${members.length} 张相似 · 推荐第 ${members.indexOf(bestRow) + 1} 张（${bestRow.r.score} 分）</div>
        <div class="pk-sim__b">
          <div class="pk-sim__best">
            ${card(bestRow)}
            <button class="btn btn--sm" data-act="archiveSimilar" data-id="${esc(g.id)}" data-ids="${esc(others.map((o) => o.p.id).join(','))}">归档其余 ${others.length} 张</button>
          </div>
          <div class="pk-sim__rest">${others.map((x) => `<div class="pk-sim__o">${card(x)}</div>`).join('')}</div>
        </div>
      </div>`;
    }).join('')}` : ''}

  ${simRows.length ? section('相似组里的照片', simRows) : ''}
  ${section('推荐保留', keep, 'AI 认为这些可以直接用')}
  ${section('待评估', review, '有轻微疑点，建议你扫一眼再决定')}

  ${trash.length ? `
    <!-- 🔴 默认**折叠**，这是信息层级决策不是偷懒：疑似废片是低频关注项，
         铺开会在 36 张相册里糊掉满屏，把「推荐保留 / 待评估」这两个真正要看的区挤没。
         保留与待评估在上方直接可见；废片折叠、标题带数量，想看再点开。 -->
    <div class="fold" id="foldTrash">
      <button class="fold__h" data-act="toggleFold" data-target="foldTrash">
        <span>疑似废片 ${trash.length} 张（已标记，未删除）</span><span>▾</span>
      </button>
      <div class="fold__b">
        <p class="muted" style="margin:0 0 10px">仅标记，不删除手机原图。点任意一张可恢复。</p>
        <div class="grid pk-grid">${trash.map(card).join('')}</div>
        ${trash.length > 1 ? `<button class="btn btn--sm btn--ghost" data-act="batchArchive" data-id="${esc(g.id)}">全部标记为废片（${trash.length} 张）</button>` : ''}
      </div>
    </div>` : ''}

  <div style="margin-top:18px">
    <button class="btn btn--block" data-act="goEdit" data-id="${esc(g.id)}">下一步：批量修图</button>
  </div>`;
}

const REASON_CN = {
  blur: '模糊', over: '过曝', under: '死黑', occlude: '遮挡', duplicate: '完全重复',
};

function isTrash(p) {
  if (p.userOverride === 'keep') return false;
  if (p.userOverride === 'trash') return true;
  return p.verdict?.level === 'A';
}

export function photoCard(p) {
  const trash = isTrash(p);
  const v = p.verdict || {};
  // 🔴 标签文案改柔和表述：规范六.1 要求「废片标签使用柔和浅底色，
  //    不使用大红强警示，页面不压迫」。措辞从"硬废片"降级为"建议不用"。
  const tag = trash ? '<span class="ph__tag ph__tag--soft">建议不用</span>'
    : p.isSimilar ? '<span class="ph__tag ph__tag--soft">相似</span>' : '';
  const reasons = (v.reasons || []).map((r) =>
    `<span class="chip ${r.code === 'similar' ? 'chip--b' : ''}">${esc(r.label)}</span>`).join('');
  return `
    <div class="ph ${trash ? 'ph--a' : p.isSimilar ? 'ph--b' : ''}"
         data-act="togglePhoto" data-id="${esc(p.id)}" title="${esc(reasons.replace(/<[^>]+>/g, ''))}">
      ${p.thumbUrl ? `<img src="${esc(p.thumbUrl)}" alt="">` : ''}
      ${tag}
      <span class="ph__score">${p.score ?? '-'}</span>
    </div>`;
}

/* ==================== 二级：批量修图 ==================== */

export function pageEdit({ state, param }) {
  const g = state.groups.find((x) => x.id === param);
  if (!g) return `<h1 class="page-title">批量修图</h1>${softEmpty('找不到这组照片了', '可能已经被整理走了，回新建页重新选一批吧')}`;
  const photos = g.photoIds.map((id) => state.photos.find((p) => p.id === id)).filter(Boolean).filter((p) => !isTrash(p));
  const recipes = state.recipes.filter((r) => r.type === 'beauty');
  const done = photos.filter((p) => p.enhancedUrl).length;
  const bundles = (state.settings && state.settings.recipeBundles) || [];
  // 🔴 滑杆初值：优先用「用户已选的配方」，否则用组内主流场景的默认参数。
  //    这两个来源都是**真实参数**，不是占位数字 —— 占位数字会让人以为拖了有用。
  const init = curParams({ state, group: g, recipes });

  return `
    <h1 class="page-title">批量修图</h1>
    <p class="page-sub">按人像 / 风景 / 美食差异化处理，风景与美食不会误加美颜</p>

    <div class="card">
      <div class="fld">
        <label class="fld__l">修图配方</label>
        <select id="recipeSel">
          <option value="">默认（按场景自动）</option>
          ${recipes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}
        </select>
      </div>

      <div class="sliders" id="sliders">
        ${PARAM_KEYS.map((k) => {
          const m = PARAM_META[k];
          return `
          <div class="sld">
            <div class="sld__top">
              <span class="sld__l">${esc(m.label)}</span>
              <span class="sld__v" data-out="${esc(k)}">${fmtParam(init[k])}</span>
            </div>
            <input class="sld__r" type="range" data-p="${esc(k)}"
                   min="${m.min}" max="${m.max}" step="${m.step}" value="${init[k]}">
            <div class="sld__h">${esc(m.hint)}</div>
          </div>`;
        }).join('')}
      </div>

      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn--sm" data-act="applyEnhance" data-id="${esc(g.id)}">应用批量修图</button>
        <button class="btn btn--sm btn--ghost" data-act="saveRecipe" data-id="${esc(g.id)}">存为我的配方</button>
        ${done ? `<button class="btn btn--sm btn--ghost" data-act="revertEnhance" data-id="${esc(g.id)}">撤销全部调色</button>` : ''}
      </div>
      <p class="muted" style="margin:10px 0 0" id="enhanceMsg"></p>
      ${done ? `<p class="muted" style="margin:6px 0 0">已有 ${done} 张套用调色（原图仍在，随时可撤销）</p>` : ''}
      <p class="muted" style="margin:10px 0 0">
        🔴 原图永不被覆盖 —— 调色生成的是新照片，导出时会自动用调色后的版本。
      </p>
    </div>

    ${bundles.length ? `
    <div class="card">
      <h2 style="margin-top:0">成套方案</h2>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${bundles.map((b) => `<button class="btn btn--sm btn--ghost" data-act="loadBundleToEdit" data-id="${esc(b.id)}" data-gid="${esc(g.id)}">${esc(b.name || '成套风格')}</button>`).join('')}
      </div>
      <p class="muted" style="margin:10px 0 0">加载成套 = 套用绑定的美颜配方（真调色）+ 排版模板</p>
    </div>` : ''}

    <h2>待修 ${photos.length} 张</h2>
    <div class="grid">${photos.map((p) => `
      <div class="ph">
        ${p.enhancedUrl
          ? `<img src="${esc(p.enhancedUrl)}" alt=""><span class="ph__tag ph__tag--soft">已调色</span>`
          : (p.thumbUrl ? `<img src="${esc(p.thumbUrl)}" alt="">` : '')}
        <span class="ph__tag">${esc(SCENE_LABEL[p.scene] || '其他')}</span>
      </div>`).join('')}
    </div>

    ${photos.some(hasWarn) ? `<div class="note note--alert">${photos.filter(hasWarn).length} 张有轻微预警（逆光/侧脸/明暗反差），可在下一步单点微调</div>` : ''}

    <div style="margin-top:18px">
      <button class="btn btn--block" data-act="goCompose" data-id="${esc(g.id)}">下一步：故事组装</button>
    </div>`;
}

function hasWarn(p) { return (p.cv && (p.cv.brightness < 90 || p.cv.contrastStd > 95)); }

/**
 * 滑杆初值来源（按优先级）：
 *   1. URL 带了 r=配方id → 该配方参数（从成套方案跳过来时走这条）
 *   2. 组内主流场景的默认参数（"默认（按场景自动）"就是这个意思）
 *
 * 🔴 主流场景而不是第一张照片的场景：这组 30 张里 20 张是人像，
 *    按第一张（可能是张风景）初始化就等于给错了起点。
 */
function curParams({ state, group, recipes }) {
  const q = location.hash.split('?')[1] || '';
  const rid = new URLSearchParams(q).get('r');
  if (rid) {
    const r = recipes.find((x) => x.id === rid);
    if (r && r.params) return clampParams(r.params);
  }
  const photos = group.photoIds.map((id) => state.photos.find((p) => p.id === id)).filter(Boolean);
  const count = {};
  for (const p of photos) count[p.scene || 'other'] = (count[p.scene || 'other'] || 0) + 1;
  const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || 'other';
  return clampParams(SCENE_PRESET[top] || SCENE_PRESET.other);
}

/** 参数显示值：整数不带小数点，小数一位（与 PARAM_META.step 口径一致） */
function fmtParam(v) {
  return String(Math.round(Number(v || 0) * 10) / 10);
}

/* ==================== 二级：手记组装 ==================== */

export function pageCompose({ state, param }) {
  const g = state.groups.find((x) => x.id === param);
  if (!g) return `<h1 class="page-title">故事组装</h1>${softEmpty('找不到这组照片了', '可能已经被整理走了，回新建页重新选一批吧')}`;
  const photos = g.photoIds.map((id) => state.photos.find((p) => p.id === id)).filter(Boolean).filter((p) => !isTrash(p));
  const templates = state.recipes.filter((r) => r.type === 'template');
  const story = state.stories.find((s) => s.groupId === g.id && !s.publishedAt);

  return `
    <h1 class="page-title">故事组装</h1>
    <p class="page-sub">${photos.length} 张参与 · 文字自动避让画面主体</p>

    <div class="card">
      <div class="fld">
        <label class="fld__l">排序方式</label>
        <select id="orderSel">
          <option value="narrative">AI 叙事逻辑（风景开场→人像→细节→美食）</option>
          <option value="time">按拍摄时间</option>
        </select>
      </div>
      <div class="fld">
        <label class="fld__l">排版模板</label>
        <select id="tplSel">
          ${templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn--sm" data-act="genText" data-id="${esc(g.id)}">生成 AI 文案</button>
      <p class="muted" style="margin:10px 0 0" id="genMsg"></p>
    </div>

    <div class="card" id="textCard">
      <div class="fld">
        <label class="fld__l">封面标题</label>
        <input type="text" id="fCover" value="${esc(story?.text?.cover || '')}">
      </div>
      <div class="fld">
        <label class="fld__l">朋友圈正文</label>
        <textarea id="fBody">${esc(story?.text?.body || '')}</textarea>
      </div>
      <div class="fld">
        <label class="fld__l">互动钩子</label>
        <input type="text" id="fHook" value="${esc(story?.text?.hook || '')}">
      </div>
    </div>

    <h2>参与照片</h2>
    <div class="grid">${photos.map((p) => `
      <div class="ph">
        ${p.thumbUrl ? `<img src="${esc(p.thumbUrl)}" alt="">` : ''}
        <span class="ph__score">${p.score ?? '-'}</span>
      </div>`).join('')}
    </div>

    <div style="margin-top:18px">
      <button class="btn btn--block" data-act="finishStory" data-id="${esc(g.id)}">完成并导出</button>
    </div>`;
}

/* ==================== 二级：导出分享 ==================== */

export function pageShare({ state, param }) {
  const s = state.stories.find((x) => x.id === param);
  if (!s) return `<h1 class="page-title">导出分享</h1>${softEmpty('还没找到这篇手记', '做完一篇之后就可以导出分享啦')}`;
  return `
    <h1 class="page-title">导出分享</h1>
    <p class="page-sub">${esc(s.text?.cover || s.title || '生活故事')}</p>

    <div class="card">
      <h2 style="margin-top:0">朋友圈成套作品</h2>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn--sm" data-act="expGrid" data-id="${esc(s.id)}">叙事九宫格</button>
        <button class="btn btn--sm" data-act="expLong" data-id="${esc(s.id)}">微信竖版长图</button>
      </div>
      <p class="muted" style="margin:10px 0 0">整套自动统一色调；竖版固定 1080 宽，降低朋友圈压缩糊图</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">H5 轻分享</h2>
      <button class="btn btn--sm btn--mint" data-act="expH5" data-id="${esc(s.id)}">生成分享网页</button>
      <p class="muted" style="margin:10px 0 0">
        导出为本地 HTML 文件：<b>微信发给好友即可打开</b>，对方不用下载 APP。
        导出后文件在浏览器下载列表里。
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">导出历史</h2>
      <p class="muted" style="margin:0 0 10px">找不到刚才导出的文件？这里留了每一条的文件名与去向，可随时回看。</p>
      <button class="btn btn--sm btn--ghost" data-act="goExportHistory">
        查看导出历史${(state.ui?.exportHistory || []).length ? `（${state.ui.exportHistory.length}）` : ''}
      </button>
    </div>

    <div class="card">
      <h2 style="margin-top:0">社交数据</h2>
      <div class="row row--between">
        <span class="muted">访问 ${s.stats?.views || 0}</span>
        <span class="muted">点赞 ${s.stats?.likes || 0}</span>
        <span class="muted">留言 ${s.stats?.comments || 0}</span>
      </div>
      ${renderVisitors(s)}
    </div>

    <div style="margin-top:18px">
      <button class="btn btn--block btn--ghost" data-act="goGallery">返回作品集</button>
    </div>`;
}

/**
 * 访客头像预览（P1）。
 *
 * 🔴 隐私红线（康哥明确要求 + 禁止项）：**只渲染本地已有的访客名，不做任何上传**。
 *    访客数据存在 story.visitors 里，纯本地；这里只画小圆点 + 首字，
 *    不存头像图片二进制（那会让存档体积暴涨，且属于"上传原图"的红线区）。
 */
function renderVisitors(s) {
  const vs = Array.isArray(s.visitors) ? s.visitors.slice(0, 8) : [];
  if (!vs.length) return '';
  return `
    <div class="visitors">
      <div class="visitors__lb">${vs.length} 位访客（仅本地记录）</div>
      <div class="visitors__row">
        ${vs.map((v) => `
          <span class="vchip" title="${esc(v.name || '')}${v.at ? ' · ' + fmtWhen(v.at) : ''}">
            <span class="vchip__a">${esc((v.name || '?').slice(0, 1))}</span>
          </span>`).join('')}
      </div>
    </div>`;
}

/* ==================== 一级：作品集 ==================== */

export function pageGallery({ state }) {
  const stories = sortStories(state.stories);
  const memory = lastYearToday(stories);
  return `
    <h1 class="page-title">作品集</h1>
    <p class="page-sub">${stories.length ? `${stories.length}篇手记` : '还没有手记'}</p>
    ${memory ? `<div class="card"><div class="muted">去年今日</div>
      <div style="font-size:15px;margin-top:4px">${esc(memory.text?.cover || memory.title)}</div>
      <button class="btn btn--sm btn--ghost" style="margin-top:8px" data-act="openStory" data-id="${esc(memory.id)}">查看</button></div>` : ''}
    ${stories.length ? stories.map((s) => storyCard(s, state)).join('') : galleryEmpty()}`;
}

/**
 * 作品集排序：已归档在前、草稿在后；同组内按创建时间倒序。
 * 🔴 store.upsertStory 用的是前插（[new, ...old]），最新的一定排在最前，
 *    这对"最近未完成"是对的，但对作品集是错的 —— 用户来这个页面是看成品，
 *    结果一进来先看到自己没写完的草稿。本函数只在渲染层排序，不动 store 顺序。
 */
function sortStories(list) {
  return [...list].sort((a, b) => {
    const aa = a.publishedAt ? 1 : 0;
    const ba = b.publishedAt ? 1 : 0;
    if (aa !== ba) return ba - aa;              // 已归档(1) 排前
    return (b.createdAt || b.publishedAt || 0) - (a.createdAt || a.publishedAt || 0);
  });
}

/**
 * 空状态：规范要求「不纯白空白画布，要引导」。
 * 居中细线册页插画 + 主文案 + 指向底部 Tab 的小字引导。
 */
function galleryEmpty() {
  return `
    <div class="blank">
      <div class="blank__art" aria-hidden="true">${ICON_BOOK_LARGE}</div>
      <p class="blank__t">你的故事手记会在这里展示</p>
      <p class="blank__d">点击底部「新建」，开始整理你的照片故事</p>
    </div>`;
}

/**
 * 手记卡片 —— 规范里的「核心改造，最高优先级」。
 *
 * ⚠️ 必须传 state：封面要取 story.photoIds[0] 对应照片的 thumbUrl，
 *    只凭 story 自身拿不到图（Photo 与 Story 是分离的两张表）。
 *
 * @param {object} s     手记
 * @param {object} state 全局状态，用于反查封面照片
 * @param {boolean} compact 紧凑模式（首页「最近未完成」用，不做 2/3 大封面）
 */
function storyCard(s, state, compact = false) {
  const firstId = (s.photoIds || [])[0];
  const cover = firstId ? state.photos.find((p) => p.id === firstId) : null;
  const archived = Boolean(s.publishedAt);

  if (compact) {
    // 紧凑版：不做封面大图，只是一条可点的摘要行
    return `
      <button class="mini" data-act="openStory" data-id="${esc(s.id)}">
        <span class="mini__t">${esc(s.text?.cover || s.title || '未命名')}</span>
        <span class="mini__m">${esc(s.dateText || '')} · ${s.photoIds?.length || 0} 张</span>
        <span class="entry__arrow">${ICON_ARROW}</span>
      </button>`;
  }

  return `
    <article class="scard" data-act="openStory" data-id="${esc(s.id)}">
      <div class="scard__cover">
        ${cover?.thumbUrl
          ? `<img src="${esc(cover.thumbUrl)}" alt="">`
          : '<div class="scard__ph"></div>'}
        <span class="scard__tag ${archived ? 'scard__tag--ok' : 'scard__tag--draft'}">${archived ? '已归档' : '草稿'}</span>
      </div>
      <div class="scard__body">
        <h3 class="scard__t">${esc(s.text?.cover || s.title || '未命名')}</h3>
        <p class="scard__m">${esc(s.dateText || '')} · ${s.photoIds?.length || 0}张</p>
        <div class="scard__acts">
          <button class="btn btn--sm" data-act="openStory" data-id="${esc(s.id)}">查看</button>
          <button class="btn btn--sm" data-act="shareStory" data-id="${esc(s.id)}">分享</button>
          <button class="btn btn--sm btn--ghost" data-act="delStory" data-id="${esc(s.id)}">删除</button>
        </div>
      </div>
    </article>`;
}

export function pageDetail({ state, param }) {
  const s = state.stories.find((x) => x.id === param);
  if (!s) return `<h1 class="page-title">作品详情</h1>${softEmpty('还没找到这篇手记', '它可能已经被删掉了，回作品集看看')}`;
  const photos = (s.photoIds || []).map((id) => state.photos.find((p) => p.id === id)).filter(Boolean);
  const caps = s.text?.captions || [];
  return `
    <h1 class="page-title">${esc(s.text?.cover || s.title)}</h1>
    <p class="page-sub">${esc(s.dateText || '')}</p>
    ${photos.map((p, i) => {
      const src = displaySrc(p);   // 原图源（有 _file）/ 缩略图（重启后）；同一张只建一次 blobURL
      return `
      <figure style="margin:0 0 18px">
        ${src ? `<img src="${esc(src)}" loading="lazy" decoding="async" style="border-radius:12px;width:100%" alt="">` : ''}
        <figcaption class="muted" style="margin-top:6px">${esc(caps[i] || '')}</figcaption>
      </figure>`;
    }).join('')}
    <div class="card"><div class="body">${esc(s.text?.body || '')}</div>
      <div class="muted" style="margin-top:8px">${esc(s.text?.hook || '')}</div></div>
    <div class="row" style="gap:8px">
      <button class="btn btn--sm" data-act="shareStory" data-id="${esc(s.id)}">分享 / 导出</button>
      <button class="btn btn--sm btn--ghost" data-act="delStory" data-id="${esc(s.id)}">删除</button>
    </div>`;
}

function lastYearToday(stories) {
  const now = new Date();
  return stories.find((s) => {
    const d = new Date(s.createdAt || 0);
    return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() < now.getFullYear();
  }) || null;
}

/**
 * 配方卡（单张）。
 *
 * 🔴 P0-Bug2 修复要点（原来这里直接 `JSON.stringify(r.params)` 塞进 span，
 *    配 `.row--between` 不换行 → 长串横向溢出、观感像乱码）：
 *   ① 主界面**一个字都不给原始 JSON** —— 只给人话标签（亮度6｜柔化0.3…）
 *   ② 超过 PREVIEW_TAGS 个标签自动折叠 + 「查看全部参数」展开
 *   ③ 容器换成 `.rcard`（纵向 flex + min-width:0 + 换行），
 *      从根上断掉横向溢出，而不是靠 overflow:hidden 遮住症状
 *   ④ 原始 JSON 只在展开后的参数表里以「键 + 中文标签 + 值」出现，
 *      不是原始串 —— 用户要抄备份可以照抄，但也看得懂
 */
function recipeCard(r, kind) {
  const tags = paramTags(r.params);
  const shown = tags.slice(0, PREVIEW_TAGS);
  const rest = tags.slice(PREVIEW_TAGS);
  const isTpl = kind === 'template';
  return `
    <div class="rcard" data-act="toggleRecipe" data-id="${esc(r.id)}" data-kind="${kind}">
      <div class="rcard__top">
        <span class="rcard__name">${esc(r.name)}</span>
        ${isTpl
          ? `<span class="rcard__tone">${esc(r.tone || '简约')}</span>`
          : `<span class="rcard__count">${tags.length} 项</span>`}
      </div>
      ${isTpl ? '' : `
        <div class="rcard__tags">
          ${shown.map((t) => `<span class="rtag" title="${esc(t.tip)}">${esc(t.label)}${esc(t.text)}</span>`).join('')}
          ${rest.length ? `<span class="rtag rtag--more">+${rest.length}</span>` : ''}
        </div>
        ${r.thumb ? `<div class="rcard__prev" style="background-image:url('${esc(r.thumb)}')" title="调色预览（原图 → 套用本配方）"></div>` : ''}
        <div class="rcard__more" hidden>
          <table class="rtable">
            ${tags.map((t) => `<tr><td class="rtable__k">${esc(t.key)}</td><td class="rtable__l">${esc(t.label)}</td><td class="rtable__v">${esc(t.text)}</td></tr>`).join('')}
          </table>
          <p class="rcard__hint">${esc(summaryLine(r.params))}</p>
        </div>
      `}
      <!-- 🔴 「查看全部参数」放在折叠区**之外**、操作按钮**之上**：
           放最后会紧贴操作按钮一排小圆钮，视觉上像按钮的下划线；
           放在预览图下面又会被误解成"预览图的说明文字"。 -->
      ${isTpl || !rest.length ? '' : `<span class="rcard__toggle">查看全部参数</span>`}
      <div class="rcard__acts">
        <button class="rbtn" data-act="renameRecipe" data-id="${esc(r.id)}">重命名</button>
        <button class="rbtn" data-act="dupRecipe" data-id="${esc(r.id)}">复制</button>
        ${isTpl ? '' : `<button class="rbtn" data-act="applyRecipeToGroup" data-id="${esc(r.id)}">批量套用</button>`}
        <button class="rbtn rbtn--danger" data-act="delRecipe" data-id="${esc(r.id)}">删除</button>
      </div>
    </div>`;
}

/* ==================== 一级：素材配方 ==================== */

export function pageRecipes({ state }) {
  const beauty = state.recipes.filter((r) => r.type === 'beauty');
  const tpl = state.recipes.filter((r) => r.type === 'template');
  const bundles = (state.settings && state.settings.recipeBundles) || [];
  const groups = state.groups || [];
  // 🔴 一键加载必须有明确的落地分组。这里如实让用户选，而不是偷偷套到"第一个分组"——
  //    套错组是那种"看起来成功了，照片却变了"的坑，比多问一句糟糕得多。
  const gid = groups.length > 1
    ? `<div class="fld">
        <label class="fld__l">套用到哪一组</label>
        <select id="bdTarget">
          ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.title || '未命名分组')}（${(g.photoIds || []).length} 张）</option>`).join('')}
        </select>
      </div>`
    : '';

  // 成套绑定：选一个美颜配方 + 一个排版模板 → 一键加载整套方案
  const bindRow = beauty.length && tpl.length ? `
    <div class="card">
      <h2 style="margin-top:0">成套风格绑定</h2>
      <p class="muted" style="margin:0 0 10px">把美颜配方和排版模板绑成一套，套用时两件事一起做。</p>
      <div class="fld">
        <label class="fld__l">美颜配方</label>
        <select id="bdBeauty">${beauty.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select>
      </div>
      <div class="fld">
        <label class="fld__l">排版模板</label>
        <select id="bdTpl">${tpl.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select>
      </div>
      ${gid}
      <button class="btn btn--sm btn--mint" data-act="makeBundle">绑定为成套</button>
    </div>

    ${bundles.length ? `
      <div class="card">
        <h2 style="margin-top:0">我的成套方案 ${bundles.length}</h2>
        ${bundles.map((b) => {
          // ⚠️ 引用可能因删除配方而失效（store.removeRecipe 会清理，但老存档可能残留）
          //    这里如实显示"已失效"而不是静默显示空名 —— 静默失败最难查
          const bb = beauty.find((r) => r.id === b.beautyId);
          const bt = tpl.find((r) => r.id === b.templateId);
          const ok = Boolean(bb && bt);
          return `
          <div class="bundle">
            <div class="bundle__b">
              <div class="bundle__n">${esc(b.name || '成套风格')}</div>
              <div class="bundle__m">${ok ? `${esc(bb.name)} + ${esc(bt.name)}` : '引用的配方已被删除'}</div>
            </div>
            <button class="rbtn ${ok ? '' : 'rbtn--off'}" data-act="loadBundle" data-id="${esc(b.id)}" ${ok ? '' : 'disabled'}>一键加载</button>
            <button class="rbtn rbtn--danger" data-act="delBundle" data-id="${esc(b.id)}">删</button>
          </div>`;
        }).join('')}
        <p class="muted" style="margin:10px 0 0">
          一键加载 = 对${groups.length > 1 ? '所选分组' : '这组'}的照片<strong>真实调色</strong> + 把排版模板定成该组默认。
          ${groups.length > 1 ? '套用前可在上方切换目标分组。' : ''}
        </p>
      </div>` : ''}`
    : '';

  return `
    <h1 class="page-title">素材配方</h1>
    <p class="page-sub">个人美颜配方与手记排版模板，可绑定成套审美风格</p>

    <h2>美颜配方 ${beauty.length}</h2>
    ${beauty.length ? `<div class="rcards">${beauty.map((r) => recipeCard(r, 'beauty')).join('')}</div>`
      : softEmpty('还没有保存配方', '修图的时候调好效果，点「存为我的配方」就会出现在这里')}

    <h2>排版模板 ${tpl.length}</h2>
    ${tpl.length ? `<div class="rcards">${tpl.map((r) => recipeCard(r, 'template')).join('')}</div>`
      : softEmpty('暂无自定义版式模板', '内置的简约版式已经够用啦，这里可以存你自己喜欢的搭配')}

    ${bindRow}`;
}

/* ==================== 二级：外观主题（V1.5） ==================== */

/** 主题入口图标：一个细线圆 + 三个帧点（与册页母题同源，不引入新图形语言） */
const ICON_PALETTE = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
  stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="8.4"/>
  <circle cx="9.2" cy="9.4" r="1.2" fill="currentColor" stroke="none"/>
  <circle cx="14.8" cy="9.4" r="1.2" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="14.6" r="1.2" fill="currentColor" stroke="none"/>
</svg>`;

/** 使用教程入口图标：一个书页 + 问号（同为细线描边，与既有图形语言一致） */
const ICON_HELP = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
  stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.6 5.2h5.2a2.6 2.6 0 0 1 2.6 2.6v11a2.2 2.2 0 0 0-2.2-2.2H4.6z"/>
  <path d="M19.4 5.2h-5.2a2.6 2.6 0 0 0-2.6 2.6v11a2.2 2.2 0 0 1 2.2-2.2h5.6z"/>
  <path d="M12 9.6a1.7 1.7 0 1 0 0 3.4 1 1 0 0 1 1 1v.9"/>
</svg>`;

/** 当前主题的勾选标记 */
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.6 4.5L19 7.6"/></svg>`;

/** 明暗三选（方案：明暗是每套主题内部的子选项，不是并列的第二套皮肤）
    label 走 appearance.js 的 MODE_LABEL —— 与设置页入口、切换 toast 共用一份用词 */
const MODE_OPTIONS = MODE_PREFS.map((k) => ({ key: k, label: MODE_LABEL[k] }));

/** 分组顺序展示；分组名与说明写在这里，主题成员由 packs.json 的 group 字段决定 */
const THEME_GROUPS = [
  { key: 'scene', title: '场景主题', sub: '旅行、老照片、甜品、日常 —— 按场景换一套气质' },
  { key: 'classic', title: '经典主题', sub: '素雅耐看，什么照片都压得住' },
];

/**
 * 主题选择页「选择你的主题气质」。
 *  🔴 预览色条直接读 theme.js 的 tokens —— 与 CSS 变量同源，
 *     绝不在这里另抄一份 hex（抄了就会和 CSS 漂移，切主题时预览色不对）。
 *  🔴 主题数量、名字、分组全部由配置驱动：加一套主题只改 packs.json，
 *     本文件一行都不用动（这正是「配置化」要兑现的东西）。
 */
export function pageTheme({ state }) {
  const s = state.settings || {};
  const cur = normalizeTheme(s.theme);
  const curMode = MODE_OPTIONS.some((m) => m.key === s.mode) ? s.mode : 'auto';
  // 色条要展示「用户此刻看到的那套色」，所以 auto 要先解析成实际明暗再取 token
  const prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const effMode = curMode === 'auto' ? (prefersDark ? 'dark' : 'light') : curMode;

  const card = (t) => {
    const on = t.key === cur;
    const tk = tokens(t.key, effMode);
    return `
      <button class="theme ${on ? 'theme--on' : ''}" data-act="setTheme" data-id="${t.key}"
              aria-pressed="${on}">
        <span class="theme__sw" aria-hidden="true">
          <i style="background:${tk.paper}"></i>
          <i style="background:${tk.brand}"></i>
          <i style="background:${tk.mint}"></i>
          <i style="background:${tk.ink}"></i>
        </span>
        <span class="spacer">
          <span class="theme__t">${esc(t.name)}</span>
          <span class="theme__d">${esc(t.desc)}</span>
        </span>
        <span class="theme__ck" aria-hidden="true">${on ? ICON_CHECK : ''}</span>
      </button>`;
  };

  const groups = THEME_GROUPS
    .map((g) => {
      const list = THEMES.filter((t) => (t.group || 'scene') === g.key);
      if (!list.length) return '';
      return `
    <h2>${esc(g.title)}</h2>
    <p class="page-sub page-sub--tight">${esc(g.sub)}</p>
    <div class="theme-list">${list.map(card).join('')}</div>`;
    })
    .join('');

  return `
    <h1 class="page-title">选择你的主题气质</h1>
    <p class="page-sub">换一套完整外观：底色、主色、字体、图标线宽、导航样式都跟着变</p>

    <h2>明暗</h2>
    <div class="seg" role="group" aria-label="明暗模式">
      ${MODE_OPTIONS.map((m) => `
      <button class="seg__i ${m.key === curMode ? 'seg__i--on' : ''}" data-act="setMode"
              data-id="${m.key}" aria-pressed="${m.key === curMode}">${esc(m.label)}</button>`).join('')}
    </div>
${groups}

    <div class="note">换外观只改界面，不会动你的照片、分组和已经写好的故事；下次打开还是这套。功能位置一个都没变。</div>

    <div style="margin-top:18px">
      <button class="btn btn--block" data-act="goThemeBack">返回设置</button>
    </div>`;
}

/* ==================== 一级：设置 ==================== */

/**
 * 设置页（方案 §5.4 重点改造）：基础设置默认展开，高级开发者设置默认折叠。
 * 🔴 硬约束：**普通用户看不到模型地址、批次数等一切技术内容**。
 *    所有技术词（GLM / Worker / 降级 / 缓存）都被逐字改写成人话。
 */
export function pageSettings({ state }) {
  const s = state.settings;
  const ver = String(window.APP_VERSION || '0.5.0');
  // 入口文案把「明暗」也带上：用户在设置页就能看出自己现在是亮还是暗，不用点进去
  const modeLabel = MODE_LABEL[s.mode] || MODE_LABEL.auto;
  // 🔴 P0(F2)：大模型连接状态展示需要的当前值（来自 store.ui.glmStatus，由 app.js 自动探测填充）
  const gs = (state.ui && state.ui.glmStatus) || null;
  const gsLevel = gs ? gs.level : (s.aiTextEnabled === false ? 'off' : 'idle');
  const gsText = gs ? gs.text
    : (s.aiTextEnabled === false ? '已关闭（在上方开启「智能文案」后自动生效）'
      : '尚未检测 · 点「重新检测」查看模型服务是否连通');
  return `
    <h1 class="page-title">设置</h1>

    <h2>基础</h2>

    <!-- 外观主题入口（方案：入口在【我的】/设置里）。名字与明暗直接读当前值，不是写死的 -->
    <button class="mini" data-act="goTheme">
      <span class="entry__i" aria-hidden="true">${ICON_PALETTE}</span>
      <span class="spacer">
        <span class="entry__t">外观主题</span>
        <span class="entry__d">当前：${esc(themeName(s.theme))} · ${modeLabel}</span>
      </span>
      <span class="entry__arrow" aria-hidden="true">›</span>
    </button>

    <!-- 使用教程：完整链路 + 能力边界。入口放设置页而不是底部导航 ——
         底部导航只有 4 项是产品硬约束（明令禁止加第 5 项），且教程不是高频入口。 -->
    <button class="mini" data-act="goHelp">
      <span class="entry__i" aria-hidden="true">${ICON_HELP}</span>
      <span class="spacer">
        <span class="entry__t">使用教程</span>
        <span class="entry__d">完整流程怎么走，以及这一版做不到什么</span>
      </span>
      <span class="entry__arrow" aria-hidden="true">›</span>
    </button>

    <div class="card">
      <div class="switch">
        <div>
          <div class="switch__t">智能文案</div>
          <div class="switch__d">帮你给照片配文案。关掉也能用，只是文案会变得比较朴素</div>
        </div>
        <button class="tgl ${s.aiTextEnabled ? 'tgl--on' : ''}" data-act="toggleAI"></button>
      </div>
    </div>

    <!-- 🔴 P0(F2)：大模型连接状态 —— 真跑探测后展示，故障给友好提示而非报错 -->
    <div class="card glm-status" id="glmStatus">
      <div class="glm-status__row">
        <div>
          <div class="glm-status__t">大模型连接状态</div>
          <div class="glm-status__d">AI 文案用的 GLM4-Flash 模型服务</div>
        </div>
        <span class="glm-dot glm-dot--${gsLevel}" id="glmDot"></span>
      </div>
      <div class="glm-status__v" id="glmStatusVal">${esc(gsText)}</div>
      <div class="glm-status__a">
        <button class="btn btn--xs" data-act="glmProbe">重新检测</button>
        ${s.aiTextEnabled ? '' : '<span class="muted">（当前已关闭「智能文案」）</span>'}
      </div>
    </div>

    <div class="card">
      <div class="switch">
        <div>
          <div class="switch__t">省电模式</div>
          <div class="switch__d">手机照片比较多时自动轻量处理，整理得慢一点但更省电</div>
        </div>
        <button class="tgl ${s.autoDowngrade ? 'tgl--on' : ''}" data-act="toggleDowngrade"></button>
      </div>
    </div>

    <div class="card">
      <button class="btn btn--sm" data-act="checkUpdate">检查版本更新</button>
      <p class="muted" style="margin:10px 0 0">当前版本 ${esc(ver)}</p>
      <p id="updateMsg" class="muted" style="margin:6px 0 0">${esc(state.ui.updateNote || '')}</p>
    </div>

    <div class="card">
      <button class="btn btn--sm" data-act="clearCache">清理缓存</button>
      <p class="muted" style="margin:10px 0 0">${esc(COPY.cacheTip)}</p>
    </div>

    <h2>隐私</h2>
    <div class="note">${esc(COPY.privacyNote)}</div>

    <h2>数据</h2>
    <div class="card">
      <button class="btn btn--sm btn--alert" data-act="resetAll">清空全部数据</button>
      <p class="muted" style="margin:10px 0 0">清空后无法恢复，请谨慎操作</p>
    </div>

    <details class="adv" id="advPanel">
      <summary class="adv__sum">高级设置（一般用不到）</summary>
      <div class="adv__b">
        <p class="muted" style="margin:0 0 14px">这里是需要自己配置服务才会用到的选项，不确定就别动。</p>

        <div class="fld">
          <label class="fld__l">自定义服务地址（一般不用填）</label>
          <input type="text" id="endpoint" value="${esc(s.glmEndpoint || '')}" placeholder="留空即可，会自动用默认服务">
          <p class="muted" style="margin:8px 0 0">只有想换成自己的服务时才需要填。留空不影响使用。</p>
        </div>
        <div class="fld">
          <label class="fld__l">单批处理张数（当前 ${s.scanBatchSize}）</label>
          <input type="text" id="batchSize" value="${esc(String(s.scanBatchSize))}">
        </div>
        <button class="btn btn--sm" data-act="saveKeys">保存</button>
        <p class="muted" style="margin:12px 0 0">
          你的密钥只存在服务端，这里看不到也改不了。换用哪个模型由服务端决定。
        </p>
      </div>
    </details>

    <div class="note">版本 ${esc(ver)} · 帧叙集</div>`;
}

/* ==================== 更新日志（方案 §2.9.5） ==================== */

export function pageChangelog({ state, param }) {
  const info = state.ui.updateInfo || {};
  const cfg = info.config || {};
  const isForce = Boolean(info.isForce);
  return `
    <h1 class="page-title">${isForce ? '重要版本更新' : '更新记录'}</h1>
    <p class="page-sub">${isForce ? '当前版本部分功能已无法正常使用，请更新到新版本继续使用帧叙集。' : `新版本 ${esc(cfg.latestVersion || '')}`}</p>

    <div class="card">
      <div class="body">${esc(cfg.content || '这次主要是修了一些小问题，让用起来更顺手。')}</div>
      ${cfg.updateTime ? `<p class="muted" style="margin:12px 0 0">发布于 ${esc(cfg.updateTime)}</p>` : ''}
    </div>

    <div style="margin-top:18px;display:flex;flex-direction:column;gap:10px">
      <button class="btn btn--block" data-act="doUpdate">立即更新</button>
      ${isForce ? '' : '<button class="btn btn--block btn--text" data-act="snoozeUpdate">稍后提醒</button>'}
      <button class="btn btn--block btn--text" data-act="goSettings">返回设置</button>
    </div>`;
}

/* ==================== 更新弹窗浮层（可选/强制双态） ==================== */

export function renderUpdateModal(state) {
  const info = state.ui.updateModal;
  if (!info) return '';
  const cfg = info.config || {};
  const isForce = Boolean(info.isForce);
  return `
    <div class="umask" data-act="noopUpdateMask">
      <div class="umodal" role="dialog" aria-modal="true">
        <div class="umodal__t">${isForce ? '重要版本更新' : '帧叙集 发现新版本✨'}</div>
        <div class="umodal__b">${isForce
          ? '当前版本部分功能已无法正常使用，请更新到新版本继续使用帧叙集。'
          : esc(cfg.content || '这次主要是修了一些小问题，让用起来更顺手。')}</div>
        <div class="umodal__acts">
          <button class="btn btn--block" data-act="doUpdate">立即更新</button>
          ${isForce
            ? '<button class="btn btn--block btn--text" data-act="viewChangelog">查看更新内容</button>'
            : `<button class="btn btn--block btn--text" data-act="viewChangelog">查看完整记录</button>
               <button class="btn btn--block btn--text" data-act="snoozeUpdate">稍后提醒</button>`}
        </div>
      </div>
    </div>`;
}

/* ==================== 导出落点弹窗 + 导出历史（P0-Bug1） ==================== */

/**
 * 导出完成弹窗。
 *
 * 🔴 为什么要模态弹窗而不是 toast（这是本轮 P0 的核心）：
 *    toast 一闪就没，用户还没看清"文件在哪"就没了 → 现象就是"导出了但找不到"。
 *    康哥方案里的原始设想是"保存到相册文件夹 + 拉起系统相册定位"，
 *    但**当前项目未装任何 Capacitor 官方插件**（android/ 下无 Filesystem/Photos），
 *    浏览器也不允许网页自行写入相册 —— 那套能力现在拿不到。
 *    所以这里改成：**如实说明这个环境真实发生了什么 + 给能用的补救动作**，
 *    宁可文案朴素，也不谎称"已在相册"（骗一次，用户就再也不信了）。
 */
export function renderExportModal(state) {
  const r = state.ui && state.ui.exportResult;
  if (!r) return '';
  const w = r.where || {};
  return `
    <div class="umask" data-act="closeExport">
      <div class="umodal" role="dialog" aria-modal="true" data-stop="1">
        <div class="umodal__t">${esc(KIND_LABEL[r.kind] || '导出')}完成</div>
        <div class="umodal__d">
          <p class="exdl__ok">${esc(w.ok || '已导出')}</p>
          <p class="exdl__where">${esc(w.where || '')}</p>
          <p class="exdl__detail">${esc(w.detail || '')}</p>
        </div>
        <div class="umodal__acts">
          <!-- 🔴 顺序有讲究：主操作「知道了」（关闭）必须在第一位。
               其一 UX：弹窗是告知落点用的，主按钮应是"明白了"（关闭），再次下载是可选次操作；
               其二 真跑踩坑：弹窗垂直居中，巡检/用户"点遮罩中心"实际会落到第一个按钮上，
               若把「再次下载」放第一，那个点会触发一次重新导出、弹窗永不关闭（回归）。 -->
          <button class="btn btn--block" data-act="closeExport">知道了</button>
          <button class="btn btn--block btn--text" data-act="redownExport" data-id="${esc(r.storyId)}" data-kind="${esc(r.kind)}">再次下载</button>
          <button class="btn btn--block btn--text" data-act="copyExportName" data-name="${esc(r.filename)}">复制文件名</button>
          <button class="btn btn--block btn--text" data-act="goExportHistory">查看导出历史</button>
        </div>
      </div>
    </div>`;
}

/** 导出历史页入口挂在作品分享页顶部；本页为独立路由（不改底部导航） */
export function pageExportHistory({ state }) {
  const list = (state.ui && state.ui.exportHistory) || [];
  const card = (r) => `
    <div class="exh">
      ${r.thumb ? `<div class="exh__thumb" style="background-image:url('${esc(r.thumb)}')"></div>` : '<div class="exh__thumb exh__thumb--none"></div>'}
      <div class="exh__b">
        <div class="exh__t">${esc(KIND_LABEL[r.kind] || '导出')} · ${esc(r.storyTitle || '未命名')}</div>
        <div class="exh__fn">${esc(r.filename)}</div>
        <div class="exh__m">${esc(fmtWhen(r.at))} · ${esc((r.where && r.where.ok) || '')}</div>
        <button class="btn btn--xs btn--text exh__open" data-act="redownExport" data-id="${esc(r.storyId)}" data-kind="${esc(r.kind)}">再次下载</button>
      </div>
    </div>`;
  return `
    <h1 class="page-title">导出历史</h1>
    <p class="page-sub">共 ${list.length} 条。导出只生成新文件，不会删除或改动你的原图</p>
    ${list.length ? list.map(card).join('') : softEmpty('还没有导出记录', '在作品分享页导出九宫格 / 长图 / 网页后，这里会留下记录，随时回看文件名与去向')}
    <div style="margin-top:18px">
      <button class="btn btn--block btn--ghost" data-act="goGallery">返回作品集</button>
    </div>`;
}

/* ==================== 通用空状态（方案 §5.3：禁止冰冷报错） ==================== */

/**
 * 统一空状态。方案 §5.3 硬性要求：
 *   - 分组/作品不存在时给**温柔引导 + 一键回首页**，不许出现「不存在」这类冰冷字眼；
 *   - 方案 §5.3 原文：「删除冰冷报错代码文字，补齐所有空状态引导」。
 * @param {string} title 主文案
 * @param {string} desc  小字引导
 * @param {string} act   主按钮动作（默认回新建页）
 */
function softEmpty(title, desc, act = 'goCreate', btn = '去整理照片') {
  return `
    <div class="blank">
      <div class="blank__art" aria-hidden="true">${ICON_BOOK_LARGE}</div>
      <p class="blank__t">${esc(title)}</p>
      <p class="blank__d">${esc(desc)}</p>
      <div style="margin-top:22px"><button class="btn" data-act="${esc(act)}">${esc(btn)}</button></div>
    </div>`;
}

function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

/* ==================== 帮助页（完整链路教程 + 能力边界） ==================== */

/**
 * 🔴 这一页为什么必须有，尤其是「能力边界」那一段：
 *
 * 康哥给过一条硬规则 —— **禁止在 UI 里承诺底层引擎不支持的东西**。
 * 落到实处就是：只要某个功能做不到或不持久，必须在用户能查到的地方说清楚，
 * 而不是让人在用的过程中自己撞墙。
 *
 * 撞墙的代价不对称：
 *   能力做不到但没说 → 用户认为是 bug → 差评、退款、卸载；
 *   能力做不到且说清 → 用户理解 → 反而显得靠谱。
 *
 * 所以这一页刻意分两段：
 *   ① 完整链路（做什么、点哪里、按什么顺序）
 *   ② 做不到什么（诚实的边界，含"这一版还没有"和"原理上就不做"）
 * 第二段不是免责声明，是产品说明书的一部分。
 */
export function pageHelp({ state }) {
  const photos = state.photos.length;
  const groups = state.groups.length;
  const recipes = state.recipes.length;
  const stories = state.stories.length;

  return `
    <h1 class="page-title">使用教程</h1>
    <p class="page-sub">从导入照片到分享出去，完整走一遍就会了</p>

    <div class="card">
      <div class="help__stat">
        <span>照片 <strong>${photos}</strong></span>
        <span>分组 <strong>${groups}</strong></span>
        <span>配方 <strong>${recipes}</strong></span>
        <span>作品 <strong>${stories}</strong></span>
      </div>
      <p class="muted" style="margin:10px 0 0">你的照片全部留在这台设备上，没有上传。</p>
    </div>

    <h2>完整链路</h2>
    <ol class="help__ol">
      ${helpStep(1, '新建', '导入照片', '在「新建」页选照片。可以一次选一整批，也可以只选几张试手。系统会读照片的拍摄时间，自动排好顺序。')}
      ${helpStep(2, 'AI 选片', '挑出该留的', '把模糊、过曝、欠曝、重复的挑出来，分成「推荐保留 / 待评估 / 疑似废片」三档。判断在你这台手机上完成，照片不出设备。你随时可以推翻它 —— 推翻几次之后，它会记住你的口味。')}
      ${helpStep(3, '分组', '按场景分册', '系统按时间和场景自动分组。你可以改标题、换封面、删掉不要的组。')}
      ${helpStep(4, '修图', '调参数，真调', '拖动亮度、饱和、色温、对比、柔化五个滑杆，点「应用批量修图」。这一步是真的在改照片的像素，不是加个滤镜样子。原图永远不会被覆盖，随时能一键撤销。调好了点「存为我的配方」，下次直接用。')}
      ${helpStep(5, '故事组装', '写文案，配排版', '给这组照片写标题、正文、每张的说明文字，选一个排版模板。')}
      ${helpStep(6, '分享', '导出三种规格', '九宫格（发朋友圈/小红书）、竖版长图（发微博或长图文）、H5 页面（保存成一个网页文件，双击就能在任何设备上看）。导出后会弹出窗口告诉你文件在哪、叫什么。')}
      ${helpStep(7, '导出历史', '找回刚才导出的文件', '每次导出都会记一条：什么时候、叫什么名字、在哪、缩略图长什么样。点「打开文件」直接跳过去。')}
    </ol>

    <h2>成套方案（进阶）</h2>
    <div class="card">
      <p class="muted" style="margin:0 0 10px">
        「美颜配方 + 排版模板」可以绑成一套。一键加载时会做两件事：对目标分组的照片真实调色，把排版模板定成该组的默认。分组多的时候，加载前可以先选套用到哪一组。
      </p>
      <p class="muted" style="margin:0">
        删掉配方时，引用它的成套方案会一起清理掉 —— 不会出现「点了没反应又不知道为啥」的情况。
      </p>
    </div>

    <h2>AI 选片是怎么判断的</h2>
    <div class="card">
      <p class="muted" style="margin:0 0 10px">它在你手机本地逐张看像素，主要是这四类问题：</p>
      <ul class="help__ul">
        <li><strong>模糊</strong>：画面细节不够锐利</li>
        <li><strong>过曝 / 欠曝</strong>：亮部死白或暗部死黑</li>
        <li><strong>重复</strong>：几乎一样的照片连拍</li>
        <li><strong>相似</strong>：构图接近，会推荐组内最好的一张</li>
      </ul>
      <p class="muted" style="margin:10px 0 0">
        判断分三档而不是一刀切：轻微的进「待评估」，严重的才进「疑似废片」。没有任何东西会被自动删掉 —— 标记只是标记。
      </p>
    </div>

    <h2>做不到什么（这一版）</h2>
    <div class="card">
      <ul class="help__ul help__ul--warn">
        <li><strong>闭眼 / 表情崩坏检测：没有。</strong>识别闭眼需要人脸关键点模型，本地算力扛不住也不准，所以这一项直接没做，不做一个假提示糊弄你。</li>
        <li><strong>场景识别是启发式，不是深度模型。</strong>它按颜色和构图猜「人像 / 风景 / 美食」，偶尔会猜错 —— 猜错了你在修图页改配方就行。</li>
        <li><strong>调色结果不跨会话。</strong>关掉页面再回来，调色会回到原图（配方和参数是存的）。要留住成品，把导出的图片存下来。</li>
        <li><strong>导出历史也是本次会话的。</strong>刷新页面会清空 —— 缩略图存在内存里，永久保存会把手机存储撑爆。</li>
        <li><strong>浏览器版不能直接写进手机相册。</strong>浏览器的安全规则不允许网页自己动相册，导出就是下载到「下载」文件夹。安卓 App 版才有「存进相册」这个选项（正在做）。</li>
        <li><strong>自动删除照片：不做。</strong>永远不会替你删照片。</li>
      </ul>
    </div>

    <h2>隐私</h2>
    <div class="card">
      <p class="muted" style="margin:0">
        照片、配方、访客数据全部只存在这台设备。AI 判断在本机完成；只有你主动点「生成文案」时，才会把必要的文字发给服务端，文案回来后存在本地。
      </p>
    </div>

    <div style="margin-top:18px;display:flex;flex-direction:column;gap:10px">
      <button class="btn btn--block btn--text" data-act="goSettings">返回设置</button>
    </div>`;
}

function helpStep(n, tag, title, desc) {
  return `
    <li class="help__step">
      <span class="help__n" aria-hidden="true">${esc(n)}</span>
      <div class="help__b">
        <div class="help__t"><span class="help__tag">${esc(tag)}</span>${esc(title)}</div>
        <div class="help__d">${esc(desc)}</div>
      </div>
    </li>`;
}
