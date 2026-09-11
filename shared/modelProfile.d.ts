// 与 modelProfile.js 配套的类型声明，供 TypeScript 在前端导入时解析类型。
// modelProfile.js 为运行时单一数据源（前后端共用），此处仅提供类型，不参与打包。

/** 本地模型参数量档位 */
export interface LocalTier {
  id: string
  label: string
  maxParams: number
  contextWindow: number
  limit: number
  topK: number
  perHitChars: number
  perDocBudget: number
  objectRows: number
  structChars: number
}

export declare const LOCAL_TIERS: LocalTier[]

export interface CloudTuning {
  limitRatio: number
  limitCap: number
  topK: number
  perHitChars: number
  perDocBudget: number
  objectRows: number
  structChars: number
}

export declare const CLOUD_TUNING: CloudTuning

/** 本地 Ollama 服务的实际可用上下文（token），须与宿主机 OLLAMA_CONTEXT_LENGTH 一致 */
export declare const OLLAMA_SAFE_CTX_TOKENS: number
/** 本地模型单次可注入的知识上下文硬上限（字符） */
export declare const LOCAL_LIMIT_CAP: number

/** 从模型 ID 解析参数量（单位：十亿）；无法识别时返回 null */
export declare function parseParamBillions(modelId?: string | null): number | null

/** 解析本地模型所属档位 */
export declare function localTierOf(modelId?: string | null): LocalTier

/** 本次请求使用的检索预算档案 */
export interface ModelProfile {
  kind: 'cloud' | 'local'
  tier: string
  tierLabel: string
  params: number | null
  contextWindow: number
  limit: number
  topK: number
  perHitChars: number
  perDocBudget: number
  objectRows: number
  structChars: number
}

export interface ResolveModelProfileParams {
  providerId?: string
  modelId?: string
  provider?: {
    contextWindow?: number
    noApiKey?: boolean
    defaultModel?: string
    models?: Array<{ id: string; contextWindow?: number }>
  } | null
}

export declare function resolveModelProfile(p?: ResolveModelProfileParams): ModelProfile

/** 是否在问 SQL 类问题 */
export declare function hasSqlIntent(text?: string | null): boolean
