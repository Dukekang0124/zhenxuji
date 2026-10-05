/**
 * store.js — 单一状态源 + localStorage 持久化 + toast(TTL)
 *
 * 设计要点：
 * - 唯一状态容器，页面只读 state、只调 action，不直接改。
 * - 持久化白名单：只有需要跨重启保留的键进 localStorage。
 *   照片原图/缩略图 blob URL 永不持久化（内存态，离屏即释放，防 OOM）。
 * - toast 用 TTL（until 时间戳）+ 渲染侧兜底，避免被后续 toast 覆盖后
 *   旧定时器提前清掉新 toast。
 * - 主题字段 theme 只是一等公民 settings 里的一个字符串，不存在独立的
 *   「主题表」；DOM 侧的 data-theme 由 app.js 订阅后调 theme.js 的 applyTheme。
 */

import { normalizeTheme } from './theme.js';
// 明暗偏好的归一逻辑放在 appearance.js：app.js 与 export.js 也要用，
// 放 store 里会造成「store 定义、别处再抄一份」的漂移
import { normalizeModePref } from './appearance.js';

const LS_KEY = 'zhenxuji.state.v1';
const PERSIST_KEYS = ['photos', 'groups', 'stories', 'recipes', 'settings', 'scanCursor'];

const DEFAULT_SETTINGS = {
  aiTextEnabled: true,      // AI 文案开关（关闭后完全不触发 GLM）
  glmApiKey: '',            // 智谱 API Key（空则本地引擎兜底）
  glmEndpoint: '',          // 自建 Worker 代理地址（可选）
  scanBatchSize: 8,         // 单批扫描张数（性能降级时下调）
  thumbSize: 256,           // 缩略图边长。🔴 P0 画质专项：96 在手机上被拉伸就糊/出马赛克，
                            // 提到 256（仍远小于原图，不落盘原图；原图靠 _file 会话内持有）
  autoDowngrade: true,      // 低端设备自动降级
  theme: 'warmth',          // 主题包 key（9 套：scene 场景组 4 + classic 经典组 5，温润本色为默认）
  mode: 'auto',             // 明暗模式（light / dark / auto）—— auto 跟随系统，见 js/app.js
};

/**
 * 🔴 必须用**工厂函数**生成初始状态，不能用 `const initial = { photos: [], ... }`。
 *
 * 为什么（实测踩出来的坑）：`let state = { ...initial }` 是**浅拷贝**，
 * state.photos / state.recipes / state.ui 三个数组/对象与 initial 里的**是同一个引用**。
 * 于是：
 *   upsertRecipe 命中已有 id 时执行 `state.recipes[i] = {...}` —— 这是**原地写**，
 *   initial.recipes 跟着一起变了；
 *   reset() 再执行 `{ ...initial }`，拿回来的不是空数组，而是被污染过的数组。
 *
 * 症状：点「清空全部数据」后刷新，配方又回来了 —— 用户以为没删干净，
 * 二次清空还是删不掉。开发期表现为「配方卡数量每轮测试都在变」，
 * 一度被误判成测试夹具脏，其实是生产代码的共享引用。
 *
 * 工厂函数每次都造全新的数组/对象，引用彻底隔离，reset 才是真的重置。
 */
function makeInitial() {
  return {
    photos: [],       // Photo[]（cv/verdict 持久化；thumbUrl 是 dataURL，**也持久化**——
                      //   ⚠️ 这句注释曾误写过"不持久化"，并据此清过一次 thumbUrl，导致重启后缩略图全空。
                      //   真正不持久化的只有 stripRuntime() 清单里的 _file / enhancedUrl）
    groups: [],       // EventGroup[]
    stories: [],      // Story[]
    recipes: [],      // Recipe[]
    settings: { ...DEFAULT_SETTINGS },
    scanCursor: null, // 增量扫描游标 { lastScanAt, count }

    // —— 运行态（不持久化）——
    // 🔴 exportHistory / exportResult 是导出落点功能（P0-Bug1）的运行态：
    //    历史里带 blobURL / dataURL 缩略图，**故意不落盘** —— 持久化会往 localStorage
    //    塞 base64 图片（配额一下就爆），且缩略图 blobURL 跨会话本来就失效。
    //    代价是「导出历史」重启后清空：如实如此，不假装它能长期留存。
    //    真要长期留（只存文件名/时间/类型，不存图），那是独立需求。
    ui: {
      route: '', busy: null, toast: null, scan: null,
      exportResult: null, exportHistory: [],
    },
  };
}

let state = makeInitial();
const subs = new Set();

