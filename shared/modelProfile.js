// 模型分级配置（单一数据源，前后端共用）
//
// 目的（用户需求）：**云端模型按各家的云端配置、本地模型按参数量分档配置**，
// 让知识库检索与上下文注入的规模与模型能力匹配，从而拿到最优回答质量。
//
// 为什么不能"一个参数走天下"：
//  - 云端大模型（128k~256k 窗口、几十 B 参数）能吃下大量正文，注入越多召回越全；
//  - 本地 Ollama 是纯 CPU 推理的小模型（1.5B/3B/7B）。把 2~5 万字符的知识上下文灌给 1.5B，
//    注意力会被稀释、关键 SQL 页被界面 JSON 噪声淹没，既答不准又拖慢预填。
//    小模型必须"少而准"：窗口收紧、topK 收紧、单页字符收紧，只留高相关片段。
//
// 因此本模块输出一份「检索预算档案」（kb profile），语义如下：
//   contextWindow —— 该模型真实/安全的上下文窗口（token），仅作硬上限用
//   limit         —— 本次最多注入多少**字符**的知识上下文（质量优先的推荐值，非上限）
//   topK          —— 服务端倒排索引一次取回多少命中页
//   perHitChars   —— 单条命中页正文最多带多少字符
//   perDocBudget  —— 单篇文档最多注入多少字符
//   objectRows    —— 「对象索引」最多列多少行（对象编号/描述/类型）
//   structChars   —— 界面/流程类页（STRACTURE / WIND_ELEMENT 大 JSON）单页裁剪上限
//   kind / tier   —— 云端 or 本地；本地所属参数量档位

/** 本地模型参数量档位：按 maxParams（十亿参数）升序匹配，取第一个 >= 实际参数量的档 */
export const LOCAL_TIERS = [
  {
    id: 'tiny',
    label: '≤2B（1.5B 等）',
    maxParams: 2,
    contextWindow: 8192,
    limit: 6000,
    topK: 8,
    perHitChars: 2500,
    perDocBudget: 2200,
    objectRows: 12,
    structChars: 500,
  },
  {
    id: 'small',
    label: '2B~4.5B（3B 等）',
    maxParams: 4.5,
    contextWindow: 16384,
    limit: 12000,
    topK: 12,
    perHitChars: 4000,
    perDocBudget: 4000,
    objectRows: 20,
    structChars: 800,
  },
  {
    id: 'medium',
    label: '4.5B~14B（7B/8B 等）',
    maxParams: 14,
    contextWindow: 32768,
    limit: 26000,
    topK: 20,
    perHitChars: 6000,
    perDocBudget: 7000,
    objectRows: 36,
    structChars: 1200,
  },
  {
    id: 'large',
    label: '>14B（32B 等）',
    maxParams: Infinity,
    contextWindow: 65536,
    limit: 52000,
    topK: 30,
    perHitChars: 8000,
    perDocBudget: 12000,
    objectRows: 48,
    structChars: 1800,
  },
]

/**
 * 云端模型的调参档：窗口按各家实际配置（providers.js 的 contextWindow，可被单模型覆盖），
 * 注入规模取窗口的 80%（封顶 160000 字符），检索参数给足以便大模型吃满召回。
 */
export const CLOUD_TUNING = {
  limitRatio: 0.8,
  /** 云端窗口很大时也无需无限注入：160000 字符已远超单次问答的有效信息量 */
  limitCap: 160000,
  topK: 30,
  perHitChars: 9000,
  perDocBudget: 16000,
  objectRows: 60,
  structChars: 2500,
}

/** 本地模型未标明参数量时的兜底档位（宁可保守，避免把大上下文灌给小模型） */
const LOCAL_FALLBACK_PARAMS = 3

/**
 * 本地 Ollama 服务的**实际可用上下文（token）**。
 *
 * 为什么必须有这个值：Ollama 的 OpenAI 兼容端点（/v1/chat/completions）**不接受 num_ctx**，
 * 它按服务端默认值（OLLAMA_CONTEXT_LENGTH，缺省 4096）截断/拒绝请求；实测超过时会直接返回
 * HTTP 400 `exceed_context_size_error`（例：5877 tokens > 4096），模型根本不会跑。
 * 因此本地模型的注入预算必须先被这个值卡住，否则再"精细"的档位也会整请求失败。
 *
 * ⚠️ 本值必须与宿主机 Ollama 的 OLLAMA_CONTEXT_LENGTH 保持一致；
 *    改宿主机配置时要同步改这里（见 DEPLOY.md「本地模型上下文」一节）。
 */
