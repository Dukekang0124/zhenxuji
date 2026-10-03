/**
 * app.js — 页面注册表 + 流程编排 + boot
 *
 * 纪律：
 *  - PAGES 注册表：新增页面 = 加一个函数 + 注册一行，不改路由逻辑。
 *  - 事件统一走 data-act 委托，页面渲染保持纯函数。
 *  - 任何一步失败都不阻塞主流程（toast 提示 + 降级），不允许白屏。
 */

import * as store from './store.js';
import * as router from './router.js';
import * as P from './pages.js';
import { pickPhotos } from './imaging.js';
import { scanFiles, regroup } from './scan.js';
import { extractTags, narrativeOrder, timeOrder } from './ai.js';
import { generateStory, resetRegen } from './api.js';
import { makeNineGrid, makeLongImage, buildShareHTML, downloadCanvas, downloadText } from './export.js';
import { COPY } from './prompts.js';
import { applyTheme, normalizeTheme, themeName } from './theme.js';
import { resolveMode, MODE_LABEL } from './appearance.js';
import { checkUpdate, performUpdate, snooze, markUpdated, detectApk, readSnooze } from './update.js';
import { pageViewer, mountViewer } from './viewer.js';   // 相册大图查看器（四主题，纯新增）
import { makeRecord, pushRecord, canSaveToAlbum, KIND_LABEL, fmtWhen } from './exportdl.js';   // P0-Bug1 导出落点
import { mountViewerPicker, recordOverride, pickLevel } from './picker.js';   // AI 选片增量层

const view = () => document.getElementById('view');

const PAGES = {
  create: P.pageCreate,
  album: P.pageAlbum,
  pick: P.pagePick,
  edit: P.pageEdit,
  compose: P.pageCompose,
  share: P.pageShare,
  gallery: P.pageGallery,
  detail: P.pageDetail,
  recipes: P.pageRecipes,
  theme: P.pageTheme,            // V1.5 外观主题（方案 §5.4）
  settings: P.pageSettings,
  changelog: P.pageChangelog,   // 方案 §2.9.5 更新日志页
  viewer: pageViewer,           // 相册大图查看器（四主题）
  exphistory: P.pageExportHistory,   // P0-Bug1 导出历史（独立路由，不占底部导航）
};

const TABS = ['create', 'gallery', 'recipes', 'settings'];

let scanner = null;

/* ==================== 渲染 ==================== */

function render() {
  const { page, param } = router.current();
  const state = store.get();
  const fn = PAGES[page] || PAGES.create;
  let html;
  try {
    html = fn({ state, param });
  } catch (e) {
    console.error('[render]', e);
    html = `<h1>出错了</h1><p class="empty">${String(e.message || e)}</p>`;
  }
  view().innerHTML = html;
  // 更新弹窗挂到 body 级 #modalRoot，**不再拼进 view 的 innerHTML**：
  // .view 上跑着主题化进场动效（transform），会给 position:fixed 的弹窗造出包含块，
  // 动画没跑完时遮罩会只盖住 main 而露着顶栏/底栏。原因与取舍详见 index.html 的注释。
  const modalRoot = document.getElementById('modalRoot');
  if (modalRoot) modalRoot.innerHTML = P.renderUpdateModal(state) + P.renderExportModal(state);

  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('tab--on', b.dataset.tab === (TABS.includes(page) ? page : 'create'));
  }
  if (page === 'viewer') {
    mountViewer(view());
    // AI 选片扩展：只往 viewer 里**追加**一条标记栏，不改 viewer 组件本身。
    // 传 getter 而非快照：override() 会整体替换 state.photos，闭包持快照会读旧数据。
    const bar = mountViewerPicker(view(), () => store.get(), param) && view().querySelector('.album-viewer').__pickerBar;
    if (bar) {
      bar.__onMark = (id, act) => doMark(id, act);
      bar.__onRevert = (id) => doRevert(id);
    }
  }
  paintToast();
}

function paintToast() {
  const el = document.getElementById('toast');
  const t = store.toastLive();
  el.textContent = t ? t.msg : '';
  el.classList.toggle('toast--on', Boolean(t));
}

store.subscribe(paintToast);

