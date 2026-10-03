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
  thumbSize: 96,            // 缩略图边长（内存不足时降采样）
  autoDowngrade: true,      // 低端设备自动降级
  theme: 'origin',          // 主题包 key（8 套：scene 场景组 / classic 经典组）
  mode: 'auto',             // 明暗模式（light / dark / auto）—— auto 跟随系统，见 js/app.js
};

const initial = {
  photos: [],       // Photo[]（cv/verdict 持久化，thumbUrl 不持久化）
  groups: [],       // EventGroup[]
  stories: [],      // Story[]
  recipes: [],      // Recipe[]
  settings: { ...DEFAULT_SETTINGS },
  scanCursor: null, // 增量扫描游标 { lastScanAt, count }

  // —— 运行态（不持久化）——
  ui: { route: '', busy: null, toast: null, scan: null },
};

let state = { ...initial };
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
    // 反序列化后只清不可序列化的运行态字段。
    // ⚠️ thumbUrl 是 dataURL（字符串，可持久化）—— 曾被误当 blob URL 清空，
    //    导致重启后缩略图全空。真正不能持久化的只有 _file（File 句柄）。
    state.photos = (state.photos || []).map((p) => ({ ...p, _file: null }));
  } catch (e) {
    console.warn('[store] load failed, use defaults', e);
  }
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
          // 只剥离不可序列化的 File 句柄；dataURL 缩略图保留（重启后可见）
          out.photos = state.photos.map((p) => {
            const { _file, ...rest } = p;
            return rest;
          });
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
    const i = state.groups.findIndex((x) => x.id === g.id);
    if (i >= 0) state.groups[i] = { ...state.groups[i], ...g };
    else state.groups = [...state.groups, g];
    save(); emit();
  },
  removeGroup(id) {
    state.groups = state.groups.filter((g) => g.id !== id);
    save(); emit();
  },

  upsertStory(s) {
    const i = state.stories.findIndex((x) => x.id === s.id);
    if (i >= 0) state.stories[i] = { ...state.stories[i], ...s };
    else state.stories = [s, ...state.stories];
    save(); emit();
  },
  removeStory(id) {
    state.stories = state.stories.filter((s) => s.id !== id);
    save(); emit();
  },

  upsertRecipe(r) {
    const i = state.recipes.findIndex((x) => x.id === r.id);
    if (i >= 0) state.recipes[i] = { ...state.recipes[i], ...r };
    else state.recipes = [...state.recipes, r];
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
    state = { ...initial, settings: { ...DEFAULT_SETTINGS } };
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    emit();
  },
};

load();

export const SETTINGS_DEFAULT = DEFAULT_SETTINGS;
