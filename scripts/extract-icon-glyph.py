# -*- coding: utf-8 -*-
"""帧叙集 · 从康哥定的源图提取「帧」字图形（带 alpha），并输出几何测量。

为什么不是"抠掉白底"：
  源图有两种极浅的底色（外圈纯白 #FFFFFF + 圆角面板奶白 #F8F8F0），
  图形有两种实色（黑 #1C1412 + 豆沙 #D8A088）。若只用一条"离底色多远"的
  阈值做 alpha，黑色边界的抗锯齿像素会被判成 100% 不透明 —— 黑字会**胀**一圈。
  所以这里用**双色线性混合模型**解 alpha：
      p = a·C + (1-a)·BG   →  a = ⟨p-BG, C-BG⟩ / |C-BG|²
  对黑、豆沙各解一次，取残差更小的那个作为该像素的归属。
  胶片齿孔是"面板色透出来"，a≈0 → 自然成为透明孔，不需要单独识别。
"""
import json
import sys
from PIL import Image

SRC, OUT, REPORT = sys.argv[1:4]
MAXDIM = int(sys.argv[4]) if len(sys.argv) > 4 else 1024

im = Image.open(SRC).convert("RGB")
W, H = im.size
px = im.load()

# ---------- 1. 估底色与两种实色 ----------
# 底色：取最外 40px 环带的中位数（那里一定是面板外围的白/奶）
ring = []
for y in range(H):
    for x in range(W):
        if x < 40 or x >= W - 40 or y < 40 or y >= H - 40:
            ring.append(px[x, y])
