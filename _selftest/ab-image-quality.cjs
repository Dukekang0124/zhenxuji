// 图片画质 A/B 对照探针 —— 判定「修复到底有没有真的生效」。
//
// 为什么要有这个脚本：
//   图片糊图的根因是「**生产链路从不挂 `_file`**」，而原来所有测试都是靠 seed()
//   手工往照片上塞 `_file` 才通过的 —— 典型的"测试在说谎"：断言绿、产品糊。
//   所以光跑一遍新代码全绿**不能**证明修复有效，必须证明：
//     ① 新代码拿到原图（_file / 3840 像素）；
//     ② **旧代码在同一个探针下必须失败**（否则这个探针没有鉴别力，绿了也没意义）。
//
// 用法：把新旧两份代码各起一个 http 服务，分别喂给本脚本，对比两行 JSON。
//   BASE=http://127.0.0.1:4188 node _selftest/ab-image-quality.cjs   # 新（工作区）
//   BASE=http://127.0.0.1:4380 node _selftest/ab-image-quality.cjs   # 旧（git worktree add /d/_zx_ab HEAD）
//
// 🔴 只用一次 page.goto：不 reload，免得 store.load() 把 _file 置 null 造成假失败。
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4188';

(async () => {
  // 本机 Chrome（playwright 自带浏览器常未下载，直接 launch 会报 chrome-headless-shell 缺失）
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.route('**/api/version', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ latest_version: '0.6.2', is_force: false, update_url: '' }),
  }));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const r = await page.evaluate(async () => {
    // 造一张 3840×2160 的高清样张（有高频细节，便于看压缩痕迹）
    const c = document.createElement('canvas'); c.width = 3840; c.height = 2160;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 3840, 2160);
    g.addColorStop(0, '#2b5fa8'); g.addColorStop(1, '#c86a2b');
    x.fillStyle = g; x.fillRect(0, 0, 3840, 2160);
    x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 1;
    for (let i = 0; i < 3840; i += 3) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 2160); x.stroke(); }
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
    const file = new File([blob], 'AB4K.jpg', { type: 'image/jpeg', lastModified: 1758000000000 });

    const st = await import('/js/store.js');
    st.actions.reset();
    const { scanFiles } = await import('/js/scan.js');
    const res = await scanFiles([file], {
      batchSize: st.get().settings.scanBatchSize,
      thumbSize: st.get().settings.thumbSize,     // ← 旧代码这里是 96
      autoDowngrade: st.get().settings.autoDowngrade,
    });
    st.actions.upsertPhotos(res.photos);
    const p = st.get().photos[0];
    if (!p) return { error: '未产出照片对象' };

    // 缩略图实际像素宽
    const timg = new Image();
    await new Promise((res2) => { timg.onload = res2; timg.onerror = res2; timg.src = p.thumbUrl; });

    // 作品详情页全宽大图的实际像素宽（用户截图里最糊的位置）
    st.actions.setGroups([{ id: 'gab', title: 'AB', photoIds: [p.id], coverId: p.id }]);
    st.actions.upsertStory({
      id: 'sab', groupId: 'gab', title: 'AB', createdAt: Date.now(), publishedAt: Date.now(),
      photoIds: [p.id], order: 'time', templateId: 'tpl_1', dateText: '10月4日',
      text: { cover: 'AB', captions: [], body: '', hook: '' },
      stats: { views: 0, likes: 0, comments: 0 },
    });
    location.hash = '#/__ab';
    await new Promise((res2) => setTimeout(res2, 30));
    location.hash = '#/detail/sab';
    await new Promise((res2) => setTimeout(res2, 350));
    const dimg = document.querySelector('#view img');
    const detailW = dimg ? dimg.naturalWidth : 0;

    // 导出取源：degraded=true 即"拿缩略图糊弄导出"
    const ex = await import('/js/export.js');
    const e = await ex.loadForExport(p, 1080);

    return {
      thumbSizeSetting: st.get().settings.thumbSize,
      hasUnderlyingFile: Boolean(p._file),
      underlyingBytes: p._file ? p._file.size : 0,
      originalWH: [p.w, p.h],
      thumbPixelW: timg.naturalWidth,
      detailNaturalW: detailW,
      exportW: e.canvas ? e.canvas.width : 0,
      exportDegraded: e.degraded,
    };
  });

  console.log(JSON.stringify(r));
  if (errs.length) console.error('页面错误：', errs.slice(0, 3));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('A/B 探针异常：', e); process.exit(2); });
