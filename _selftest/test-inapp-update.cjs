/* 鉴别力探针：点「立即更新」绝不许 window.open 跳出应用。
 *
 * 根因（2026-10-05）：0.6.5 的 performUpdate 里 isNativeCapacitor() 只认
 * Capacitor.isNativePlatform()，而本应用 bundledWebRuntime=false 且 index.html 没引
 * capacitor.js → Capacitor 全局 undefined → isNativeCapacitor 误判非原生 → 走
 * window.open 兜底跳出应用（跳到系统浏览器/第三方 app）。
 *
 * 本测试直接驱动 update.js 的 performUpdate（不依赖浏览器/APK），mock 出
 * Capacitor.Plugins，断言：
 *   ① APK 路径：必走 installApkInApp，window.open 调用次数 = 0
 *   ② 插件缺失：installApkInApp 抛错 → performUpdate 返回 ok:false（仍是 toast，不跳走）
 *   ③ PWA 路径：走刷新提示，window.open 次数 = 0
 * 若旧代码（window.open 兜底）在此探针下：① 会调用 window.open（探针判失败）。
 */
const path = require('path');

let failures = 0;
const ok = (c, m) => { if (c) { console.log('  ✓', m); } else { console.error('  ✗', m); failures++; } };

async function main() {
  // ---- 全局 mock ----
  const calls = { windowOpen: 0, installApk: 0, writeFile: 0 };
  globalThis.window = {
    open: (...a) => { calls.windowOpen++; console.log('    [window.open 被调用]', a); },
  };
  // Node 22 自带 btoa / Blob / fetch，但 fetch 我们覆盖

  const AppInstallPlugin = {
    canInstallUnknownApps: async () => ({ granted: true }),
    openInstallUnknownAppsSettings: async () => ({}),
    installApk: async (o) => { calls.installApk++; return { message: 'ok' }; },
  };
  const Filesystem = {
    writeFile: async (o) => { calls.writeFile++; },
    getUri: async () => ({ uri: 'file:///cache/zhenxuji-update.apk' }),
  };
  globalThis.Capacitor = { Plugins: { AppInstallPlugin, Filesystem } };

  // mock fetch → 返回一个可 arrayBuffer 的 Blob
  const fakeBuf = new Uint8Array([1, 2, 3, 4]).buffer;
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => new Blob([fakeBuf]) });

  const u = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'js', 'update.js')).href);

  // ① APK 路径：有插件 → 必须走 installApkInApp
  calls.windowOpen = 0; calls.installApk = 0;
  const r1 = await u.performUpdate({ updateUrl: 'https://example.com/x.apk' }, true);
  ok(calls.windowOpen === 0, '① APK 路径未调用 window.open（核心修复点）');
  ok(calls.installApk === 1, '① APK 路径调用了原生 installApk（应用内安装）');
  ok(r1.ok === true && r1.mode === 'apk', '① 返回 {ok:true, mode:apk}');

  // ② 插件缺失：installApkInApp 抛错 → 失败但绝不 window.open
  calls.windowOpen = 0;
  globalThis.Capacitor = { Plugins: {} };   // 没有 AppInstallPlugin / Filesystem
  const r2 = await u.performUpdate({ updateUrl: 'https://example.com/x.apk' }, true);
  ok(calls.windowOpen === 0, '② 插件缺失时仍未调用 window.open（不跳走）');
  ok(r2.ok === false && r2.mode === 'apk', '② 插件缺失返回 {ok:false}（弹 toast，留在应用内）');

  // ③ PWA 路径
  calls.windowOpen = 0;
  const r3 = await u.performUpdate({ updateUrl: 'https://example.com/x.apk' }, false);
  ok(calls.windowOpen === 0, '③ PWA 路径未调用 window.open');
  ok(r3.ok === true && r3.mode === 'pwa', '③ PWA 返回 {ok:true, mode:pwa}（刷新提示）');

  console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('运行异常:', e); process.exit(2); });
