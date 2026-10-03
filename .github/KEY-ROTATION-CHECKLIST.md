# 帧叙集 · 密钥全套轮换操作清单（P0 安全红线）

> 背景：PAT / Cloudflare Token / 4 把模型 Key / keystore 口令曾在对话中明文出现，**判定全部泄露**，
> 必须一次性轮换、旧的全部作废。本清单交给执行人逐步操作。**任何密钥值禁止写进本文件或任何对话。**
> 最后更新：2026-10-03

---

## 0. 总览：凭证 → 所属平台 → 去哪更新 → 影响范围

| 凭证 | 所属平台 | 更新位置 | 落点（secret 名） | 影响 |
|---|---|---|---|---|
| GitHub PAT | GitHub | GitHub Settings → Developer settings → PAT | 仅本机 git 凭据（CI 用 `GITHUB_TOKEN`，不依赖 PAT） | 本机 `git push` |
| Cloudflare API Token | Cloudflare | Dashboard → My Profile → API Tokens | 仅本机 `wrangler deploy`（CF_API_TOKEN） | Worker / Pages 部署 |
| `GLM_KEY_53` | OpenRouter | OpenRouter Dashboard → Keys | **Cloudflare Worker secret** `zhenxuji-api` | GLM-5.3-Flash（优先档） |
| `SN_KEY` | 商汤 SenseNova | SenseNova 控制台 → API Key | **Cloudflare Worker secret** | deepseek-v4-flash |
| `AG_KEY` | Agnes AI Hub | Agnes 控制台 → API Key | **Cloudflare Worker secret** | agnes-2.5-flash |
| `GLM_KEY_4F` | 智谱开放平台 | 智谱控制台 → API Key | **Cloudflare Worker secret** | GLM-4-Flash（兜底档） |
| keystore 口令 | 本地 keystore 文件 | `keytool -storepasswd` / `-keypasswd` | GitHub Actions `KEYSTORE_*` | APK 签名 |

> 🔴 **关键纠正**：4 把**模型 Key 是 Cloudflare Worker 的 secret，不是 GitHub Actions secret**。
> 只有 `KEYSTORE_*` 那 4 个才是 GitHub Actions 的。混了会导致"更新了错误的 secret"。

---

## 1. GitHub PAT（本机 push 用）
1. 登录 GitHub → Settings → Developer settings → Personal access tokens → 找到旧 token → **Revoke**（作废）。
2. 新建 token（勾选 `repo` + `workflow` 权限）→ 复制新值。
3. 更新本机凭据：`git credential reject` / 凭据管理器里把旧 PAT 换成新的（或 `git remote set-url` 直带新 token 推一次后清掉）。
4. 验证：`git push origin HEAD` 成功。

## 2. Cloudflare API Token（部署用）
1. Cloudflare Dashboard → My Profile → API Tokens → 找到旧 token → **Delete**（作废）。
2. 新建 Token（Edit Cloudflare Workers 模板，含 `Account:Workers Scripts:Edit` + `Account:Account Settings:Read`）→ 复制。
3. 本机：`export CF_API_TOKEN=<新值>`（或写进 `~/.cloudflare/credentials` / 环境变量）。
4. 验证：`cd worker && npx wrangler whoami` 成功。

## 3. 4 把模型 Key（Cloudflare Worker secret）
> 分别在各自平台的控制台重新生成，**先在新平台测通再写进 Worker secret**，避免写了坏值线上全哑火。
1. `GLM_KEY_53`（OpenRouter）：OpenRouter Dashboard → Keys → 新建 → `cd worker && npx wrangler secret put GLM_KEY_53`。
2. `SN_KEY`（商汤 SenseNova）：SenseNova 控制台 → 新建 API Key → `npx wrangler secret put SN_KEY`。
3. `AG_KEY`（Agnes AI Hub）：Agnes 控制台 → 新建 → `npx wrangler secret put AG_KEY`。
4. `GLM_KEY_4F`（智谱开放平台）：智谱控制台 → 新建 → `npx wrangler secret put GLM_KEY_4F`。
5. **逐个验证**：`cd worker && node probe-multi.cjs`（四家各打一次，确认 200）。
6. 部署：`cd worker && npx wrangler deploy`（Worker 名 `zhenxuji-api`，KV 绑定已在 `wrangler.toml` 里，不会丢）。

## 4. keystore 口令（换口令不换证书 → 覆盖安装不受影响）
> ⚠️ 只换**口令**（store + key password），**不要换新密钥对**，否则签名证书变 → 老用户无法覆盖安装。
1. 取出现有 keystore（本地那份，或 `base64 -d` 解开 `KEYSTORE_B64`）。
2. 改 store 口令：`keytool -storepasswd -keystore zhenxuji-release.jks`（按提示输旧口令、设新口令）。
3. 改 key 口令：`keytool -keypasswd -alias <别名> -keystore zhenxuji-release.jks`（旧 key 口令→新 key 口令）。
4. 重新编码：`base64 -w0 zhenxuji-release.jks > keystore.b64`。
5. 更新 GitHub Actions Secrets：`KEYSTORE_B64`（新 b64）、`KEYSTORE_PASSWORD`（新 store 口令）、
   `KEY_ALIAS`（不变）、`KEY_PASSWORD`（新 key 口令）。
6. 验证：见 §5 的 CI 复验。

## 5. 轮换后验证（必做，风险预案 §5）
1. **模型 Key**：`cd worker && node probe-multi.cjs` 四家全 200；`wrangler deploy` 后打一次 `/api/llm` 真请求。
2. **KEYSTORE_\***：在 GitHub 手动触发 `workflow_dispatch`（release）→ 确认：
   - Step 16 `Restore fixed keystore` 成功（新口令能解开）；
   - Step 21 `签名证书与基线一致 ✓`（证书没变，因为只是换口令）。
3. **PAT / CF Token**：本机 `git push` + `wrangler deploy` 均成功。

## 6. 红线（违反即重来）
- 任何密钥值**不得**写进对话、代码、文档正文（本清单只用占位与变量名）。
- 旧密钥**必须**先作废（revoke/delete）再启用新的，不留并行可用的旧密钥。
- 轮换完成前，CI 绝不能合入依赖新密钥的代码。