BG = tuple(sorted(v[i] for v in ring)[len(ring) // 2] for i in range(3))

# 实色：按亮度聚类取均值 —— 最暗 2% 归黑，豆沙带（R 明显大于 B 且中亮）归豆沙
dark, terra = [], []
for y in range(0, H, 2):
    for x in range(0, W, 2):
        r, g, b = px[x, y]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum < 60:
            dark.append((r, g, b))
        elif 130 < lum < 210 and (r - b) > 55:
            terra.append((r, g, b))
mean = lambda L: tuple(sum(v[i] for v in L) / len(L) for i in range(3))
C_BLACK = mean(dark)
C_TERRA = mean(terra)
print(f"BG      = {tuple(round(v) for v in BG)}  #%02X%02X%02X" % tuple(round(v) for v in BG))
print(f"C_BLACK = {tuple(round(v) for v in C_BLACK)}  #%02X%02X%02X" % tuple(round(v) for v in C_BLACK))
print(f"C_TERRA = {tuple(round(v) for v in C_TERRA)}  #%02X%02X%02X" % tuple(round(v) for v in C_TERRA))
print(f"黑样本 {len(dark)} / 豆沙样本 {len(terra)}")

# ---------- 2. 双色混合模型解 alpha ----------
CAND = [tuple(round(v) for v in C_BLACK), tuple(round(v) for v in C_TERRA)]
segs = []
for C in CAND:
    d = [C[i] - BG[i] for i in range(3)]
    segs.append((C, d, sum(v * v for v in d)))

def solve(p):
    best = (0.0, 1e9, 0)
    for idx, (C, d, dd) in enumerate(segs):
        if dd <= 0:
            continue
        a = sum((p[i] - BG[i]) * d[i] for i in range(3)) / dd
        a = 0.0 if a < 0 else (1.0 if a > 1 else a)
        res = sum((p[i] - (BG[i] + a * d[i])) ** 2 for i in range(3))
        if res < best[1]:
            best = (a, res, idx)
    return best

out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
op = out.load()
NOISE = 16.0  # JPEG 在奶白底的抖动幅度，低于此一律视为背景，避免满屏麻点
SNAP_HI, SNAP_LO = 0.94, 0.05   # 🔴 alpha 吸附：实体内部压平成 255、背景压平成 0

# 为什么必须吸附：投影解出的 a 在"本该是 1"的实色内部会跟着 JPEG 噪点在
# 0.96~1.00 之间抖，alpha 通道因此变成一片随机噪声 —— 视觉上看不出来，
# 但 PNG 完全压不动（实测 1024px 达 178KB，占满 PWA 预缓存预算）。
# 吸附后只有真正的边界像素保留中间值，平区变成 run-length，体积掉一个数量级。
for y in range(H):
    for x in range(W):
        p = px[x, y]
        a, res, idx = solve(p)
        if res > 900:          # 拟合不上（黑豆沙交界处的过渡像素）→ 按覆盖度软化
            a *= 0.85
        if a * segs[idx][2] ** 0.5 < NOISE:
            continue
        C = segs[idx][0]
        a = min(1.0, max(0.0, a))
        if a >= SNAP_HI:
            a = 1.0
        elif a <= SNAP_LO:
            continue
        # 反预乘还原纯色（边缘像素原样保留其混合比例，交给合成端）
        op[x, y] = (int(round(C[0])), int(round(C[1])), int(round(C[2])), int(round(a * 255)))

# ---------- 3.5 边缘扩散（alpha bleed）----------
# 🔴 透明像素的 RGB 是画布初值 (0,0,0) 纯黑。这不影响"原样显示"，但一旦**缩放**
#    就会出事：任何在非预乘空间插值的消费端会把外围的黑平均进边缘 →
#    图形四周围一圈灰黑脏边（大倍率缩小尤其明显，缩小 17 倍时插值核跨 17 个源像素）。
#    做法（粗到细，两步）：
#      ① 降到 64px 小图，透明区从实色邻居逐轮蔓延 —— 小图上几十轮就铺满全场；
#      ② 最近邻放大回原尺寸当"远处底色"，再做 6 轮全分辨率精修，把边缘 6px 修准。
#    这样透明区的 RGB 与最近实色一致，任何插值都不会引入外来色。
import numpy as np

arr = np.array(out)
rgb, alpha = arr[:, :, :3].copy(), arr[:, :, 3].copy()
filled = alpha > 0

def bleed(rgb, filled, passes):
    """把 filled=False 的像素用相邻已填像素的 RGB 染色，跑 passes 轮。"""
    for _ in range(passes):
        if filled.all():
            break
        grew = False
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            s_rgb = np.roll(rgb, (dy, dx), axis=(0, 1))
            s_fil = np.roll(filled, (dy, dx), axis=(0, 1))
            # 卷绕到对侧的像素要作废，否则会从画布另一头"穿墙"取色
            if dy > 0:   s_fil[0, :] = False
            elif dy < 0: s_fil[-1, :] = False
            if dx > 0:   s_fil[:, 0] = False
            elif dx < 0: s_fil[:, -1] = False
            take = (~filled) & s_fil
            if take.any():
                rgb[take] = s_rgb[take]
                filled = filled | take
                grew = True
        if not grew:
            break
    return rgb, filled

# ① 小图上铺满
small_scale = 64 / max(W, H)
sw_, sh_ = max(1, round(W * small_scale)), max(1, round(H * small_scale))
s_rgb = np.array(Image.fromarray(rgb, "RGB").resize((sw_, sh_), Image.NEAREST))
s_fil = np.array(Image.fromarray((filled * 255).astype(np.uint8), "L").resize((sw_, sh_), Image.NEAREST)) > 0
s_rgb, s_fil = bleed(s_rgb, s_fil, 200)
# ② 最近邻放大回来，作为远处底色
far = np.array(Image.fromarray(s_rgb, "RGB").resize((W, H), Image.NEAREST))
rgb[~filled] = far[~filled]
# ③ 全分辨率精修边缘
rgb, filled = bleed(rgb, filled, 6)
arr[:, :, :3] = rgb
out = Image.fromarray(arr, "RGBA")
print(f"边缘扩散完成（小图 {sw_}x{sh_} 铺满 + 6 轮精修）")

# ---------- 3. 测 bbox ----------
A = out.getchannel("A")
bbox = A.point(lambda v: 255 if v > 64 else 0).getbbox()
print(f"glyph bbox = {bbox}  w={bbox[2]-bbox[0]} h={bbox[3]-bbox[1]}")
print(f"  相对画布 = {(bbox[2]-bbox[0])/W*100:.1f}% x {(bbox[3]-bbox[1])/H*100:.1f}%")
print(f"  bbox 中心 = ({(bbox[0]+bbox[2])/2:.1f},{(bbox[1]+bbox[3])/2:.1f}) 画布中心 ({(W-1)/2:.1f},{(H-1)/2:.1f})")

# ---------- 4. 紧裁为 1:1 原生（MAXDIM 是**上限**，只降不升） ----------
# 🔴 为什么是"上限"而不是"目标"：源图里字形原生只有 828×717 像素。
#    若把它 Lanczos 拉到 1024，插值会在每条边凭空造出十来个中间 alpha 值 ——
#    既没有增加任何真实信息，又让 PNG 体积翻倍（实测 60KB → 118KB）。
#    下游最大只用到 512（PWA）/ 432（安卓 xxxhdpi 前景），原生尺寸本来就够。
glyph = out.crop(bbox)
gw, gh = glyph.size
s = min(1.0, MAXDIM / max(gw, gh))
nw, nh = max(1, round(gw * s)), max(1, round(gh * s))
if (nw, nh) != (gw, gh):
    glyph = glyph.resize((nw, nh), Image.LANCZOS)
glyph.save(OUT, optimize=True, compress_level=9)
print(f"输出 {OUT}  {nw}x{nh}  （原生 {gw}x{gh}，上限 {MAXDIM}，宽高比 {gw/gh:.4f}）")
print(f"文件体积 = {__import__('os').path.getsize(OUT)} B")

json.dump({
    # 🔴 溯源：设计稿原本在微信的临时目录里（RWTemp/…），**随时会被清掉**。
    #    所以原件另存一份进 assets/icon/，sha256 记在这里 —— 将来要"从设计稿重跑一遍"
    #    必须有这个锚点，否则只剩一张不知从哪来的 PNG，谁也复现不出来。
    "_pipeline": "scripts/extract-icon-glyph.py  →  scripts/gen-icons.mjs",
    "_source_copy": "assets/icon/source-design-1280.jpg",
    "source_sha256": __import__("hashlib").sha256(
        open(SRC, "rb").read()).hexdigest(),
    "source": SRC, "source_size": [W, H],
    "bg": [round(v) for v in BG],
    "c_black": [round(v) for v in C_BLACK],
    "c_terra": [round(v) for v in C_TERRA],
    "bbox": list(bbox),
    "glyph_native": [gw, gh],
    "aspect": round(gw / gh, 5),
    "output": [nw, nh],
}, open(REPORT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("测量已写入", REPORT)
