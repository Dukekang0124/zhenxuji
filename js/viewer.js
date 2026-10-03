/**
 * viewer.js — 相册大图查看器（四主题）
 *
 * 为什么独立成文件（不塞进 pages.js）：
 *   - 这是「首页相册大图预览 + 底部横滑缩略卡片」组件，指令里"保留原布局"的前提是它已存在，
 *     但仓库里并没有这个组件（pageAlbum 是事件分组网格）。所以这是**新增**组件，不是改视觉。
 *   - 纯新增、零改动既有页面业务逻辑；用 data-act 委托 + 自带 mount 接管滑动/点选，
 *     不依赖 app.js 重渲染（滑动/选图直接改 DOM，不触发 store，避免整页重建打断滑动）。
 *
 * 皮肤策略（关键）：查看器不持有"自己的 4 套主题"，而是**继承当前激活主题**。
 *   4 套主题就是用户全局 scene 主题（origin/forest/film/sweet），
 *   组件靠 [data-theme=...] 自动套上对应装饰层。四主题同时预览由 docs 预览页用
 *   tokens() 给每个实例单独灌变量实现。
 *
 * 纪律：
 *   - 选择器全以 .album- 前缀，不碰既有规则。
 *   - 不改原图像素，只叠加边框/纹理/标签层（div）。
 *   - 装饰（暗角/柔光/齿孔/云朵/星光/植物/纸张肌理/标签）可一键关，回到干净视图。
 */

import * as router from './router.js';
import { SCENE_LABEL } from './cv.js';   // 场景中文名唯一真相源（与 pageAlbum 同一份）

/* ---------------- 示例照片（data-URI SVG，零位图体积） ---------------- */
/* 仓库无任何图片资产，预览/评审必须有图。生成柔色场景，让主题边框/纹理可见。 */

function scene(c1, c2, ac, sunX, sunY) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 1000'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>` +
    `<stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>` +
    `<rect width='800' height='1000' fill='url(#g)'/>` +
    `<circle cx='${sunX}' cy='${sunY}' r='92' fill='${ac}' opacity='.85'/>` +
    `<path d='M0 780 Q200 640 400 760 T800 720 V1000 H0 Z' fill='${ac}' opacity='.26'/>` +
    `<path d='M0 868 Q260 766 520 852 T800 822 V1000 H0 Z' fill='${ac}' opacity='.5'/>` +
    `</svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

const LEAF_URI =
  'data:image/svg+xml;base64,' + btoa(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<path d='M6 58C18 40 28 30 58 6C42 22 32 32 6 58Z' fill='#4F6B54' opacity='.82'/>` +
    `<path d='M6 58C26 50 40 38 58 6' stroke='#4F6B54' stroke-width='2' fill='none' opacity='.55' stroke-linecap='round'/>` +
    `</svg>`
  );