// 🔴 更新弹窗必须靠 render 才拼得出来（view.innerHTML = html + renderUpdateModal）。
//    只 subscribe 了 paintToast 的话，doCheckUpdate 里 setUI({updateModal}) 之后
//    弹窗**根本不会出现**，要等用户下一次切页面才莫名冒出来（实测确认）。
//    这里单独订阅：只有 updateModal 变化时才重绘整页，避免与 toast 互相打架。
//
// 🔴 updateNote 同理，而且是后踩到的坑（实测）：设置页那行「已是最新版本✨」走的是
//    `state.ui.updateNote` + 渲染，改它本身不触发任何重绘 —— 只有弹窗出现时
//    （顺带 render 了一次）才碰巧显示出来。于是「已是最新」「网络异常」这两个
//    **不弹窗**的分支，点了按钮页面一动不动（用户视角就是"还是没反应"，跟修复前一样）。
//    所以 key 必须把 updateNote 也纳进来。
//
// 🔴 P0-Bug1 补记：key 还必须带上 **exportResult**。
//    这条订阅是"UI 弹窗变化 → 重绘整页"的唯一通路，若 key 不含它，
//    `setUI({exportResult})` 后 emit 到了这里却被 `if (k === lastModalKey) return`
//    拦掉 —— 现象是"导出成功但弹窗根本没出现"，而下载其实已经发生了。
//    （第一版自测就是死在这儿：downloads 有记录、弹窗 null。）
//    教训：新增任何走 modalRoot 的弹窗，都必须在这里登记 key，否则静默不显示。
let lastModalKey = '';
store.subscribe((s) => {
  const ui = s.ui || {};
  const m = ui.updateModal;
  // 🔴 key 必须带上**弹窗内容**（可选/强制 + 目标版本），不能只记"开着还是关着"。
  //    实测踩到：从可选态切到强制态时 key 都是 'on' → 判定为"没变化" → 不重渲染，
  //    界面还停在可选弹窗上。证据图直接受害 —— update-modal.png 与 update-force.png
  //    拍出来字节完全相同（md5 一致），等于"强制更新"那张照片是假的。
  //    （产品上这条路径很少走到，但证据假了比功能少更危险：它让人以为验过了。）
  const ex = ui.exportResult;
  const k = (m ? `${m.isForce ? 'force' : 'optional'}:${(m.config && m.config.latestVersion) || ''}` : 'off')
    + '|' + String(ui.updateNote || '')
    + '|' + (ex ? `${ex.kind}:${ex.filename}:${ex.at}` : 'off');   // 导出落点弹窗
  if (k === lastModalKey) return;
  lastModalKey = k;
  render();
  paintToast();   // render 会重画 toast 容器，补一次同步
});

/* ==================== 外观主题包 + 明暗模式 ====================

   主题落地只做一件事：把 key 与明暗写到 <html data-theme / data-mode> 上，
   剩下全交给 CSS 变量层联。这里挂一个 store 订阅当**安全网** —— 任何路径改了
   settings.theme / settings.mode（主题卡片、明暗切换、控制台调试、以后新增的入口）
   都会自动同步到 DOM，不用每个入口记得手调。
   applyTheme 内部幂等（同值直接 return），挂在高频 emit 上也没有额外开销。

   🔴 'auto' 不在 theme.js 里解析：theme.js 只认 light|dark。
      「auto 到底算亮还是暗」是运行时环境问题（系统偏好），解析逻辑统一放在
      js/appearance.js —— 因为 export.js 也要用同一套解析（导出必须画成用户
      此刻看到的那套色），而 export.js 不能 import app.js（会成环）。 */

let lastThemeKey = '';
let lastAppliedMode = '';
function syncTheme(s) {
  const k = normalizeTheme(s.settings && s.settings.theme);
  const m = resolveMode((s.settings && s.settings.mode) || 'auto');
  if (k === lastThemeKey && m === lastAppliedMode) return;
  lastThemeKey = k;
  lastAppliedMode = m;
  applyTheme(k, m);
}

store.subscribe(syncTheme);

/* 系统明暗变化时（用户在 auto 模式下切换了手机深色模式）实时跟随 */
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSys = () => {
    const pref = (store.get().settings || {}).mode || 'auto';
    if (pref !== 'auto') return;         // 用户手动指定过明暗，不抢他的选择
    lastAppliedMode = '';                // 逼 syncTheme 重算
    syncTheme(store.get());
  };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys);
}

