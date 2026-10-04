/**
 * exportdl.js — 导出落点与历史（P0-Bug1 修复）
 *
 * 🔴 Bug 现象（真跑确认）：点「导出」只弹 toast「九宫格已导出」，
 *    用户**完全不知道文件去哪了** —— toast 一闪就没，功能等于半残。
 *
 * ⚠️⚠️ 一条必须先讲清的事实纠正（别按错误前提写代码）：
 *    现有导出走的是 `export.js` 的 downloadCanvas / downloadText，
 *    本质是**浏览器下载**（<a download> + blob URL）。
 *    这意味着：
 *      • **PWA / 浏览器里不存在"保存到相册文件夹"这回事** ——
 *        浏览器的安全模型不允许网页自行写入相册，
 *        `<a download>` 只能落到浏览器下载目录（iOS 则是"文件"App / 分享面板）。
 *      • **本项目虽是 Capacitor APK，但 android/ 下没装任何官方插件**
 *        （无 Filesystem / Photos / Share），package.json 只有 @capacitor/android|cli|core。
 *        所以当前 APK 里同样走的是 WebView 的下载路径。
 *    ⇒ 康哥方案里的「保存到【手机相册-帧叙集】相册文件夹」「拉起系统相册定位文件夹」
 *      **必须先装 Capacitor Photos/Filesystem 插件才可能实现**，
 *      不是加个前端判断就能有的能力。硬写只会得到"看起来成功、文件其实没进相册"。
 *
 *    因此本模块做的是**当下真能兑现的那一版**，并且把能力缺口显式暴露出来：
 *      ① 导出后给**模态弹窗**（不再靠一闪而过的 toast），明确说清文件去哪了
 *      ② 按运行环境给**不同的诚实文案**（原生壳 / 移动浏览器 / 桌面）
 *      ③ 提供**可执行的补救动作**（重新下载 / 复制文件名 / 系统设置指引）
 *      ④ 落**导出历史**，随时回看已导出的文件（含缩略图 + 时间 + 再次下载）
 *      ⑤ 导出历史带「打开相册/文件管理器」指引，但**如实说明是否可用**
 */

/** 运行环境判定（与 update.js 的 isApk 同源思路，这里更轻） */
export function envKind(w = window) {
  const g = w;
  // Capacitor 注入的全局存在 → 跑在 APK 里
  const cap = g.Capacitor;
  const native = Boolean(cap && ((cap.isNativePlatform && cap.isNativePlatform()) || cap.getPlatform?.() === 'android' || cap.getPlatform?.() === 'ios'));
  if (native) return 'native';

  const ua = (navigator && navigator.userAgent) || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  // iOS 的 <a download> 走的是"分享/存储到文件"面板，不是下载目录
  const ios = /iPhone|iPad|iPod/i.test(ua);
  if (mobile) return ios ? 'ios' : 'mobile';
  return 'desktop';
}

/**
 * 各环境的**诚实落点文案**。
 *
 * 🔴 关键纪律：文案必须说**这个环境真实会发生什么**。
 *    反例（本项目第一版的错误）：在纯浏览器里也写"已保存到相册-帧叙集文件夹"
 *    —— 用户去相册翻遍都找不到，从此再也不信这个 App。
 */
export function landingHint(kind, filename) {
  switch (kind) {
    case 'native':
      // 注意：即便在 APK 里，当前也仍是 WebView 下载（无相册插件）。
      // 如实说"已触发系统下载"，不谎称"已在相册"。
      return {
        ok: '已触发系统下载',
        where: `文件名为 ${filename}`,
        detail: '当前版本走系统下载通道。若没自动保存，请点下方「再次下载」并在系统下载/文件管理里查看。',
        canOpenAlbum: false,
      };
    case 'ios':
      return {
        ok: '已弹出分享面板',
        where: `文件名 ${filename}`,
        detail: 'iPhone 上请在分享面板里选「存储到文件」或直接发给好友——iOS 不允许网页直接写入相册。',
        canOpenAlbum: false,
      };
    case 'mobile':
      return {
        ok: '已下载',
        where: `文件名 ${filename}`,
        detail: '在浏览器菜单里打开「下载」，图片就在这里（部分手机会同时存一份到相册）。',
        canOpenAlbum: false,
      };
    default:
      return {
        ok: '已下载',
        where: `文件名 ${filename}`,
        detail: '文件在浏览器的「下载」列表里。若没看到，检查浏览器是否拦截了自动下载。',
        canOpenAlbum: false,
      };
  }
}

/**
 * 🔴 是否具备「保存到相册」的真能力。
 * 当前恒为 false —— 未装 @capacitor/photos。
 * 保留这个函数是为了**不把能力缺口藏起来**：以后装了插件，只改这里，
 * 不必再去 UI 里翻文案（文案里凡是要区别"能存相册/不能存相册"的地方都问它）。
 */
export function canSaveToAlbum() {
  // 一旦将来装了官方 Photos 插件，这里改成检测其存在即可：
  // return Boolean(window.Capacitor?.Plugins?.Photos);
  return false;
}

/* ==================== 导出历史 ==================== */

const MAX_HISTORY = 30;

export function makeRecord({ kind, filename, thumb, storyTitle, storyId }) {
  return {
    id: `ex_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    kind,                 // 'grid' | 'long' | 'h5'
    filename,
    storyId: storyId || '',   // 🔴 P0(C5)：历史/弹窗「再次下载」凭它找回原作品重导出
    storyTitle: storyTitle || '未命名作品',
    thumb: thumb || '',   // 缩略图（dataURL，不持久化到 localStorage 会被剥离字段剥离）
    at: Date.now(),
    env: envKind(),
    where: landingHint(envKind(), filename),
  };
}

/** 把新记录插到最前并裁剪上限（导出历史是**运行态**，不持久化，见下） */
export function pushRecord(list, rec) {
  const next = [rec, ...(list || [])];
  return next.slice(0, MAX_HISTORY);
}

export const KIND_LABEL = { grid: '叙事九宫格', long: '竖版长图', h5: 'H5 网页' };

export function fmtWhen(ts) {
  const d = new Date(ts || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
