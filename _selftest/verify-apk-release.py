# -*- coding: utf-8 -*-
"""帧叙集 · APK 独立复核（不依赖 CI 日志，也不依赖 apksigner / 本机 Java）

验六件事：
  ① 包内网页版本 == version.json 宣告版本
  ② 包内 web 层图标 7 个文件与仓库逐字节一致
  ③ 安卓层 launcher 图标**按像素**核对
     ⚠️ 不能按文件名找：`minifyEnabled` 下 AAPT2 会把 res/ 下的名字改短
        （实测叫 res/-B.png、res/2P.png…）并重新编码 PNG，所以文件名与字节都会变，
        唯一可信的比对是**解码后逐像素**。
  ④ 签名证书与上一个已发布版本（v0.6.2）**同一把**
     —— 这才是「老用户能覆盖安装、本地数据不丢」的端到端证据。
        CI 那步校验「keystore == signing.lock 基线」只是间接证明；
        这里直接解析 APK Signing Block（v2，ID 0x7109871a）取证书 DER 做比对。
  ⑤ 证书 DER 的结构自检（必须是合法 X.509 SEQUENCE，长度自洽）
  ⑥ 解析器鉴别力：在**证书字节本身**上翻转一位，取出的指纹必须随之改变
     —— 否则说明解析器在瞎猜（早先探针取在别的 ID-value 对上，
        改它当然不影响 v2 证书，那种"过了"毫无意义）
"""
import hashlib
import io
import re
import struct
import sys
import urllib.request
import zipfile

from PIL import Image, ImageChops

MAGIC = b"APK Sig Block 42"
V2_ID = 0x7109871A


def apk_signing_block(data):
    """定位 APK Signing Block，返回 (block_start, block_end)。

    版式：[entries][APK Signing Block][Central Directory][EOCD]
    签名块紧贴在中央目录之前，末尾 16 字节是 magic。
    """
    i = data.rfind(b"PK\x05\x06")
    if i < 0:
        raise ValueError("找不到 EOCD，不是合法 zip")
    cd_offset = struct.unpack_from("<I", data, i + 16)[0]
    if data[cd_offset - 16:cd_offset] != MAGIC:
        raise ValueError("中央目录前 16 字节不是 APK Sig Block 42（可能只有 v1 签名）")
    size_at_end = struct.unpack_from("<Q", data, cd_offset - 24)[0]
    start = cd_offset - 8 - size_at_end
    if struct.unpack_from("<Q", data, start)[0] != size_at_end:
        raise ValueError("签名块首尾长度字段不一致（结构损坏）")
    return start, cd_offset


def _lp(data, off, what, limit):
    """读一个 uint32 长度前缀 + 其载荷，返回 (载荷起, 载荷止)。

    🔴 每一层都必须显式解析并做边界校验。第一版就是靠"目测累加偏移"写出来的，
       结果少算了一层长度前缀（v2 里 signer 自己也是长度前缀的），
       取出来的"证书"首字节不是 0x30 —— 幸而 ⑤ 的 DER 结构自检把它当场抓出来，
       否则 ④ 会拿两段垃圾字节去比指纹，得出一个看起来很像结论的错误答案。
    """
    need = off + 4
    if need > limit:
        raise ValueError(f"{what}: 读长度前缀越界（off={off} limit={limit}）")
    n = struct.unpack_from("<I", data, off)[0]
    s, e = off + 4, off + 4 + n
    if e > limit:
        raise ValueError(f"{what}: 声明长度 {n} 超出边界（{e} > {limit}）")
    return s, e


def v2_cert(data):
    """返回 (证书 DER 的 sha256, DER 字节, DER 绝对偏移)。

    逐层结构（v2，ID 0x7109871a）：
      value        = uint32 signersLen + signers
      signers      = uint32 signerLen  + signer          ← 每个 signer 也带长度前缀
      signer       = uint32 sdLen      + signedData + signatures + publicKey
      signedData   = uint32 digLen + digests + uint32 certsLen + certificates + uint32 attrsLen + attrs
      certificates = uint32 certLen    + DER
    """
    start, end = apk_signing_block(data)
    p, vstart, vend = start + 8, None, None
    while p < end - 24:
        pair_len = struct.unpack_from("<Q", data, p)[0]
        pid = struct.unpack_from("<I", data, p + 8)[0]
        if pid == V2_ID:
            # 一对 = 8(长度) + 4(ID) + (pair_len - 4) 载荷
            vstart, vend = p + 12, p + 8 + pair_len
        p += 8 + pair_len          # 🔴 步长必须含那 8 字节长度字段
    if vstart is None:
        raise ValueError("签名块里没有 v2 签名（ID 0x7109871a）")
    if vend > end:
        raise ValueError("v2 载荷越出签名块")

    # 逐层解析。约定：`_lp(data, X, …)` 读的是**位于 X 的**长度字段，
    # 返回其载荷的 [起, 止)。所以下一步要拿"载荷起点"再读下一层。
    signers_start, _ = _lp(data, vstart, "signers 总长", vend)      # 载荷=signers
    signer_start, _ = _lp(data, signers_start, "signer 长度", vend)  # 载荷=1 个 signer
    sd_start, sd_end = _lp(data, signer_start, "signedData", vend)   # 载荷=signedData
    dig_start, dig_end = _lp(data, sd_start, "digests", sd_end)      # 载荷=digests
    certs_start, certs_end = _lp(data, dig_end, "certificates", sd_end)   # 载荷=certificates
    der_start, der_end = _lp(data, certs_start, "cert#1", certs_end)      # 载荷=DER
    der = data[der_start:der_end]
    return hashlib.sha256(der).hexdigest(), der, der_start


