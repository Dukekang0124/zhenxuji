/**
 * llm.config.js — 帧叙集 · 模型结构配置（唯一真相源）
 *
 * 为什么是 .js 而不是 .json：Node 22 的 JSON import 需要 `with { type: 'json' }` 断言，
 * 而 Cloudflare Workers 不需要 —— 用 .json 会导致「本地跑不了单测」。
 * 用 .js 两端都能直接 import，配置换整份而代码零改动的目标不变。
 *
 * 🔴 密钥不在这里。密钥只在 env（GLM_KEY_53 / SN_KEY / AG_KEY / GLM_KEY_4F）。
 *
 * ============================================================================
 * 2026-10-03 重大改造：单厂商 → **四家异构厂商**
 * ============================================================================
 * 需求：依次从 GLM-5.3-Flash 优先，最后 GLM-4-Flash 兜底。
 *
 * 🔴 但这四个名字**不是同一个平台的模型**。探针实测（worker/probe-multi.cjs）：
 *
 * | # | 模型名              | 厂商           | 端点                                  | 实测 |
 * |---|--------------------|---------------|---------------------------------------|------|
 * | 1 | GLM-5.3-Flash      | OpenRouter    | https://openrouter.ai/api/v1          | ✅ 200，**思考模型** |
 * | 2 | deepseek-v4-flash  | 商汤 SenseNova | https://token.sensenova.cn/v1         | ✅ 200，1777ms |
 * | 3 | agnes-2.5-flash    | Agnes AI Hub  | https://apihub.agnes-ai.com/v1        | ✅ 200，2334ms |
 * | 4 | GLM-4-Flash        | 智谱开放平台    | https://open.bigmodel.cn/api/paas/v4  | ✅ 200，892ms（最快） |
 *
 * 所以「一条链」实际上是**跨四家厂商的链**，必须先有 provider 层，
 * 否则「换模型」=「改代码」，配置驱动直接失效。
 *
 * 三条实测得出的硬约束（每条都对应一个会静默出错的地方）：
 *
 * 1. 🔴 **K1 是思考模型，内容不在常规字段里**。
 *    实测 max_tokens=64 时：`content=null`、`finish_reason=length`、
 *    `completion_tokens_details.reasoning_tokens=63` —— 64 个 token 全被推理吃掉，
 *    正文一个字都没轮到。**如果只读 choices[0].message.content，这一档永远返回空**，
 *    而它恰恰是优先级最高的那一档 → 表现为「每次都降级、GLM-5.3 形同不存在」。
 *    解法：`reasoningFallback: true`（content 为空就回退读 reasoning）
 *    + 该档基础 maxTokens **按倍率放大**（思考也要预算，否则永远 length 截断）。
 *
 * 2. 🔴 **四家的 max_tokens 语义不同**。智谱/商汤是「输出上限」，OpenRouter 对
 *    思考模型还会另算 reasoning budget。所以 maxTokens 不能全局写死一个数，
 *    必须允许**按模型倍率**放大（maxTokensScale）。
 *
 * 3. 🔴 **错误码体系各不同**：OpenRouter 用 `error.type` + 顶层 `error.code`(数字)，
 *    智谱用数字 `error.code`(1113/1305/1211)，商汤/Agnes 走标准 HTTP 状态码。
 *    vendorCodes 表必须**带 provider 前缀**，否则 '429' 这类通用码会互相覆盖。
 */