const STAR_URI =
  'data:image/svg+xml;base64,' + btoa(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>` +
    `<path d='M12 2 L13.6 10.4 L22 12 L13.6 13.6 L12 22 L10.4 13.6 L2 12 L10.4 10.4 Z' fill='#FFF7E6'/>` +
    `</svg>`
  );

const DEMO = [
  { src: scene('#cfe3e0', '#efe7d6', '#f3e3c6', 600, 230), time: '2026.04.12  14:30', place: '杭州 · 西湖', note: 'No.012 / 36', loc: '📍 西湖边' },
  { src: scene('#d8e4d2', '#f0f1e2', '#cfe0c4', 180, 200), time: '2026.05.03  09:10', place: '莫干山 · 竹林', note: 'No.018 / 36', loc: '📍 林间小道' },
  { src: scene('#e7d9d2', '#d9c7cf', '#efd9c8', 640, 250), time: '2026.06.21  18:45', place: '上海 · 外滩', note: 'No.024 / 36', loc: '📍 江畔' },
  { src: scene('#d6e6ec', '#f1e9d8', '#bcd6dd', 200, 220), time: '2026.07.09  16:00', place: '青岛 · 栈桥', note: 'No.029 / 36', loc: '📍 海边' },
  { src: scene('#dfe2ea', '#ece7df', '#cdd6e2', 600, 210), time: '2026.08.15  07:30', place: '丽江 · 雪山', note: 'No.033 / 36', loc: '📍 山脚' },
  { src: scene('#ece0d4', '#f2e9e0', '#d8c2ad', 180, 240), time: '2026.09.02  11:20', place: '成都 · 咖啡馆', note: 'No.036 / 36', loc: '📍 窗边' },
];

/* ---------------- 模块态（查看器内部状态，不进 store） ---------------- */

let vPhotos = DEMO;
let vIndex = 0;

function clamp(i) {
  if (i < 0) return 0;
  if (i > vPhotos.length - 1) return vPhotos.length - 1;
  return i;
}

/* ---------------- 真实照片 → 视图模型 ---------------- */

/* 废片判定：与 pages.js 的 isTrash 口径必须一致（AI 判 A 级 / 用户手动标废） */
function isTrash(p) {
  if (p.userOverride === 'keep') return false;
  if (p.userOverride === 'trash') return true;
  return p.verdict?.level === 'A';
}

/* 大图只展示「可用照片」：口径对齐 scan.js regroup 的 recommendable，再排掉废片。
   🔴 不排废片的话，用户点开大图会看到一堆自己刚标记"建议不用"的废片。 */
function usable(p) {
  return !p.isTiny && !p.isScreenshot && !p.isDuplicate && !isTrash(p);
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmtTime(p) {
  const d = p.takenAt ? new Date(p.takenAt) : (p.mtime ? new Date(p.mtime) : null);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* objectURL 缓存：反复进出 viewer 不重复创建，否则每次渲染泄漏一个 blob URL。
   Map 而非 WeakMap：key 是字符串 id，WeakMap 用不了。 */
const urlCache = new Map();
function srcOf(p) {
  // 🔴 优先级必须是 _file（原图，全分辨率）> thumbUrl（仅 96px 缩略图）。
  //    thumbSize 默认 96，直接拿 thumbUrl 当"大图"会糊成一团。
  if (p._file) {
    let u = urlCache.get(p.id);
    if (!u) { u = URL.createObjectURL(p._file); urlCache.set(p.id, u); }
    return u;
  }
  return p.thumbUrl || '';
}

function fromPhotos(list) {
  const ok = list.filter((p) => usable(p) && srcOf(p));
  return ok.map((p, i) => {
    const place = SCENE_LABEL[p.scene] || '';
    return {
      id: p.id,
      src: srcOf(p),
      time: fmtTime(p),
      place,
      note: `No.${String(i + 1).padStart(3, '0')} / ${String(ok.length).padStart(3, '0')}`,
      loc: place ? `📍 ${place}` : '',
    };
  });
}

/**
 * 路由参数解析：'groupId:coverPhotoId' → { gid, startId }
 *
 * 🔴 为什么塞进一个 param 而不加第三段路由：
 *    js/router.js 的 parseHash 是 `raw.split('/')` 只取 [page, param]，
 *    第三段会被**静默丢弃**。改 router 属于全局改动、风险不值当；
 *    所以两个入参编码进同一个 param，viewer 内部拆。
 * 🔴 为什么 startId 用**照片 id** 而不是序号：
 *    废片过滤后列表会变短，调用方（pageAlbum）算出的序号在 viewer 里会错位；
 *    用 id 则无论过滤与否都能准确定位到那张封面照片。
 * 🔴 用 lastIndexOf(':')：id 本身可能含冒号，只有最后一个才是分隔符。
 */
function parseParam(param) {
  const s = String(param || '');
  if (!s) return { gid: '', startId: '' };
  const i = s.lastIndexOf(':');
  if (i < 0) return { gid: s, startId: '' };
  return { gid: s.slice(0, i), startId: s.slice(i + 1) };
}

function resolvePhotos(state, param) {
  const st = state || {};
  // 1) 指定分组（从分组卡进大图走这条）
  if (param && st.groups && st.groups.length) {
    const g = st.groups.find((x) => x.id === param);
    if (g) {
      const vs = fromPhotos(
        (g.photoIds || []).map((id) => (st.photos || []).find((p) => p.id === id)).filter(Boolean)
      );
      if (vs.length) return vs;
    }
  }
  // 2) 全部可用照片
  if (st.photos && st.photos.length) {
    const vs = fromPhotos(st.photos);
    if (vs.length) return vs;
  }
  // 3) 回退演示图（评审 / 尚无照片）
  return DEMO;
}

/* ---------------- 渲染 ---------------- */

export function pageViewer({ state, param } = {}) {
  const { gid, startId } = parseParam(param);
  vPhotos = resolvePhotos(state, gid);
  vIndex = 0;
  // 点封面进大图 → 定位到那张封面照片；找不到（被过滤/无封面）则回到第 1 张
  if (startId) {
    const i = vPhotos.findIndex((v) => v.id === startId);
    if (i >= 0) vIndex = i;
  }
  const photos = vPhotos;
  // 🔴 首屏必须按 vIndex 渲染，不能写死第 0 张：
  //    「点封面直接跳到封面那张」靠的就是这里，写死 0 会让 startId 只改内部状态、
  //    不改 DOM —— 表现为 hash 带着 g1:p3 但画面还是第 1 张（本轮真跑抓到的 bug）。
  const first = photos[vIndex] || photos[0] || DEMO[0];

  const thumbs = photos
    .map(
      (p, i) =>
        `<button class="athumb${i === vIndex ? ' athumb--on' : ''}" data-act="albumSelect" data-i="${i}" ` +
        `style="background-image:url('${p.src}')" aria-label="第 ${i + 1} 张"></button>`
    )
    .join('');

  const pager = photos
    .map(
      (_, i) =>
        `<button class="album-pager__dot${i === vIndex ? ' album-pager__dot--on' : ''}" data-act="albumSelect" data-i="${i}" aria-label="第 ${i + 1} 张"></button>`
    )
    .join('');

  return `
  <section class="album-viewer" aria-label="相册查看器">
    <div class="album-bar">
      <button class="album-x" data-act="albumClose" aria-label="返回">‹ 返回</button>
      <span class="album-bar__t">相册预览</span>
      <button class="album-deco-btn" data-act="albumDeco" aria-pressed="true">装饰 ✦</button>
    </div>

    <div class="album-stage">
      <div class="album-photo" style="background-image:url('${first.src}')"></div>

      <!-- 装饰层：默认隐藏，按主题 + 装饰开关显隐 -->
      <div class="album-layer album-vignette"></div>
      <div class="album-layer album-glow"></div>
      <div class="album-layer album-perforations album-perforations--top"></div>
      <div class="album-layer album-perforations album-perforations--bottom"></div>
      <div class="album-layer album-paperframe"></div>
      <div class="album-layer album-cloudborder"></div>
      <div class="album-layer album-plant" style="background-image:url('${LEAF_URI}')"></div>
      <div class="album-layer album-stars" style="background-image:url('${STAR_URI}'),url('${STAR_URI}'),url('${STAR_URI}')"></div>
      <div class="album-texture"></div>

      <span class="album-tag album-tag--note" data-role="note">${first.note || ''}</span>
      <span class="album-tag album-tag--loc" data-role="loc">${first.loc || ''}</span>

      <button class="album-nav album-prev" data-act="albumPrev" aria-label="上一张">‹</button>
      <button class="album-nav album-next" data-act="albumNext" aria-label="下一张">›</button>
    </div>

    <div class="album-caption">
      <span class="album-caption__time" data-role="time">${first.time || ''}</span>
      <span class="album-caption__place" data-role="place">${first.place || ''}</span>
    </div>

    <div class="album-thumbs" data-role="thumbs">${thumbs}</div>
    <div class="album-pager">${pager}</div>
  </section>`;
}

/* ---------------- 交互（自带 mount，不依赖 app 重渲染） ---------------- */

function paint(root) {
  if (!root) return;
  const p = vPhotos[vIndex];
  if (!p) return;
  const photo = root.querySelector('.album-photo');
  if (photo) photo.style.backgroundImage = `url("${p.src}")`;
  const set = (role, val) => {
    const el = root.querySelector(`[data-role="${role}"]`);
    if (el) el.textContent = val || '';
  };
  set('time', p.time);
  set('place', p.place);
  set('note', p.note);
  set('loc', p.loc);
  root.querySelectorAll('.athumb').forEach((b, i) => b.classList.toggle('athumb--on', i === vIndex));
  root
    .querySelectorAll('.album-pager__dot')
    .forEach((b, i) => b.classList.toggle('album-pager__dot--on', i === vIndex));
}

function toggleDeco() {
  const off = document.body.classList.toggle('album-deco-off');
  document
    .querySelectorAll('[data-act="albumDeco"]')
    .forEach((b) => b.setAttribute('aria-pressed', String(!off)));
  return !off;
}

export function mountViewer(root) {
  if (!root) return;
  const stage = root.querySelector('.album-stage');

  const go = (dir) => {
    vIndex = clamp(vIndex + (dir || 0));
    paint(root);
  };
  const select = (i) => {
    vIndex = clamp(i | 0);
    paint(root);
  };

  // 点击：导航/选图/关装饰 全在组件内自洽（预览页也能独立工作）
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    if (a === 'albumPrev') go(-1);
    else if (a === 'albumNext') go(1);
    else if (a === 'albumSelect') select(Number(el.dataset.i || 0));
    else if (a === 'albumClose') router.go('album');
    else if (a === 'albumDeco') toggleDeco();
  });

  // 左右滑动切换（移动端优先）
  let x0 = null;
  let t0 = null;
  if (stage) {
    stage.addEventListener('pointerdown', (e) => {
      x0 = e.clientX;
      t0 = Date.now();
    });
    stage.addEventListener('pointerup', (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0;
      const dt = Date.now() - t0;
      if (Math.abs(dx) > 40 && dt < 700) go(dx < 0 ? 1 : -1);
      x0 = null;
    });
  }

  // 键盘左右（仅真实 App 内的查看器生效；预览页无 #view，不抢键）
  const onKey = (e) => {
    if (document.querySelector('#view .album-viewer') !== root) return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);
}

/** 供外部（如预览页）按需开关装饰 */
export function setDeco(on) {
  document.body.classList.toggle('album-deco-off', !on);
  document.querySelectorAll('[data-act="albumDeco"]').forEach((b) => b.setAttribute('aria-pressed', String(Boolean(on))));
}
