# 帧叙集 · Android/CI 风险预案（P2 留存）

> 配套：方案 A（`android/` 入库 + CI 从 `capacitor add` 改 `cap copy`）+ 测试矩阵前置闸门 + 指纹/配置漂移锚点。
> 适用仓库：`Dukekang0124/zhenxuji` ｜ 最后更新：2026-10-03

---

## 0. 现状锚点（必读）

- **`android/` 已入库**（方案 A）。CI 不再重建工程，只 `cap copy` 同步 web 产物，构建用仓库内**定制** `build.gradle`（含签名逻辑 / v2+v3 签名 / R8 排除 WebView JS 桥接 / keystore 路径校验 / 中文路径 overridePathCheck）。
- **核心闸门**（CI 与本地同构的保证）：
  - 测试矩阵前置：Step 4 `verify-llm.js`、Step 5 `check-worker-env`、Step 6 `check-android-config`、Step 7 `check:theme` —— 任一不过，Step 8 起不再构建。
  - 配置漂移锚点：`android/build-config.lock.json`（10 个受管控构建配置逐字节 SHA-256 基准），`npm run check:android` 校验，`--bless` 重建基准。
  - 指纹锚点：`android/signing.lock`（签名证书 SHA-256 基线），CI Step 21 用 `apksigner` 提取证书指纹比对。
  - tag 一致性：CI Step 22 校验 `tag == index.html 的 APP_VERSION`（外部锚点，防自证）。
- **签名**：固定 keystore 经 GitHub Secrets（`KEYSTORE_B64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`）传入，CI **不生成**密钥。
- **当前基线真值**：证书指纹 `9626e01fb8ddf9a380cf0dd891ccb49b05087011b83c6a6439af4167851aaf17`；10 个构建配置哈希见 `android/build-config.lock.json`。

---

## 1. Android 目录 Git 冲突预案

**场景**：多机/多人改了 `android/` 内文件（build.gradle、AndroidManifest.xml、gradle 脚本），merge/rebase 冲突；或本机改了未提交、CI 推了新基线。

**根因**：`android/` 是「生成产物 + 定制配置」的混合体。部分文件机相关，若误入库会制造**持续**冲突。

### 1.1 先分清「受管」与「机相关」
| 类别 | 文件 | 冲突时处置 |
|---|---|---|
| **受管**（入库、CI 校验） | `app/build.gradle`、`build.gradle`、`settings.gradle`、`variables.gradle`、`gradle.properties`、`app/proguard-rules.pro`、`AndroidManifest.xml`、`app/capacitor.build.gradle`、`cordova.variables.gradle`、`capacitor-cordova-android-plugins/build.gradle` | 人工核对后解冲突，解完重跑 `npm run check:android` |
| **机相关**（在 .gitignore，永不入库） | `local.properties`、`keystore.properties`、`*.keystore`、`app/src/main/assets/public/`、`android/.gradle/`、`app/build/` | 一律 `git checkout -- <file>` 用远端/本地生成版，**不手动解冲突** |

### 1.2 冲突处置步骤
1. `git status` → 看哪些 `android/` 文件冲突。
2. 机相关文件：`git checkout -- android/<file>`（或本地 `cap copy` 重新生成），不碰。
3. 受管文件冲突：必须人工核对，重点查两处——
   - `app/build.gradle` 的签名块（`keystoreProps`）是否完整；
   - `versionCode` / `versionName` 是否被人手改（手改会被 CI 的 stamp 步骤覆盖，但若改了基线须同步）。
4. 解完跑 `npm run check:android`；若报 drift，**有意**改了配置 → 先 `npm run bless:android` 重建基线再提交（见 §2 与下方 ⚠️）。

### 1.3 防回归
- CI Step 6 `check-android-config` 会在「本地改了 build.gradle 却没更新基线」时红，自动拦下这类提交。
- ⚠️ `--bless` 会**覆盖**基线，等于承认「新配置即新真相」。必须是你确实改了构建配置、且本地已真机/构建验证过，才 bless；禁止用 bless 掩盖「CI 红了随手重建基线」。

---

## 2. 版本回滚预案

**场景**：发版后发现严重 bug（签名错位、R8 干掉 WebView 桥接、相册权限漏、包内版本与 tag 错位）。

### 2.1 定位上一个稳定 Release
- GitHub Releases 列表按 tag 逆序；**稳定判据** = 上一次「CI 全绿 + 证书指纹 == `signing.lock` + APK 内版本 == tag」的包。

### 2.2 代码回滚（保守，默认）
- `git revert <bad-commit>` 或 `git checkout <last-good-tag> -- .`。
- ⚠️ **禁止 `git reset --hard` 强推 main**：会丢掉他人历史、破坏已发 Release 的溯源，且已分发出去的包无法召回。