export default {
  defaults: {
    timeoutMs: 15000,
    temperature: 0.7,
    maxTokens: 900,
    attempts: 2,
    backoffMs: 300,
  },

  /**
   * 四家厂商。每家三个必须字段：
   *   endpoint  —— 完整的 chat/completions 地址
   *   keyEnvs   —— 按顺序找**第一个非空**的密钥环境变量名（支持同厂商多把 key 轮换）
   *   headers   —— 该厂商特有的必需请求头（OpenRouter 的 Referer/Title 属于此类）
   */
  providers: {
    openrouter: {
      label: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      enabled: true,
      keyEnvs: ['GLM_KEY_53'],
      // 🔴 OpenRouter 要求带 Referer/X-Title 才计入正常配额并出现在排行榜；
      //    缺了不报错，但会被限流得更狠 —— 属于「不写也能跑、跑了会慢慢出问题」的那类
      headers: {
        'HTTP-Referer': 'https://zhenxuji.pages.dev',
        'X-Title': 'ZhenXuJi',
      },
    },
    sensenova: {
      label: '商汤 SenseNova',
      endpoint: 'https://token.sensenova.cn/v1/chat/completions',
      enabled: true,
      keyEnvs: ['SN_KEY'],
    },
    agnes: {
      label: 'Agnes AI Hub',
      endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions',
      enabled: true,
      keyEnvs: ['AG_KEY'],
    },
    zhipu: {
      label: '智谱开放平台',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      enabled: true,
      keyEnvs: ['GLM_KEY_4F'],
    },
  },

  models: {
    'GLM-5.3-Flash': {
      provider: 'openrouter',
      enabled: true,
      // 🔴 思考模型给 4s 必然超时；实测 1677ms 返回但推理被 max_tokens 截断，
      //    真正的止损交给 maxTokensScale + reasoningFallback，超时给足。
      timeoutMs: 25000,
      temperature: 0.7,
      // 思考要额外预算：基础 900 → 2700，否则 reasoning 吃光后正文为空
      maxTokensScale: 3,
      // 🔴 content 为空时回退读 reasoning（实测该档就是这种情况）
      reasoningFallback: true,
      note: '实测 200 OK（走 OpenRouter，上游 provider=StreamLake，回包 model=z-ai/glm-5.3-flash）。**思考模型**：max_tokens 不够时 content=null、内容全在 reasoning 里。',
    },
    'deepseek-v4-flash': {
      provider: 'sensenova',
      enabled: true,
      timeoutMs: 20000,
      temperature: 0.7,
      // 商汤这个模型也带 reasoning_content（实测 14 个 reasoning token），同样给余量
      maxTokensScale: 2,
      reasoningFallback: true,
      note: '实测 200 OK，1777ms，content 正常返回「可用」，另有 reasoning_content。',
    },
    'agnes-2.5-flash': {
      provider: 'agnes',
      enabled: true,
      timeoutMs: 20000,
      temperature: 0.7,
      maxTokensScale: 2,
      note: '实测 200 OK，2334ms，标准 OpenAI 格式。',
    },
    'GLM-4-Flash': {
      provider: 'zhipu',
      enabled: true,
      timeoutMs: 12000,
      temperature: 0.7,
      note: '实测 200 OK，892ms，四家里**最快**。返回形态无 reasoning，标准格式。兜底档的可靠性靠它。',
    },
  },

  /**
   * 优先级链 —— **严格保留康哥给的意图顺序**：
   *   GLM-5.3-Flash → deepseek-v4-flash → agnes-2.5-flash → GLM-4-Flash
   * 不可用的档由 resolveCandidates 在解析期剔除、或由超时在运行时降级。
   * 想让某一档临时下线（灰度/止血）改 enabled:false 即可，零代码改动。
   */
  tiers: {
    premium: ['GLM-5.3-Flash', 'deepseek-v4-flash', 'agnes-2.5-flash', 'GLM-4-Flash'],
    // 发版辅助这类一次性任务用最便宜最快的，不必占贵的档
    fast: ['GLM-4-Flash', 'agnes-2.5-flash'],
  },

  modules: {
    story: { tier: 'premium', note: '手记文案：封面标题 / 配图短句 / 朋友圈正文 / 互动钩子' },
    analysis: { tier: 'premium', note: '场景与内容结构化分析（核心分析类）' },
    changelog: { tier: 'fast', note: '发版工具：技术改动 → 用户可读的更新日志' },
    default: { tier: 'premium' },
  },

  /**
   * 厂商私有码 → 通用语义码。
   * 🔴 键带 provider 前缀（如 'openrouter:402'）—— 不同厂商的同一个数字含义完全不同，
   *    不加前缀会互相覆盖，制造极难排查的错判。归一函数按
   *    「provider:code」→「code」两级顺序查。
   */
  vendorCodes: {
    // 智谱（数字码）
    '1113': 'quota_exhausted',
    '1305': 'rate_limited',
    '1211': 'model_not_found',
    '1214': 'param_error',
    '401': 'auth_failed',
    '429': 'rate_limited',
    // OpenRouter（402 = 余额/额度，403 = 内容审核拦截，408 超时，429/502/503 各有语义）
    'openrouter:402': 'quota_exhausted',
    'openrouter:403': 'content_filtered',
    'openrouter:408': 'timeout',
    'openrouter:429': 'rate_limited',
    'openrouter:502': 'http_5xx',
    'openrouter:503': 'http_5xx',
    'sensenova:429': 'rate_limited',
    'agnes:429': 'rate_limited',
  },

  // 命中这些码 → 换下一档
  degradeOn: [
    'quota_exhausted', 'rate_limited', 'model_not_found', 'auth_failed',
    'param_error', 'timeout', 'http_5xx', 'http_4xx', 'network', 'empty_response',
    'content_filtered',
  ],

  // 只有瞬时故障才在同一模型上重试；其余重试一百次结果一样，纯属白等
  retry: {
    onlyCodes: ['rate_limited', 'http_429', 'http_5xx', 'timeout', 'network', 'abort'],
    maxAttempts: 2,
    backoffMs: 300,
  },

  logging: { keepDays: 7, writeUserText: false },
};