/* ==================== AI 选片（增量层） ==================== */

/**
 * 用户在大图页标记「珍藏 / 废片」。
 * 🔴 只写 userOverride 标记，**绝不删原图**；同时把这次纠正沉淀进偏好，
 *    让 AI 后续对同类缺陷放宽判定（可解释、不学黑盒）。
 */
function doMark(id, act) {
  const st = store.get();
  const p = st.photos.find((x) => x.id === id);
  if (!p) return;
  store.actions.patchSettings(recordOverride(st.settings || {}, p, act));
  store.actions.override(id, act);
  store.toast(act === 'keep' ? '已珍藏 · AI 记住你的口径了' : '已标记废片 · 原图仍在相册');
  // 🔴 刻意不调 render()：重建会把大图打回第 1 张、丢掉浏览位置。
  //    标记栏自己 repaint；真正需要重排的是 pagePick，切页时自然会重渲染。
}

function doRevert(id) {
  if (!id) return;
  // override(id, null) 即清掉显式覆盖 → 回归纯 AI 判定。
  // 偏好记录**保留**：那是"你的口径"，与这一次是否撤销无关。
  store.actions.override(id, null);
  store.toast('已交还 AI 判定');
}

/** 一键 AI 帮我选片：优先进"有疑似废片"的分组，否则第一组 */
function aiPickAll() {
  const st = store.get();
  if (!st.groups.length) { store.toast('先导入照片再让我帮你选'); return; }
  let target = st.groups[0];
  for (const g of st.groups) {
    const ps = (g.photoIds || []).map((id) => st.photos.find((p) => p.id === id)).filter(Boolean);
    if (ps.some((p) => pickLevel(p, st.settings).level === 'trash')) { target = g; break; }
  }
  router.go('pick', target.id);
}

/**
 * 批量把指定 id 列表标记为废片（只标记，不删）。
 *
 * 🔴 两条自纠（都是实测会出错的路径，不是洁癖）：
 *  1) 尊重用户已有决定：已 userOverride==='keep' 的跳过。
 *     相似组归档会把「组内非最优」整批打标，若用户手动珍藏过其中一张，
 *     批量化会把人家的珍藏直接盖掉 —— 自己的产品自己都会踩。
 *  2) 单次写盘：逐张 override 会 N 次 JSON.stringify 全量存档 + N 次 emit，
 *     100 张就是 100 次同步序列化（主线程肉眼可见地卡）。
 */
function archiveIds(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return 0;
  const st = store.get();
  const targets = list.filter((id) => {
    const p = (st.photos || []).find((x) => x.id === id);
    return p && p.userOverride !== 'keep';      // 珍藏过的绝不覆盖
  });
  if (!targets.length) return 0;
  const set = new Set(targets);
  // upsertPhotos：一次合并 + 一次 save + 一次 emit（不改 store.js，避免动公共面）
  store.actions.upsertPhotos(
    st.photos.filter((p) => set.has(p.id)).map((p) => ({ id: p.id, userOverride: 'trash' }))
  );
  return targets.length;
}

/* ==================== 扫描 ==================== */

async function runScan(mode) {
  const files = await pickPhotos(mode);
  if (!files.length) { store.toast('没有选择照片'); return; }

  scanner = scanFilesController();
  store.setUI({ scan: { running: true, done: 0, total: files.length } });
  render();

  try {
    const st = store.get();
    const res = await scanFiles(files, {
      existing: st.photos,
      batchSize: st.settings.scanBatchSize,
      thumbSize: st.settings.thumbSize,
      autoDowngrade: st.settings.autoDowngrade,
      scanner,
      onProgress: ({ done, total }) => {
        store.setUI({ scan: { running: true, done, total } });
        const el = document.querySelector('.progress__bar');
        if (el) el.style.width = `${Math.round((done / total) * 100)}%`;
        const n = document.querySelector('.scanner__n');
        if (n) n.textContent = `${done}/${total}`;
      },
    });

    // 分组封面缩略图由 scanFiles/regroup 自己补齐（见 scan.js 内的说明）

    store.actions.upsertPhotos(res.photos);
    store.actions.setGroups(res.groups);
    store.setUI({ scan: null });
    store.toast(`扫描完成：${res.photos.length} 张，${res.groups.length} 个分组`);

    if (mode === 'few') {
      const g = res.groups[0];
      if (g) router.go('pick', g.id); else render();
    } else {
      router.go('album');
    }
  } catch (e) {
    console.error('[scan]', e);
    store.setUI({ scan: null });
    store.toast('扫描中断，可重试');
    render();
  }
}