### 2.3 配置基线回滚
- 若坏版本动过 `build.gradle`，必须同步：`git checkout <last-good-tag> -- android/build-config.lock.json`，否则 `check-android-config` 会红、新包出不了。
- 证书未换 → `signing.lock` 不动。

### 2.4 重发
- 在修正后的 commit 上重新打 **正确版本号** 的 tag（tag 必须 == `index.html` 的 `APP_VERSION`，CI Step 22 会拦错位）。
- App 内更新走固定名 `zhenxuji-latest.apk`（`releases/latest/download/`），重发 Release 即自动指向回滚包。

### 2.5 用户侧影响
- 回滚包**证书不变**（signing.lock 不变）→ 老用户覆盖安装成功，本地 IndexedDB/相册缓存保留，无感知。
- 只有「换了 keystore」才需用户卸载重装（见 §5）。

---

## 3. 仓库膨胀预案

**场景**：`android/` 入库后体积增长（gradle 缓存、build 产物、误提交大文件）拖慢 clone / CI。

### 3.1 已有防护（.gitignore）
已排除：`android/app/build/`、`*.keystore`、`local.properties`、`keystore.properties`、`assets/public/`、`captures/`、`android/.gradle/`。keystore 经 secret 传入，**绝不入库**。

### 3.2 监控（定期跑）
```bash
git rev-list --objects --all \
 | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
 | awk '/^blob/ {print $3, $4}' | sort -rn | head -20
```
- 若 `android/` 单文件 > 5MB 且非预期（如误提交的 aar/jar/so），报警并处置。

### 3.3 误提交大文件处置（破坏性，需用户确认）
1. 先备份仓库（`git bundle create backup.bundle --all`）。
2. `git filter-repo` 或 BFG 清除该文件的历史。
3. 清除后**必强推并通知所有协作者重新 clone**（历史改写，旧 clone 会冲突）。

### 3.4 gradle 缓存不入库
- CI 用 `actions/setup-java` + gradle 自带缓存（`~/.gradle/caches`），不写入仓库。
- 本地 `android/.gradle/` 已在 gitignore。

### 3.5 长期（默认不启用）
- 若 `android/` 持续膨胀（原生依赖升级带来大 aar），才评估「只入库差异补丁 + CI `cap add` 重建 + 补丁叠加」回退方案。
- ⚠️ 该方案会**重新引入方案 A 已消除的「两套构建配置」风险**，需权衡，默认不动。

---

## 4. CI 失败分类速查（P2 附加）

| 红在 | 含义 | 本地复现 / 处置 |
|---|---|---|
| Step 4 `verify-llm.js` | LLM 路由逻辑回归 | `node worker/verify-llm.js`（无 key 跑逻辑段） |
| Step 5 `check-worker-env` | 源码有裸 `process` 访问（线上会 500） | `node scripts/check-worker-env.mjs`，按报行修（用 `typeof process` 防御式写法） |
| Step 6 `check-android-config` | 构建配置漂移 | `node scripts/check-android-config.mjs`；有意改配置先 `npm run bless:android` |
| Step 7 `check:theme` | 主题配置改了没重生成 CSS | `npm run build:theme && npm run check:theme` |
| Step 16 `Restore keystore` | Secret 缺失/口令错 | 去 Settings→Secrets 配 `KEYSTORE_B64`/`KEYSTORE_PASSWORD`/`KEY_ALIAS`/`KEY_PASSWORD` |
| Step 18 `Build APK` | gradle 编译错 | 本地 `cd android && ./gradlew assembleRelease` 看 gradle-tail |
| Step 21 `fingerprint` | 证书与 `signing.lock` 不一致 | 用错 keystore / 真换证书须同步 `signing.lock` |
| Step 22 `tag 一致` | tag 与包内版本错位 | 先同步升 `index.html` 的 `APP_VERSION` 再打 tag |

---

## 5. 凭据与轮换（安全红线）

- 任何**明文出现**的 PAT / Cloudflare Token / 模型 key / keystore 口令，**一律视为已泄露**，立即到对应平台轮换。
- `KEYSTORE_B64` / 口令 / alias **只存 GitHub Secrets**，不进仓库、不进聊天、不进 OB。
- 轮换 keystore 后：更新 `KEYSTORE_B64` + 同步 `android/signing.lock` 新指纹 + **通知用户「新版本需卸载重装」**（证书变了无法覆盖装）。
- 本预案与所有基线文件（`build-config.lock.json` / `signing.lock`）本身不含任何密钥，可安全入库。