/* ------------------------------ 持久化 ------------------------------ */

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of PERSIST_KEYS) {
      if (saved[k] != null) state[k] = saved[k];
    }
    // settings 缺字段补默认（版本升级兼容）
    state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    // 🔴 P0 图片画质专项 · 老用户迁移（否则修复等于只对新装生效）：
    //   上一行是「持久化值覆盖默认值」，老版本存下的 thumbSize:96 会把新的 256 顶掉，
    //   表现就是「新装的清晰、升级上来的还是糊」—— 修了却没修到人。
    //   缩略图边长是一条**质量下限**，不是用户偏好（UI 里没有这个开关，它只是内部性能旋钮），
    //   所以低于下限一律抬到下限，保证任何来源的存量配置都拿不到糊图。
    //   上限 512 只是配额护栏：thumbUrl 是 dataURL，会整体写进 localStorage。
    const THUMB_MIN = 256;
    const THUMB_MAX = 512;
    const ts0 = Number(state.settings.thumbSize);
    state.settings.thumbSize = Math.min(THUMB_MAX, Math.max(THUMB_MIN, Number.isFinite(ts0) && ts0 > 0 ? ts0 : THUMB_MIN));
    // 反序列化后只清不可序列化的运行态字段。
    // ⚠️ thumbUrl 是 dataURL（字符串，可持久化）—— 曾被误当 blob URL 清空，
    //    导致重启后缩略图全空。真正不能持久化的只有 _file（File 句柄）。
    state.photos = (state.photos || []).map((p) => stripRuntime({ ...p, _file: null }));
  } catch (e) {
    console.warn('[store] load failed, use defaults', e);
  }
}

/**
 * 🔴 清掉所有「不可跨会话存活」的运行态字段。
 *
 * 为什么要抽出成函数：save 与 load 两侧必须用**同一份清单**。
 * 之前只在 save 里手写剥离、load 里手写置 null，两处各写一遍 ——
 * 以后新增一个 blobURL 字段，漏掉哪一侧就是白占配额 / 重启后一堆坏图。
 * 「同一份真相」比「写两遍但一致」更可靠。
 *
 * 当前清单：
 *   _file        File 句柄，JSON 序列化不了
 *   enhancedUrl  调色结果的 blobURL（enhance.js 产出），跨会话必失效
 *
 * 代价（如实说明）：调色结果**重启后不保留**，重启即回原图。
 * 想要持久保留需把结果转成 dataURL 存 IndexedDB，那是独立需求（体量与配额都要算清）。
 */
function stripRuntime(p) {
  const { _file, enhancedUrl, ...rest } = p;
  return rest;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  // 节流：扫描期高频写入，300ms 合并一次
  saveTimer = setTimeout(() => {
    try {
      const out = {};
      for (const k of PERSIST_KEYS) {
        if (k === 'photos') {
          // 只剥离不可序列化的运行态字段（清单见 stripRuntime，save/load 共用）
          out.photos = state.photos.map(stripRuntime);
        } else {
          out[k] = state[k];
        }
      }
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch (e) {
      // 配额溢出：降级为只存核心键，绝不因存档失败崩掉主流程
      console.warn('[store] save failed', e);
      try {
        const lite = { settings: state.settings, stories: state.stories };
        localStorage.setItem(LS_KEY, JSON.stringify(lite));
      } catch (_) { /* 放弃持久化，内存态继续可用 */ }
    }
  }, 300);
}

/* ------------------------------ 订阅 ------------------------------ */

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

function emit() { for (const fn of subs) { try { fn(state); } catch (e) { console.warn(e); } } }

export function get() { return state; }

/** 更新状态：支持对象补丁或函数式更新；默认不落盘（高频场景），persist=true 才存 */
export function set(patch, opts = {}) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  if (opts.persist !== false) save();
  if (opts.silent !== true) emit();
  return state;
}

/** 更新 UI 运行态（不持久化、不触发存档） */
export function setUI(patch) {
  state.ui = { ...state.ui, ...patch };
  emit();
}

/* ------------------------------ toast ------------------------------ */

export function toast(msg, ms = 2200) {
  setUI({ toast: { msg, until: Date.now() + ms } });
  // TTL 兜底：到点若还是自己，则清掉；若已被新 toast 覆盖则不动
  setTimeout(() => {
    const t = state.ui.toast;
    if (t && t.until <= Date.now()) setUI({ toast: null });
  }, ms + 60);
}

export const toastLive = () => {
  const t = state.ui.toast;
  return t && t.until > Date.now() ? t : null;
};

/* ------------------------------ 领域 action ------------------------------ */