def der_ok(der):
    """最小 X.509 结构自检：SEQUENCE 头 + 声明长度 == 实际长度。"""
    if len(der) < 4 or der[0] != 0x30:
        return False, "首字节不是 0x30（不是 SEQUENCE）"
    b1 = der[1]
    if b1 < 0x80:
        declared, hdr = b1, 2
    else:
        n = b1 & 0x7F
        if n == 0 or n > 4 or len(der) < 2 + n:
            return False, "长度域非法"
        declared, hdr = int.from_bytes(der[2:2 + n], "big"), 2 + n
    if hdr + declared != len(der):
        return False, f"声明长度 {declared} + 头 {hdr} ≠ 实际 {len(der)}"
    return True, f"SEQUENCE，DER 长度 {len(der)} B 自洽"


def cn_of(der):
    """从 DER 里抓出可读的字符串字段（展示用，不做断言）。

    DER 的字符串是**长度前缀**的（不是 C 串），所以不能靠找 \\0 或直接抓连续可打印字节
    —— 第一版那样抓出来的是乱码 `;^=@?{0`，等于没验证。
    这里按 tag 找：0x0C=UTF8String / 0x13=PrintableString / 0x16=IA5String，
    取长度 2..64 且内容全可打印的那些。
    """
    out, i = [], 0
    while i < len(der) - 2:
        t = der[i]
        if t in (0x0C, 0x13, 0x16):
            n = der[i + 1]
            if 2 <= n <= 64 and i + 2 + n <= len(der):
                s = der[i + 2:i + 2 + n]
                if all(0x20 <= c < 0x7F for c in s):
                    out.append(s.decode("ascii"))
                    i += 2 + n
                    continue
        i += 1
    return " / ".join(out[-4:]) if out else "(未解析出可读字段)"


def px_key(blob):
    """把 PNG 解码成 RGBA 后算一个内容指纹，用于按**像素**匹配。

    为什么不用解码后字节直接当 key：PIL 解出的原始缓冲随模式/行距而变；
    统一 convert('RGBA') 后过一遍 tobytes() 才是稳定的可比对象。
    返回 (宽, 高, sha256(像素))；解码失败返回 None。
    """
    try:
        im = Image.open(io.BytesIO(blob)).convert("RGBA")
    except Exception:
        return None
    return (im.size[0], im.size[1], hashlib.sha256(im.tobytes()).hexdigest())


def px_diff(blob_a, blob_b):
    """给"没匹配上"的情况用：给出最大通道差，区分"完全不同"与"仅编码差异"。"""
    ia = Image.open(io.BytesIO(blob_a)).convert("RGBA")
    ib = Image.open(io.BytesIO(blob_b)).convert("RGBA")
    if ia.size != ib.size:
        return 999, ia.size
    diff = ImageChops.difference(ia, ib)
    mx = 0
    for p in diff.getdata():
        for ch in p:
            if ch > mx:
                mx = ch
    return mx, ia.size


def fetch(url, tok):
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + tok,
        "Accept": "application/octet-stream",
        "User-Agent": "zx",
    })
    return urllib.request.urlopen(req).read()