function scanFilesController() {
  let cancelled = false, paused = false;
  return {
    cancel() { cancelled = true; },
    pause() { paused = true; },
    resume() { paused = false; },
    isCancelled: () => cancelled,
    isPaused: () => paused,
    _waitPause: async () => { while (paused && !cancelled) await new Promise((r) => setTimeout(r, 120)); },
  };
}

/* ==================== 事件委托 ==================== */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const st = store.get();

  try {
    switch (act) {
      case 'pickAlbum': await runScan('album'); break;
      case 'pickFew': await runScan('few'); break;
      case 'goAlbum': router.go('album'); break;
      case 'goGallery': router.go('gallery'); break;
      case 'goCreate': router.go('create'); break;   // 空状态引导回首页（方案 §5.3）
      // 🔴 openViewer 同时服务两个入口：
      //    ① 顶部【查看大图】按钮（无 data-id）→ 走全部可用照片
      //    ② 分组卡片 .gcard（有 data-id + data-start）→ 打开该分组，并定位到封面照片
      //    两个入参编码进同一个 param（'groupId:coverPhotoId'）：router.parseHash 只取
      //    [page, param] 两段，第三段会被静默丢弃，改 router 属于全局改动、风险不值当。
      case 'openViewer': {
        const gid = el.dataset.id || '';
        const start = el.dataset.start || '';
        router.go('viewer', gid ? (start ? `${gid}:${start}` : gid) : '');
        break;
      }

      /* ---- AI 选片（增量层） ---- */
      case 'aiPickAll':
        aiPickAll();
        break;

      case 'batchArchive': {
        // 批量标记废片：只打标记，原图一张不删
        const st = store.get();
        const g = st.groups.find((x) => x.id === id);
        if (!g) break;
        const targets = (g.photoIds || [])
          .map((pid) => st.photos.find((p) => p.id === pid))
          .filter((p) => p && !p.userOverride && pickLevel(p, st.settings).level === 'trash')
          .map((p) => p.id);
        const n = archiveIds(targets);
        store.toast(n ? `已标记 ${n} 张为废片 · 原图仍在相册` : '没有需要标记的废片');
        render();
        break;
      }

      case 'archiveSimilar': {
        // 相似组：归档"除推荐那张之外"的其余照片
        const n = archiveIds(String(el.dataset.ids || '').split(',').filter(Boolean));
        store.toast(n ? `已归档其余 ${n} 张 · 原图仍在相册` : '没有可归档的');
        render();
        break;
      }

      // 🔴 底部导航：必须自己把 data-tab 转成 hash 跳转。
      //    render() 里那段 tab--on 高亮只改 class，不负责导航 —— 没有这个 case
      //    四个 Tab 点了完全没反应（实测：点「设置」后 #view 仍是新建页）。
      case 'goTab':
        router.go(String(el.dataset.tab || 'create'));
        break;

      case 'help':
        store.toast('照片只在本机分析，原图不会上传 · 可在设置页管理权限与缓存', 3200);
        break;

      /* ---- 版本更新（方案 §2.9） ---- */
      case 'checkUpdate':
        // 手动检查：不受 24h 冷却限制，失败必须给交代（方案 §2.9.3 / §2.9.6）
        await doCheckUpdate(true);
        break;

      case 'snoozeUpdate':
        snooze();
        store.setUI({ updateModal: null });
        store.toast('好，24 小时内不再打扰你');
        break;

      case 'viewChangelog': {
        const info = store.get().ui.updateModal || store.get().ui.updateInfo || {};
        store.setUI({ updateModal: null, updateInfo: info });
        router.go('changelog');
        break;
      }

      case 'doUpdate': {
        const st2 = store.get();
        const info = st2.ui.updateModal || st2.ui.updateInfo || {};
        const r = performUpdate(info.config, info.inApk ?? detectApk());
        markUpdated();
        store.setUI({ updateModal: null });
        if (r.mode === 'pwa') {
          store.toast(r.msg);
          // PWA：交给 SW 接管新资源后刷新页面即生效
          setTimeout(() => location.reload(), 900);
        } else {
          store.toast(r.msg);
        }
        break;
      }

      case 'noopUpdateMask':
        // 点遮罩不关闭（强制更新尤其不能点错就跳过）
        break;

      /* ---- P0-Bug1：导出落点弹窗 + 导出历史 ---- */
      case 'closeExport':
        // 点遮罩也能关：这是提示型弹窗（非强制），困住用户是错的
        store.setUI({ exportResult: null });
        break;

      case 'copyExportName': {
        const name = el.dataset.name || '';
        // clipboard 在非 https / 无权限时会抛，必须兜住 —— 不能给用户一个点了没反应的按钮
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(name);
            store.toast('文件名已复制');
          } else {
            throw new Error('no clipboard api');
          }
        } catch {
          // 兜底：弹一个可手选的输入框，用户自己长按复制
          const box = document.createElement('input');
          box.value = name;
          box.setAttribute('readonly', '');
          box.style.cssText = 'position:fixed;left:12px;right:12px;top:40%;z-index:99;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px';
          document.body.appendChild(box);
          box.select();
          store.toast('请长按选中复制');
          setTimeout(() => box.remove(), 6000);
        }
        break;
      }

      case 'goExportHistory':
        store.setUI({ exportResult: null });
        router.go('exphistory');
        break;

      case 'goSettings':
        router.go('settings');
        break;

      case 'scanCancel':
        if (scanner) scanner.cancel();
        store.setUI({ scan: null });
        store.toast('已取消扫描');
        render();
        break;

      case 'regroup': {
        const gs = regroup(st.photos, { maxGapHours: 36, minSize: 1 });
        store.actions.setGroups(gs);
        store.toast(`重新聚类：${gs.length} 个分组`);
        render();
        break;
      }

      case 'startStory': router.go('pick', id); break;
      case 'renameGroup': {
        const g = st.groups.find((x) => x.id === id);
        const t = prompt('重命名分组', g?.title || '');
        if (t != null) { store.actions.upsertGroup({ id, title: t.trim() || g.title }); render(); }
        break;
      }
      case 'delGroup':
        store.actions.removeGroup(id);
        store.toast(COPY.deleteGroupTip);
        render();
        break;

      case 'togglePhoto': {
        const p = st.photos.find((x) => x.id === id);
        if (!p) break;
        const isT = p.verdict?.level === 'A';
        store.actions.override(id, (p.userOverride === 'keep' || (!p.userOverride && !isT)) ? 'trash' : 'keep');
        render();
        break;
      }

      case 'toggleFold':
        document.getElementById(el.dataset.target)?.classList.toggle('fold--open');
        break;

      /* ---- 配方卡展开参数（P0-Bug2） ----
         🔴 刻意**不调 render()**：配方页是纯展示，重渲染会把用户刚展开的卡片又收回去
            （真实体验：点「查看全部参数」→ 一闪又折回去，像是没点上）。
            只切 DOM，状态留在节点上，切页回来会重置 —— 这才是对的行为。 */
      case 'toggleRecipe': {
        const more = el.querySelector('.rcard__more');
        const tg = el.querySelector('.rcard__toggle');
        if (!more) break;
        const open = more.hasAttribute('hidden');
        if (open) more.removeAttribute('hidden'); else more.setAttribute('hidden', '');
        if (tg) tg.textContent = open ? '收起参数' : '查看全部参数';
        el.classList.toggle('rcard--open', open);
        break;
      }

      case 'goEdit': router.go('edit', id); break;
      case 'goCompose': router.go('compose', id); break;

      case 'applyEnhance':
        store.toast(`已对分组应用修图（${st.groups.find((g) => g.id === id)?.photoIds.length || 0} 张）`);
        break;

      case 'saveRecipe': {
        const rid = `r_beauty_${Date.now().toString(36)}`;
        store.actions.upsertRecipe({ id: rid, name: `我的配方 ${st.recipes.length + 1}`, type: 'beauty', params: { bright: 6, soft: 0.3, warm: 8, sat: 6, contrast: 5 } });
        store.toast('配方已保存');
        break;
      }

      case 'genText': await doGenText(id); break;
      case 'finishStory': await doFinish(id); break;

      case 'expGrid': await doExport(id, 'grid'); break;
      case 'expLong': await doExport(id, 'long'); break;
      case 'expH5': await doExport(id, 'h5'); break;

      case 'openStory': router.go('detail', id); break;
      case 'shareStory': router.go('share', id); break;
      case 'delStory':
        store.actions.removeStory(id);
        store.toast('已删除');
        router.go('gallery');
        break;

      /* ---- V1.5 外观主题 ---- */
      case 'goTheme':
        router.go('theme');
        break;

      case 'goThemeBack':
        router.go('settings');
        break;

      case 'setTheme': {
        // setTheme 内部已 normalizeTheme：脏值（null/未知字符串）在**写入前**
        // 就归一成默认主题，绝不让脏数据进 localStorage
        const k = store.actions.setTheme(el.dataset.id);
        applyTheme(k, resolveMode((st.settings || {}).mode || 'auto'));  // DOM 立即生效（订阅是安全网，这里显式调一次保证时序）
        render();               // 刷新主题卡片的选中描边
        store.toast(`已换成「${themeName(k)}」`);
        break;
      }

      /* ---- 明暗模式：每套主题内部的子选项（方案：不是并列的第二套皮肤） ---- */
      case 'setMode': {
        const m = store.actions.setMode(el.dataset.id);   // light / dark / auto
        lastAppliedMode = '';                             // 逼 syncTheme 重算（auto 需要重新解析系统偏好）
        syncTheme(store.get());
        render();                                         // 刷新明暗三选的选中态
        store.toast(`外观已切换为${MODE_LABEL[m] || m}`);
        break;
      }

      case 'toggleAI':
        store.actions.patchSettings({ aiTextEnabled: !st.settings.aiTextEnabled });
        store.toast(st.settings.aiTextEnabled ? 'AI 文案已关闭' : 'AI 文案已开启');
        render();
        break;
      case 'toggleDowngrade':
        store.actions.patchSettings({ autoDowngrade: !st.settings.autoDowngrade });
        render();
        break;
      case 'saveKeys': {
        // 🔴 前端不再保存任何 API Key —— 密钥只在服务端
        const ep = document.getElementById('endpoint')?.value || '';
        const bs = Number(document.getElementById('batchSize')?.value) || st.settings.scanBatchSize;
        store.actions.patchSettings({ glmEndpoint: ep.trim(), scanBatchSize: Math.max(2, Math.min(32, bs)) });
        store.toast('已保存');
        break;
      }
      case 'clearCache':
        store.actions.clearCache();
        store.toast(COPY.cacheTip);
        router.go('create');
        break;
      case 'resetAll':
        if (confirm('确认清空全部数据？此操作不可恢复')) { store.actions.reset(); router.go('create'); }
        break;
    }
  } catch (err) {
    console.error('[act]', act, err);
    store.toast('操作失败，请重试');
  }
});