export const actions = {
  upsertPhotos(list) {
    const map = new Map(state.photos.map((p) => [p.id, p]));
    for (const p of list) map.set(p.id, { ...(map.get(p.id) || {}), ...p });
    state.photos = [...map.values()];
    save(); emit();
  },
  photo(id) { return state.photos.find((p) => p.id === id) || null; },

  /** 用户推翻 AI 判定 */
  override(id, val) {
    state.photos = state.photos.map((p) => (p.id === id ? { ...p, userOverride: val } : p));
    save(); emit();
  },

  setGroups(list) { state.groups = list; save(); emit(); },
  upsertGroup(g) {
    // 与 upsertRecipe 同理：用 map 生成新数组，不原地写（避免共享引用被改）
    const i = state.groups.findIndex((x) => x.id === g.id);
    state.groups = i >= 0
      ? state.groups.map((x, ix) => (ix === i ? { ...x, ...g } : x))
      : [...state.groups, g];
    save(); emit();
  },
  removeGroup(id) {
    state.groups = state.groups.filter((g) => g.id !== id);
    save(); emit();
  },

  upsertStory(s) {
    const i = state.stories.findIndex((x) => x.id === s.id);
    state.stories = i >= 0
      ? state.stories.map((x, ix) => (ix === i ? { ...x, ...s } : x))
      : [s, ...state.stories];
    save(); emit();
  },
  removeStory(id) {
    state.stories = state.stories.filter((s) => s.id !== id);
    save(); emit();
  },

  upsertRecipe(r) {
    const i = state.recipes.findIndex((x) => x.id === r.id);
    // 🔴 用 slice 后改元素，而不是 `state.recipes[i] = ...`。
    //    原地写会连带改到别处持有的同一个数组引用（这个坑真实发生过：
    //    共享引用让 reset() 失效，「清空全部数据」清不干净）。
    //    浅拷贝一份再改，代价可忽略，换来的是"没人能意外改到我的数组"。
    state.recipes = i >= 0
      ? state.recipes.map((x, ix) => (ix === i ? { ...x, ...r } : x))
      : [...state.recipes, r];
    save(); emit();
  },

  /**
   * 配方重命名 / 复制都能走 upsertRecipe（前者改 name，后者换新 id），删除才需单列。
   *
   * 🔴 删除必须连带清掉**成套方案里的引用**（settings.recipeBundles）。
   *    不清的话 bundle.beautyId 会指向已删除的 id，点「一键加载」时静默失败 ——
   *    那种 bug 最难查：按钮点了、没报错、什么都没发生。
   */
  removeRecipe(id) {
    state.recipes = state.recipes.filter((r) => r.id !== id);
    if (Array.isArray(state.settings && state.settings.recipeBundles)) {
      state.settings.recipeBundles = state.settings.recipeBundles.filter(
        (b) => b.beautyId !== id && b.templateId !== id
      );
    }
    save(); emit();
  },

  patchSettings(patch) {
    state.settings = { ...state.settings, ...patch };
    save(); emit();
  },

  /**
   * V1.5 切换外观主题。
   *  🔴 刻意复用 patchSettings 的落盘+广播链路，不另开一套持久化 ——
   *     主题只是 settings 上的一个字符串字段，不新增表、不改存档结构。
   *  🔴 非法 key（老存档被手改、跨版本脏数据）在 normalizeTheme 里就归一成
   *     'paper'，绝不让脏值写进 localStorage 污染后续判断。
   *  @returns {string} 归一化后的主题 key（调用方拿它去 applyTheme）
   */
  setTheme(key) {
    const k = normalizeTheme(key);
    state.settings = { ...state.settings, theme: k };
    save(); emit();
    return k;
  },

  /**
   * 明暗模式切换（方案：明暗是每套主题内部的子选项，不是并列的第二套皮肤）。
   * 'auto' 表示跟随系统 prefers-color-scheme，实际生效的明暗由 app.js 解析后交给 applyTheme。
   * @returns {string} 归一化后的模式（light / dark / auto）
   */
  setMode(mode) {
    const m = normalizeModePref(mode);
    state.settings = { ...state.settings, mode: m };
    save(); emit();
    return m;
  },

  /** 清理缓存：只删 APP 内缩略图与分析缓存，绝不触碰系统相册 */
  clearCache() {
    state.photos = [];
    state.groups = [];
    state.scanCursor = null;
    save(); emit();
  },

  reset() {
    state = makeInitial();
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    emit();
  },
};

load();

export const SETTINGS_DEFAULT = DEFAULT_SETTINGS;