def main(apk_path, repo_root, vj_path, prev_apk, prev_label):
    data = open(apk_path, "rb").read()
    z = zipfile.ZipFile(apk_path)
    names = z.namelist()
    ok = True
    fail = []

    print("=" * 66)
    print(f"APK  {apk_path}")
    print(f"  magic  {data[:2]}   size {len(data):,} B")
    print(f"  md5    {hashlib.md5(data).hexdigest()}")
    print(f"  sha256 {hashlib.sha256(data).hexdigest()}")

    # ---------- ① 版本 ----------
    cur = re.search(r"window\.APP_VERSION = '([\d.]+)'",
                    z.read("assets/public/index.html").decode("utf-8"))
    want = re.search(r'"latest_version"\s*:\s*"([\d.]+)"', open(vj_path, encoding="utf-8").read())
    got, exp = (cur.group(1) if cur else None), (want.group(1) if want else None)
    good = got == exp
    ok &= good
    print(f"\n① 包内 APP_VERSION = {got}   version.json 宣告 = {exp}   {'✓ 一致' if good else '✗ 不一致'}")
    if not good:
        fail.append("① 版本不一致")

    # ---------- ② web 层图标 ----------
    print("\n② 包内 web 层图标 vs 仓库（逐字节）")
    wicons = sorted(n for n in names if n.startswith("assets/public/icons/"))
    for n in wicons:
        rel = n.replace("assets/public/", "")
        same = z.read(n) == open(f"{repo_root}/{rel}", "rb").read()
        ok &= same
        if not same:
            fail.append(f"② {rel} 字节不一致")
        print(f"   {'✓' if same else '✗'} {rel:38s} {z.getinfo(n).file_size:>7,} B")

    # ---------- ③ 安卓层图标（按像素） ----------
    print("\n③ 包内安卓 launcher 图标 vs 仓库（解码后逐像素 —— 名字被 AAPT2 改过，只能按内容找）")
    repo_mip = []
    for mp in ("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"):
        for f in ("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"):
            rel = f"android/app/src/main/res/mipmap-{mp}/{f}"
            try:
                repo_mip.append((rel, open(f"{repo_root}/{rel}", "rb").read()))
            except FileNotFoundError:
                pass
    cands = [(n, z.read(n)) for n in names if n.startswith("res/") and n.endswith(".png")]
    index = {}
    for n, cb in cands:
        k = px_key(cb)
        if k:
            index.setdefault(k, n)
    print(f"   仓库待核 {len(repo_mip)} 个；包内 res/*.png 候选 {len(cands)} 个（已建立像素索引 {len(index)} 项）")
    hit = 0
    for rel, blob in repo_mip:
        name = rel.split("/")[-1]
        k = px_key(blob)
        n = index.get(k) if k else None
        if n:
            hit += 1
            print(f"   ✓ res/{n.split('/')[-1]:12s} ({k[0]}²) 像素全等 == {rel}")
        else:
            # 没命中时给出最近似的候选，好判断是"换了图"还是"仅编码不同"
            best, bname = 999, None
            for n2, cb in cands:
                d, size = px_diff(blob, cb)
                if size == k[:2] and d < best:
                    best, bname = d, n2
            print(f"   ✗ 包内找不到与 {rel} 像素相同的资源"
                  + (f"（最接近的 {bname} 最大通道差 {best}）" if bname else "（无同尺寸候选）"))
            fail.append(f"③ {rel}")
    ok &= hit == len(repo_mip)

    # ---------- ④ 签名证书 vs 上一版 ----------
    fp, der, der_off = v2_cert(data)
    print(f"\n④ 签名证书")
    print(f"   本包 v2 证书 SHA-256 = {fp}")
    print(f"       主体片段 = {cn_of(der)[:70]}")
    pfp, pder, _ = v2_cert(prev_apk)
    same = fp == pfp
    ok &= same
    print(f"   {prev_label} v2 证书 SHA-256 = {pfp}")
    if same:
        print(f"   ✓ 与 {prev_label} 同一把签名密钥 —— 老用户可覆盖安装，本地数据不丢")
    else:
        print(f"   ✗ 签名密钥与 {prev_label} 不同！覆盖安装会失败、本地数据会丢")
        fail.append("④ 签名密钥变了")

    # ---------- ⑤ DER 结构自检 ----------
    good, why = der_ok(der)
    ok &= good
    print(f"\n⑤ 证书 DER 结构自检 = {'✓ ' + why if good else '✗ ' + why}")
    if not good:
        fail.append("⑤ DER 结构非法")

    # ---------- ⑥ 解析器鉴别力 ----------
    # 在**证书字节本身**上翻转一位（不是随便找个偏移）—— 指纹必须随之改变。
    tampered = bytearray(data)
    tampered[der_off] ^= 0x01
    try:
        fp2, _, _ = v2_cert(bytes(tampered))
        disc = fp2 != fp
    except Exception:
        disc = True
    ok &= disc
    print(f"⑥ 解析器鉴别力（证书首字节翻转 1 位 → 指纹必须变） = {'✓ 有鉴别力' if disc else '✗ 无鉴别力'}")
    if not disc:
        fail.append("⑥ 解析器无鉴别力")

    print("\n" + "=" * 66)
    if ok:
        print("复核结果：✅ 六项全部通过")
    else:
        print("复核结果：❌ 未通过项：")
        for f_ in fail:
            print("   - " + f_)
    return 0 if ok else 1


if __name__ == "__main__":
    apk, root, vj, prev_path, prev_label = sys.argv[1:6]
    sys.exit(main(apk, root, vj, open(prev_path, "rb").read(), prev_label))