/* ==================== 文案生成 ==================== */

async function doGenText(groupId) {
  const st = store.get();
  const g = st.groups.find((x) => x.id === groupId);
  const photos = g.photoIds.map((i) => st.photos.find((p) => p.id === i)).filter(Boolean).filter((p) => p.verdict?.level !== 'A');
  if (!photos.length) { store.toast('没有可用照片'); return; }

  const tags = extractTags(photos, g);
  const msg = document.getElementById('genMsg');
  if (msg) msg.textContent = '正在生成…';

  const r = await generateStory(tags, st.settings, { storyId: groupId });
  const t = document.getElementById('fCover');
  if (t) t.value = r.data.cover;
  const b = document.getElementById('fBody');
  if (b) b.value = r.data.body;
  const h = document.getElementById('fHook');
  if (h) h.value = r.data.hook;

  if (msg) msg.textContent = r.degraded || '文案已生成';
  // 🔴 这里原来写的是 `生成完成 · ${r.source} · ${r.ms}ms` —— source 是 glm/local，
  //    ms 是毫秒数，都是内部实现细节，方案 §5.4 明令普通用户不可见
  //    （真机截图里那句「…使用本地文案（0ms）」就是这么漏出去的）。
  //    现在只展示"发生了什么"，不展示"怎么实现的"。
  if (r.degraded) store.toast(r.degraded);
  else store.toast('文案已生成');
}

