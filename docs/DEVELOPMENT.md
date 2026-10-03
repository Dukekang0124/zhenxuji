# 帧叙集 · 开发协作规范

> 配套：`.github/RISK-PLAN.md`（应急预案）、`.github/KEY-ROTATION-CHECKLIST.md`（密钥轮换）。
> 最后更新：2026-10-03（决策文档《帧叙集｜当前阶段最优决策 + 执行任务》落地）

---

## §1 分支模型（强制）

- **`main` 受保护，禁止直接推送**。所有新增功能、Android 原生配置修改，一律：
  1. 从 `main` 拉 `feature/<简短描述>` 分支；
  2. 开发 + 自测；
  3. 提 **PR** → 人工评审 → 合并 `main`。
- **历史说明**：方案 A（android/ 入库 + CI 改造 + 测试矩阵闸门 + 指纹锚点）全部改动已在 `main`
  （`7acdb3b..d449c09`），属一次性例外。**不做 `git reset` 历史改写、不回退 main**——
  改写在公共 main 的提交历史风险极高（多人代码丢失、仓库错乱），收益不抵风险。
- 合并方式：squash 或 merge 均可，但 PR 描述须写清"动了什么 / 为什么"。

## §2 Android 改动门禁（强制）

- **Android 目录改动必须单独 PR**，禁止与普通业务改动混入同一 PR。
- 自动门禁：`.github/workflows/pr-android-guard.yml` —— PR 若改了 `android/` 源码/配置，
  自动打 `android-change` 标签 + 评论 + **失败本检查（默认阻断合并）**，逼出人工评审。
  - 基线/产物不触发：`android/**/build/`、`local.properties`、`keystore.properties`、`*.jks`、`assets/public`。
- 强化（需手动在 GitHub 开启）：Settings → Branches → 保护 `main` → 勾选
  **Require review from Code Owners**（配合本仓库 `.github/CODEOWNERS`，见下）。
- `.github/CODEOWNERS`：`/android/`、`*.gradle`、`gradlew`、`android.keystore.properties`
  归 `@Dukekang0124` 所有 —— 仅"请求 review"，**必须配合上面的分支保护**才变"强制"。

## §3 决策记录（2026-10-03）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 分支问题 | **不回退 main**（不 reset/强推），后续严格 feature+PR；Android 改动单独 PR + 强制评审 |
| 2 | 旧 `worker/` 目录 | 备份后删除 `D:\写作工具\知识管理\01-Projects-项目\求职与作品集\03-作品集\帧叙集\worker`（源码已双份保全） |
| 3 | 凭证轮换 | **P0 红线**：PAT / CF Token / 4 把模型 Key / keystore 口令一律轮换，旧的全部作废 |
| 4 | 真机 + 主题 | 修 `adb devices` 连通性搭真机冒烟；品牌/二级色压深 5~7% 定稿后重包 |

## §4 密钥管理红线（零明文）

- **任何密钥（PAT / CF Token / 模型 Key / keystore 口令）严禁出现在对话、代码、文档正文。**
- 密钥落点分两类，不要混：
  - **GitHub Actions Secrets**（仅 4 个签名相关）：`KEYSTORE_B64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`。
  - **Cloudflare Worker Secrets**（`zhenxuji-api`，`cd worker && npx wrangler secret put <名>`）：
    `GLM_KEY_53`(OpenRouter) / `SN_KEY`(商汤) / `AG_KEY`(Agnes) / `GLM_KEY_4F`(智谱)。
  - 本地 `wrangler deploy` 用 CF Token；本地 `git push` 用 GitHub PAT——均只在你本机凭据里，不进仓库。
- 轮换步骤见 `.github/KEY-ROTATION-CHECKLIST.md`。

## §5 CI 验证纪律

- **任何 CI 步骤落成后必须真触发一次**（`push tag v*` 或 `workflow_dispatch`），静态检查全过 ≠ 真跑全过。
  （教训：方案 A 指纹锚点代码此前从未真跑，真跑才暴露 apksigner/secret 三连坑。）
- 改动密钥/keystore 后，必须立刻在 CI 跑一次 release 构建验证（见风险预案 §5）。