export const OLLAMA_SAFE_CTX_TOKENS = 8192
/** 中英混合文本的粗略 chars/token 换算（标识符密集的 XML/SQL 偏 ASCII，约 2~2.5） */
const CHARS_PER_TOKEN = 2.2
/** 预留：系统提示词 + 对话历史 + 模型输出，避免把窗口占满导致回复被截断 */
const LOCAL_PROMPT_OVERHEAD_CHARS = 2500
/** 本地模型单次可注入的知识上下文硬上限（字符） */
export const LOCAL_LIMIT_CAP = Math.max(
  2000,
  Math.floor(OLLAMA_SAFE_CTX_TOKENS * CHARS_PER_TOKEN - LOCAL_PROMPT_OVERHEAD_CHARS)
)

/**
 * 从模型 ID 解析参数量（单位：十亿）。
 * 兼容 `deepseek-r1:1.5b` / `qwen2.5:7b-instruct` / `llama3:8b` / `gemma2:27b` 等写法。
 * 注意必须排除 `qwen2.5` / `qwen3` 这类**版本号**：只认紧跟数字的 `b`（且前面是数字/点）。
 * @returns 参数量（如 1.5 / 7），无法识别时返回 null
 */
export function parseParamBillions(modelId) {
  const s = String(modelId || '')
  if (!s) return null
  // 优先取标签尾部（`:` 或 `-` 之后）的 `数字+b`，如 `qwen2.5:7b-instruct` → 7b
  const tailMatches = [...s.matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/gi)]
  if (tailMatches.length === 0) return null
  // 取最后一个：`qwen2.5:7b-instruct` 里 `2.5b` 不会出现（2.5 后面不是 b），
  // 若出现多个（如 `moonshot-v1-8k` 无 b），仍以最后一段为准更贴近实际模型规模。
  const n = parseFloat(tailMatches[tailMatches.length - 1][1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 解析本地模型所属档位 */
export function localTierOf(modelId) {
  const params = parseParamBillions(modelId)
  const p = params === null ? LOCAL_FALLBACK_PARAMS : params
  return LOCAL_TIERS.find(t => p <= t.maxParams) || LOCAL_TIERS[LOCAL_TIERS.length - 1]
}

/**
 * 组装本次请求使用的检索预算档案。
 *
 * @param {object} p
 * @param {string} p.providerId           提供商 id（'ollama' 为本地）
 * @param {string} [p.modelId]            实际使用的模型 id
 * @param {object} [p.provider]           提供商配置对象（含 contextWindow / models）
 * @returns {{kind:'cloud'|'local', tier:string, tierLabel:string, params:number|null,
 *            contextWindow:number, limit:number, topK:number, perHitChars:number,
 *            perDocBudget:number, objectRows:number, structChars:number}}
 */
export function resolveModelProfile({ providerId, modelId, provider } = {}) {
  const p = provider || {}
  const isLocal = providerId === 'ollama' || p.noApiKey === true
  const models = Array.isArray(p.models) ? p.models : []
  const modelEntry = models.find(m => m && m.id === modelId) || null
  // 单模型窗口优先于提供商窗口（如 moonshot-v1-8k 与 v1-128k 同属一个提供商）
  const declaredWindow = Number(modelEntry && modelEntry.contextWindow) || Number(p.contextWindow) || 0

  if (isLocal) {
    const tier = localTierOf(modelId || p.defaultModel)
    return {
      kind: 'local',
      tier: tier.id,
      tierLabel: tier.label,
      params: parseParamBillions(modelId || p.defaultModel),
      // 档位窗口是「质量最优的有效窗口」；若模型自身声明更小则取更小者
      contextWindow: declaredWindow ? Math.min(declaredWindow, tier.contextWindow) : tier.contextWindow,
      // 参数量档位决定"想要多少"，Ollama 实际 num_ctx 决定"最多能给多少"，取小者
      limit: Math.min(tier.limit, LOCAL_LIMIT_CAP),
      topK: tier.topK,
      perHitChars: tier.perHitChars,
      perDocBudget: tier.perDocBudget,
      objectRows: tier.objectRows,
      structChars: tier.structChars,
    }
  }

  const contextWindow = declaredWindow || 65536
  return {
    kind: 'cloud',
    tier: 'cloud',
    tierLabel: '云端',
    params: null,
    contextWindow,
    limit: Math.min(CLOUD_TUNING.limitCap, Math.round(contextWindow * CLOUD_TUNING.limitRatio)),
    topK: CLOUD_TUNING.topK,
    perHitChars: CLOUD_TUNING.perHitChars,
    perDocBudget: CLOUD_TUNING.perDocBudget,
    objectRows: CLOUD_TUNING.objectRows,
    structChars: CLOUD_TUNING.structChars,
  }
}

/** 是否在问 SQL 类问题（决定是否给 query.sql 页提权、是否只保留 SQL 语句正文） */
const SQL_INTENT_RE = /\bsql\b|select\s|查询语句|sql语句|语句|脚本|怎么写|如何查|怎么查/i

export function hasSqlIntent(text) {
  return SQL_INTENT_RE.test(String(text || ''))
}