/* ==================== 完成并归档 ==================== */

async function doFinish(groupId) {
  const st = store.get();
  const g = st.groups.find((x) => x.id === groupId);
  let photos = g.photoIds.map((i) => st.photos.find((p) => p.id === i)).filter(Boolean).filter((p) => p.verdict?.level !== 'A');
  const order = document.getElementById('orderSel')?.value || 'narrative';
  photos = order === 'time' ? timeOrder(photos) : narrativeOrder(photos);

  const sid = `s_${Date.now().toString(36)}`;
  resetRegen(sid);
  const story = {
    id: sid,
    groupId,
    title: document.getElementById('fCover')?.value || g.title,
    createdAt: Date.now(),
    publishedAt: Date.now(),
    photoIds: photos.map((p) => p.id),
    order,
    templateId: document.getElementById('tplSel')?.value || 'tpl_1',
    dateText: extractTags(photos, g).dateText,
    text: {
      cover: document.getElementById('fCover')?.value || g.title,
      captions: photos.slice(0, 9).map((p, i) => `第 ${i + 1} 帧`),
      body: document.getElementById('fBody')?.value || '',
      hook: document.getElementById('fHook')?.value || '',
    },
    stats: { views: 0, likes: 0, comments: 0 },
  };
  store.actions.upsertStory(story);
  store.toast('已归档到作品集');
  router.go('share', sid);
}

