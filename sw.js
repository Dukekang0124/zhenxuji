/* sw.js — 离线缓存
   ⚠️ 版本号必须与 index.html / manifest.webmanifest / pages.js 兜底值四处同步。
   ⚠️ 新增 js 文件必须加进 ASSETS，否则离线时该模块 404。
   ⚠️ fetch 处理器必须"显式划定只管哪些请求"，不能写成"除了 X 全管"的 catch-all
      —— 否则会把数据面请求（GLM 代理、分享接口）也缓存掉，且缓存无 TTL，
      服务端变更前端长期看不到。 */

const CACHE = 'zhenxuji-v0.6.3';
// 🔴 这里**不能**列 '/version.json'：install 阶段 addAll 会把它缓存一份，
//    而下面 fetch 处理器又显式 return 不接管 → 缓存里躺着一份永远读不到的旧数据。
//    注释与代码打架，属于"写了但没生效"的静默问题（实测确认过）。
const ASSETS = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest',
  // 图标：SVG 用惯用写法不实际下载，这里显式列出 PNG，保证离线时 manifest 也能取到图标
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png',
  '/js/app.js', '/js/store.js', '/js/router.js', '/js/pages.js',
  '/js/cv.js', '/js/imaging.js', '/js/scan.js', '/js/export.js',
  '/js/ai.js', '/js/api.js', '/js/prompts.js', '/js/update.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

/** 只接管同源 GET 静态资源；数据面（/.cloud/、/api/）一律放行 */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.cloud/')) {
    return; // 数据面：不缓存、不接管
  }
  // 🔴 版本配置绝不走缓存（方案 §2.9）：被缓存 = 永远读到旧版本号，
  //    「检查更新」会一直说已是最新 —— 静默失效，用户完全无感。
  if (url.pathname === '/version.json') return;

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});