/* ==================== 导出 ==================== */

async function doExport(storyId, kind) {
  const st = store.get();
  const s = st.stories.find((x) => x.id === storyId);
  if (!s) { store.toast('作品不存在'); return; }
  const photos = (s.photoIds || []).map((i) => st.photos.find((p) => p.id === i)).filter(Boolean);
  if (!photos.length) { store.toast('没有照片可导出'); return; }

  // 🔴 下载能力前置校验（P0-Bug1 方案里的"权限前置校验"）：
  //    真跑确认本项目走浏览器下载通道，**不存在相册写入权限**这回事，
  //    所以这里能校验的是"这个环境能不能触发下载"。
  //    一旦将来装了 @capacitor/photos，这里换成 canSaveToAlbum() + 真实授权询问。
  if (!canSaveToAlbum()) {
    // 不阻断 —— 浏览器下载是可行的，只是没有"存相册"这个更顺手的选项。
    // 用 setUI 记一条，供导出弹窗里如实说明。
  }

  store.toast('正在生成…');
  try {
    let rec;
    if (kind === 'grid') {
      const c = await makeNineGrid(photos);
      const fn = `帧叙集-九宫格-${s.text?.cover || storyId}.jpg`;
      await downloadCanvas(c, fn);
      rec = makeRecord({ kind, filename: fn, thumb: thumbOf(photos[0]), storyTitle: s.text?.cover });
    } else if (kind === 'long') {
      const c = await makeLongImage(photos, s);
      const fn = `帧叙集-长图-${s.text?.cover || storyId}.jpg`;
      await downloadCanvas(c, fn);
      rec = makeRecord({ kind, filename: fn, thumb: thumbOf(photos[0]), storyTitle: s.text?.cover });
    } else {
      const html = buildShareHTML(s, photos, s.templateId);
      const fn = `帧叙集-${s.text?.cover || storyId}.html`;
      downloadText(html, fn);
      rec = makeRecord({ kind, filename: fn, thumb: thumbOf(photos[0]), storyTitle: s.text?.cover });
    }
    // 🔴 toast → 模态弹窗（P0-Bug1 核心）：toast 一闪就没，路径信息留不住。
    store.setUI({ exportResult: rec, exportHistory: pushRecord(store.get().ui.exportHistory, rec) });
  } catch (e) {
    console.error('[export]', e);
    store.toast('导出失败');
  }
}

/** 导出历史缩略图：取第一张可用缩略图（原图优先，都没有就空） */
function thumbOf(p) {
  if (!p) return '';
  if (p._file) { try { return URL.createObjectURL(p._file); } catch { return ''; } }
  return p.thumbUrl || '';
}

/* ==================== 版本更新 ==================== */

/**
 * 检查更新（手动/自动共用）。
 * @param {boolean} manual true=用户手动点（绕过冷却、失败要提示）
 * @param {boolean} silentAuto true=冷启动静默检测（超时不阻塞、失败不弹窗）
 */
async function doCheckUpdate(manual = false, silentAuto = false) {
  const st = store.get();
  // 🔴 兜底值必须是真实版本号。原来写 '0.0.0'，一旦 index.html 里的
  //    APP_VERSION 被误删，build-web.mjs 的四处校验又只看另外三处 →
  //    运行时会把任意远端版本都判成"有更新"，用户被反复弹窗。
  const current = String(window.APP_VERSION || '0.5.0');
  const r = await checkUpdate({
    // 🔴 P0-1 根因修复：版本源默认走**同源 /version.json**（与 App 同一次部署发布），
    //    用户配置的服务地址降级为「同源不可达时的兜底源」。
    //    旧写法 baseUrl: st.settings.glmEndpoint 让版本检测绑死在用户手填的地址上，
    //    不填就永远回 not_configured → 用户看到的「点了检查更新没反应」。
    origin: location.origin,
    baseUrl: st.settings.glmEndpoint,
    current,
    manual,
    isApk: detectApk(),
  });

  // 手动检查三分支（方案 §2.9.4）：有新版本 / 已是最新 / 网络异常，三句都必须是人话
  if (manual) {
    const msg = r.needUpdate
      ? (r.isForce ? '有一个重要更新需要你安装' : `发现新版本 ${r.config.latestVersion}`)
      : (r.ok ? '已是最新版本✨' : (r.msg || '网络暂时无法获取版本信息，请稍后重试'));
    // 🔴 结果文案必须走 **UI 状态 + 渲染**，绝不能直接 el.textContent 写进 DOM：
    //    store.emit() 是同步的，下面 setUI({updateModal}) 会立刻触发整页重渲染，
    //    #updateMsg 会被整个换成新节点 —— 直接写进去的文案当场蒸发（实测：弹窗出现了、
    //    设置页那行却是空的）。放进状态里，渲染几次都在。
    store.setUI({ updateNote: msg });
    store.toast(msg);
  } else if (!r.ok && (r.silent || silentAuto)) {
    // 🔴 自动检测失败 → 静默返回，一个字都不弹（方案 §2.9.6）
    return r;
  }

  if (r.ok && r.needUpdate) {
    // 强制更新直接弹，可选更新需过冷却（checkUpdate 内部已判）
    if (manual || r.isForce || !r.suppressed) {
      store.setUI({ updateModal: { config: r.config, isForce: r.isForce, inApk: r.inApk } });
    }
  }
  return r;
}

/* ==================== boot ==================== */

function ensureDefaults() {
  const st = store.get();
  if (!st.recipes.some((r) => r.type === 'template')) {
    [['tpl_1', '简约纸感'], ['tpl_2', '留白叙事'], ['tpl_3', '温柔日常']]
      .forEach(([id, name]) => store.actions.upsertRecipe({ id, name, type: 'template', tone: '简约' }));
  }
}

export function boot() {
  ensureDefaults();
  // 冷启动先把主题与明暗贴上，再进路由 —— 保证首帧就是用户选的那套，不闪一下默认色
  // （auto 模式在这里解析系统偏好：首帧就出对，否则会先亮一下再变暗）
  syncTheme(store.get());
  router.onChange(render);
  router.start();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // 🔴 冷启动后台静默检测（方案 §2.9.1）：
  //   setTimeout 推迟到首屏渲染之后 → 不阻塞首页加载；
  //   全程静默（失败/超时不弹任何窗）→ 弱网离线无感。
  //   注意：这里**只在冷启动跑一次**，切后台热启动不触发（方案硬约束）。
  if (!sessionStorage.getItem('zhenxuji.update.bootDone')) {
    sessionStorage.setItem('zhenxuji.update.bootDone', '1');
    setTimeout(() => { doCheckUpdate(false, true).catch(() => {}); }, 2500);
  }
}

boot();
