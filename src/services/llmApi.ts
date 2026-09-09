/**
 * LLM API 服务 - 统一经后端代理转发（前端不再直连模型 API）
 * 支持 DeepSeek、通义千问、智谱GLM、月之暗面(Kimi)、豆包、百川等（云端模型经后端转发）
 * 以及本地 Ollama（由后端 /api/chat、/api/chat-once 代理到本机 Ollama）
 * API Key 和选择的模型提供商存储在 localStorage
 * 问答与 API Key 测试均只走后端，二者结果保持一致
 */

import { BACKEND_BASE as BACKEND_URL } from './backend'
import { SYSTEM_PROMPT } from '../../shared/systemPrompt.js'
const KEY_STORAGE = 'ai_api_key'
const PROVIDER_STORAGE = 'ai_provider_id'
// 自定义模型 ID 按「提供商」隔离存储（见 customModelKey）。
// 避免 A 提供商设的自定义模型（如混元 hy3）泄漏到 B 提供商（如智谱 GLM），
// 导致「选了智谱 GLM 却实际用混元模型去打智谱端点」的错配（用户反馈「智谱 GLM 为什么和混元相关」）。

// ===== 带超时的 fetch：根治 LLM 请求无限挂起（批量上传时多份文档并发直连，厂商限流/网络抖动会让请求永久 pending → "AI解析中卡死"） =====
// 仅约束「连接 + 首字节」阶段（fetch 在收到响应头即 settle，长回复的流式传输不受此限制），避免把正常的长生成误杀；
// 同时保证提供商连接挂起时最多 30s 即报错，而不是永久卡在「正在分析中」。
const LLM_TIMEOUT_MS = 30000
export function fetchWithTimeout(url: string, options?: RequestInit, ms: number = LLM_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

// ===== 模型提供商配置 =====

export interface LlmProvider {
  id: string
  name: string
  apiUrl: string
  models: { id: string; name: string }[]
  defaultModel: string
  keyPlaceholder: string
  keyUrl: string
  keyLabel: string
  /** 上下文窗口大小（token 数），用于计算知识库注入上限，避免超窗报错 */
  contextWindow?: number
  /** 是否支持 temperature/top_p 采样参数（推理模型通常不支持） */
  supportsSampling?: boolean
  /** 是否需要在接口 URL 上额外携带 GroupId（如 MiniMax chatcompletion_v2 要求 ?GroupId=xxx） */
  groupRequired?: boolean
  groupLabel?: string
  groupPlaceholder?: string
  /** 是否为本地模型：无需真实 API Key，调用时不携带有效凭证 */
  noApiKey?: boolean
}

import { PROVIDER_LIST } from '../../shared/providers.js'

// 提供商配置统一来自 shared/providers.js（与后端共用同一份，避免两端漂移，见 I1）
export const LLM_PROVIDERS: LlmProvider[] = PROVIDER_LIST as LlmProvider[]


export type LlmStatus = 'no-key' | 'ready' | 'error'

export interface ChatMessageDto {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface StreamCallbacks {
  onThinking?: (text: string) => void
  onContent: (text: string) => void
  onError: (error: string) => void
  onDone: () => void
}

// ===== 提供商与 API Key 管理 =====

export function getProviderId(): string {
  try {
    return localStorage.getItem(PROVIDER_STORAGE) || 'deepseek'
  } catch {
    return 'deepseek'
  }
}

export function getProvider(): LlmProvider {
  const id = getProviderId()
  return LLM_PROVIDERS.find(p => p.id === id) || LLM_PROVIDERS[0]
}

export function setProviderId(id: string): void {
  localStorage.setItem(PROVIDER_STORAGE, id)
}

// ===== 自定义模型 ID（用于使用提供商的最新模型） =====

// 自定义模型 ID 按 provider 隔离：切换 provider 后各自的自定义模型互不影响
function customModelKey(providerId?: string): string {
  const id = providerId || getProviderId()
  return `ai_custom_model_id_${id}`
}

export function getCustomModelId(providerId?: string): string {
  try {
    return (localStorage.getItem(customModelKey(providerId)) || '').trim()
  } catch {
    return ''
  }
}

export function setCustomModelId(id: string, providerId?: string): void {
  const v = (id || '').trim()
  try {
    if (v) localStorage.setItem(customModelKey(providerId), v)
    else localStorage.removeItem(customModelKey(providerId))
  } catch { /* 忽略 */ }
}

/**
 * 解析最终使用的模型 ID：
 * 1. 用户自定义模型 ID（最高优先，用于跟随提供商最新模型）
 * 2. 调用方指定的 modelId（如深度思考的推理模型）
 * 3. 提供商默认模型
 */
export function resolveModelId(modelId?: string): string {
  const custom = getCustomModelId()
  return custom || modelId || getProvider().defaultModel
}

// ===== API Key 管理（按提供商分别保存，避免“Key 属于 A 但选择器停在 B”的错配）=====

type KeyMap = Record<string, string>

// 读取全部提供商的 Key；兼容旧版本直接存明文字符串的情况（迁移到“当前提供商”名下，避免丢 Key）
function loadKeyMap(): KeyMap {
  try {
    const raw = localStorage.getItem(KEY_STORAGE)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as KeyMap
    } catch {
      // 旧格式：明文字符串 → 迁移到当前提供商
      const map: KeyMap = {}
      map[getProviderId()] = raw.trim()
      try { localStorage.setItem(KEY_STORAGE, JSON.stringify(map)) } catch { /* 忽略 */ }
      return map
    }
    return {}
  } catch {
    return {}
  }
}

function saveKeyMap(map: KeyMap): void {
  try {
    localStorage.setItem(KEY_STORAGE, JSON.stringify(map))
  } catch { /* 忽略 */ }
}

export function getApiKey(providerId?: string): string | null {
  try {
    const map = loadKeyMap()
    const id = providerId || getProviderId()
    const k = map[id]
    return typeof k === 'string' && k.length > 0 ? k : null
  } catch {
    return null
  }
}

export function setApiKey(key: string, providerId?: string): void {
  const map = loadKeyMap()
  const id = providerId || getProviderId()
  map[id] = key.trim()
  saveKeyMap(map)
}

// ===== Group ID 管理（仅部分厂商需要，如 MiniMax 需在 URL 带 ?GroupId=xxx）=====

export function getGroupId(providerId?: string): string | null {
  try {
    const id = providerId || getProviderId()
    const v = localStorage.getItem('ai_groupid_' + id)
    return v && v.trim().length > 0 ? v.trim() : null
  } catch {
    return null
  }
}

export function setGroupId(id: string, providerId?: string): void {
  try {
    const pid = providerId || getProviderId()
    if (id && id.trim()) localStorage.setItem('ai_groupid_' + pid, id.trim())
    else localStorage.removeItem('ai_groupid_' + pid)
  } catch { /* 忽略 */ }
}

/** 为需要 GroupId 的厂商（如 MiniMax）在接口 URL 上拼接 ?GroupId=xxx */
export function buildApiUrl(provider: LlmProvider, groupId?: string | null): string {
  if (provider.id === 'minimax' && groupId) {
    const sep = provider.apiUrl.includes('?') ? '&' : '?'
    return `${provider.apiUrl}${sep}GroupId=${encodeURIComponent(groupId)}`
  }
  return provider.apiUrl
}

/**
 * 滚动历史摘要：把较早的对话历史压缩为一段摘要（供长对话使用）。
 * 失败或无 API Key 时返回 null，由调用方降级为直接截断。
 */
export async function summarizeHistory(messages: ChatMessageDto[]): Promise<string | null> {
  const apiKey = getApiKey()
  if (!apiKey || messages.length === 0) return null
  const provider = getProvider()
  // 与问答统一：经后端代理 /api/chat-once，不再浏览器直连模型 API
  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}/api/chat-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: '你是对话压缩助手。请用中文把用户提供的对话历史压缩为一段不超过 200 字的摘要，保留关键事实、结论、用户关注点和未解决的问题，不要编造新内容。',
          },
          { role: 'user', content: JSON.stringify(messages) },
        ],
        providerId: provider.id,
        modelId: provider.defaultModel,
        maxTokens: 500,
        groupId: getGroupId(),
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const text = data?.content
    return typeof text === 'string' && text.trim() ? text.trim() : null
  } catch {
    return null
  }
}

export function clearApiKey(providerId?: string): void {
  const map = loadKeyMap()
  const id = providerId || getProviderId()
  delete map[id]
  saveKeyMap(map)
}

// 获取当前提供商的推理（深度思考）模型 ID；若不存在则返回 null
export function getReasoningModelId(): string | null {
  const provider = getProvider()
  const reasoning = provider.models.find(m =>
    /reasoner|qwq|reasoning|深度思考/i.test(`${m.id} ${m.name}`)
  )
  return reasoning ? reasoning.id : null
}

export function hasApiKey(): boolean {
  const key = getApiKey()
  return !!key && key.length > 10
}

export function getLlmStatus(): LlmStatus {
  return hasApiKey() ? 'ready' : 'no-key'
}

// ===== 测试 API Key 有效性 =====

export async function testApiKey(apiKey: string, providerId?: string): Promise<{ valid: boolean; error?: string }> {
  const provider = providerId
    ? LLM_PROVIDERS.find(p => p.id === providerId) || getProvider()
    : getProvider()

  // 与问答统一：只经后端代理 /api/chat-once 测试，不再尝试浏览器直连模型 API。
  // 这样「测试通过」即代表「后端可达且模型/Key 可用」=「问答可用」，二者结果始终一致；
  // 避免出现「测试绿、问答红」的误导。
  const viaBackend = await testKeyViaBackend(apiKey, provider)
  if (viaBackend !== null) return viaBackend
  return { valid: false, error: '后端代理不可用：请确认后端服务已启动（cd server && npm start），或刷新页面后重试。' }
}

/** 走后端代理测试 Key 有效性（用于区分"CORS 拦截"与"Key 无效"）；后端不可达返回 null */
async function testKeyViaBackend(apiKey: string, provider: LlmProvider): Promise<{ valid: boolean; error?: string } | null> {
  try {
    // 本地模型等待上限 60s（冷加载由 OLLAMA_KEEP_ALIVE=24h 常驻缓解）；云端保持 30s。
    // timeoutMs 同步传给后端，使后端在连接断开前主动返回干净错误。
    const isLocal = provider.id === 'ollama'
    const testTimeoutMs = isLocal ? 60000 : 30000
    const res = await fetchWithTimeout(`${BACKEND_URL}/api/chat-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '你好' }],
        providerId: provider.id,
        maxTokens: 5,
        groupId: getGroupId(provider.id),
        timeoutMs: testTimeoutMs,
      }),
    }, testTimeoutMs)
    if (res.ok) {
      const data = await res.json()
      return data?.content !== undefined ? { valid: true } : { valid: false, error: '后端返回异常' }
    }
    const data = await res.json().catch(() => null)
    return { valid: false, error: data?.error || `后端代理 HTTP ${res.status}` }
  } catch {
    return null
  }
}

// ===== 流式聊天 - 后端代理（CORS 降级方案）=====

async function streamChatViaBackend(
  apiKey: string,
  messages: ChatMessageDto[],
  callbacks: StreamCallbacks,
  options?: { useThinking?: boolean; knowledgeContext?: string; modelId?: string }
): Promise<void> {
  const provider = getProvider()
  // 本地模型「等待首字」上限 150s：处理知识库大上下文时 CPU prompt 处理很慢，60s 会误报超时；云端保持 30s。
  const isLocal = provider.id === 'ollama' || !!provider.noApiKey
  const frontendTimeout = isLocal ? 150000 : 30000
  const res = await fetchWithTimeout(`${BACKEND_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      messages,
      useThinking: options?.useThinking || false,
      knowledgeContext: options?.knowledgeContext || '',
      providerId: provider.id,
      modelId: resolveModelId(options?.modelId),
      groupId: getGroupId(),
      // 让后端比前端早 10s 超时，使其能先发回干净的 SSE error 事件，避免前端 abort 误报
      timeoutMs: isLocal ? 140000 : undefined,
    }),
  }, frontendTimeout)

  if (!res.ok) {
    callbacks.onError(`后端错误: HTTP ${res.status}`)
    return
  }

  const reader = res.body?.getReader()
  if (!reader) {
    callbacks.onError('无法读取响应流')
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue

      const data = trimmed.slice(6)
      if (data === '[DONE]') {
        callbacks.onDone()
        return
      }

      try {
        const parsed = JSON.parse(data)
        if (parsed.type === 'thinking') {
          callbacks.onThinking?.(parsed.content)
        } else if (parsed.type === 'content') {
          callbacks.onContent(parsed.content)
        } else if (parsed.type === 'error') {
          callbacks.onError(parsed.content)
        }
      } catch {
        // 忽略解析错误
      }
    }
  }

  callbacks.onDone()
}

// ===== 统一入口：只走后端代理（前端不再直连模型 API）=====
// 局域网/服务器部署下，浏览器直连本地 Ollama 会被 CORS 拦截，且从其他设备访问时
// 127.0.0.1 指向的是各设备自身而非服务器，故问答统一经后端 /api/chat 转发。
// 后端不可达时给出明确提示，而不是再去尝试注定失败的浏览器直连。

export async function streamChat(
  messages: ChatMessageDto[],
  callbacks: StreamCallbacks,
  options?: { useThinking?: boolean; knowledgeContext?: string; modelId?: string }
): Promise<void> {
  const apiKey = getApiKey()
  if (!apiKey) {
    callbacks.onError('NO_API_KEY')
    return
  }

  try {
    await streamChatViaBackend(apiKey, messages, callbacks, options)
  } catch (err: any) {
    const provider = getProvider()
    callbacks.onError(
      `后端代理不可用（${provider.name} 问答需经后端转发）：\n` +
      '请确认后端服务已启动（cd server && npm start），或刷新页面后重试。'
    )
  }
}

/**
 * 非流式一次性补全的「结构化返回」版本。
 * 与 callLLMNonStream 的区别：能把「接口调用失败（无 Key / HTTP 非 2xx / 网络异常）」
 * 与「模型返回空内容（真·无实质内容）」区分开，便于调用方给出更准确的提示，
 * 避免把「Key 额度耗尽导致调用失败」误报成「文档无实质内容」。
 */
export interface LLMNonStreamResult {
  /** 模型输出文本；调用失败或模型返回空时为 null */
  content: string | null
  /** 是否因接口层面失败（无 Key / HTTP 非 2xx / 网络异常），而非「模型返回空」 */
  failed: boolean
  /** failed 为 true 时的失败原因（HTTP 状态 / 后端错误信息 / 网络错误） */
  reason?: string
  /** 失败时的 HTTP 状态码（若有） */
  statusCode?: number
}

// ===== 全局自适应限速（从源头规避账户级速率限制）=====
// 账户级「速率限制 / 请控制请求频率」本质是请求过密。用一条全局出发闸门：
//  - 强制相邻两次模型调用起始间隔 >= intervalMs，把密集请求错开成平稳节律；
//  - 一旦探测到速率限制，自动放宽 interval 并进入冷却期（期间用更大间隔），
//    让整批任务（如整篇总结的数百段 MAP 调用）以更慢节律推进，避开限流窗口；
//  - 冷却结束且无新报错后，间隔自然回落到基础值，恢复吞吐。
// 所有模型调用（归纳 / 整篇总结 MAP+REDUCE / 聊天）都经 callLLMNonStreamDetailed 统一过此闸门。
const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
let _gateChain: Promise<void> = Promise.resolve()
let _lastStart = 0
let _intervalMs = 800
const _FLOOR_INTERVAL = 800
const _CEIL_INTERVAL = 20000
// 记录「最近一次被限流」的时间戳（而非「限流截至」的未来时间点）。
// 这样冷却期不会被迫永续续期：只要一段时间内不再出现限流，间隔就会按指数回落到下限，
// 避免「只增不减」把整篇总结永久卡在 20s 上限（原先 _rateLimitedUntil 持续被失败推后，永不回落）。
let _lastRateLimitAt = 0
const _COOLDOWN_MS = 40000
// 冷却过后，每成功通行一次就把间隔减半（指数回落），恢复吞吐
const _RECOVER_DIVISOR = 2

function isRateLimitReason(reason?: string): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return /速率限制|rate.?limit|429|too many|频率|过于频繁|请稍后|overload|过载|busy|请求过快|控制请求频率/.test(r)
}

async function paceForRateLimit(): Promise<void> {
  const prev = _gateChain
  let release!: () => void
  const ticket = new Promise<void>(r => { release = r })
  _gateChain = prev.then(() => ticket)
  await prev
  // 距离上次限流已超过冷却期 → 认为限流已缓解，指数回落间隔（每通行一次减半），避免「只增不减」永久卡在 20s
  if (Date.now() - _lastRateLimitAt > _COOLDOWN_MS && _intervalMs > _FLOOR_INTERVAL) {
    _intervalMs = Math.max(_FLOOR_INTERVAL, _intervalMs / _RECOVER_DIVISOR)
  }
  const interval = Math.min(_CEIL_INTERVAL, Math.max(_FLOOR_INTERVAL, _intervalMs))
  const wait = Math.max(0, interval - (Date.now() - _lastStart))
  if (wait > 0) await sleepMs(wait)
  _lastStart = Date.now()
  release()
}

function notifyRateLimited(): void {
  _lastRateLimitAt = Date.now()
  _intervalMs = Math.min(_CEIL_INTERVAL, Math.max(_intervalMs * 2, 6000))
}

type TryOutcome =
  | { kind: 'ok'; content: string }
  | { kind: 'empty' }
  | { kind: 'http'; statusCode: number; reason: string }
  | { kind: 'net'; reason: string }

export async function callLLMNonStreamDetailed(
  messages: ChatMessageDto[],
  options?: { modelId?: string; maxTokens?: number; useBackend?: boolean; useDirectFallback?: boolean; timeoutMs?: number }
): Promise<LLMNonStreamResult> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return { content: null, failed: true, reason: '未配置 API Key（请在设置中填入模型 API Key）' }
  }
  const provider = getProvider()
  const model = resolveModelId(options?.modelId)
  const isReasoningModel = /reasoner|qwq|reasoning/i.test(model)
  const sampling = isReasoningModel ? {} : { temperature: 0.3, top_p: 0.85 }
  const maxTokens = options?.maxTokens ?? 4096
  const useBackend = options?.useBackend ?? true
  // 超时：默认 30s；批处理总结等长任务调用方可传入更长（如 120s）避免大输入被截断
  const timeoutMs = options?.timeoutMs ?? LLM_TIMEOUT_MS

  const tryBackend = async (): Promise<TryOutcome> => {
    try {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/chat-once`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({
          messages,
          providerId: provider.id,
          modelId: model,
          maxTokens,
          groupId: getGroupId(provider.id),
          // 把前端超时预算同步给后端，后端按 clientTimeout-5s 主动超时返回干净错误，
          // 避免后端用更短的默认值（云端 30s）在长归纳任务上过早掐断。
          timeoutMs,
        }),
      }, timeoutMs)
      if (!res.ok) {
        let reason = `HTTP ${res.status}`
        try {
          const ct = res.headers.get('content-type') || ''
          if (ct.includes('application/json')) {
            const j = await res.json()
            const msg = j?.error || j?.message || j?.errorMsg
            if (typeof msg === 'string' && msg.trim()) reason = msg.trim()
          } else {
            const t = await res.text()
            if (t && t.trim()) reason = t.trim().slice(0, 200)
          }
        } catch { /* 保留默认 reason */ }
        return { kind: 'http', statusCode: res.status, reason }
      }
      const data = await res.json()
      const text = data?.content
      return typeof text === 'string' && text.trim() ? { kind: 'ok', content: text.trim() } : { kind: 'empty' }
    } catch (e) {
      return { kind: 'net', reason: e instanceof Error ? e.message : String(e) }
    }
  }

  const tryDirect = async (): Promise<TryOutcome> => {
    try {
      const res = await fetchWithTimeout(buildApiUrl(provider, getGroupId()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, ...sampling }),
      }, timeoutMs)
      if (!res.ok) {
        let reason = `HTTP ${res.status}`
        try {
          const data = await res.json()
          const msg = data?.error?.message || data?.error || data?.message
          if (typeof msg === 'string' && msg.trim()) reason = msg.trim()
        } catch {
          try {
            const t = await res.text()
            if (t && t.trim()) reason = t.trim().slice(0, 200)
          } catch { /* 保留默认 */ }
        }
        return { kind: 'http', statusCode: res.status, reason }
      }
      const data = await res.json().catch(() => ({}))
      const text = data?.choices?.[0]?.message?.content ?? data?.output?.text
      if (typeof text === 'string' && text.trim()) return { kind: 'ok', content: text.trim() }
      // 200 但 body 无内容：若带 error 信息，按「调用失败」上报，避免被误判成「模型返回空」
      const errMsg = data?.error?.message || data?.error || (typeof data?.message === 'string' ? data.message : undefined)
      if (errMsg) return { kind: 'http', statusCode: 200, reason: typeof errMsg === 'string' ? errMsg.slice(0, 200) : '模型返回了错误响应' }
      return { kind: 'empty' }
    } catch (e) {
      return { kind: 'net', reason: e instanceof Error ? e.message : String(e) }
    }
  }

  // 默认不再回退浏览器直连（前端统一走后端代理 /api/chat-once）
  const useDirectFallback = options?.useDirectFallback ?? false

  // —— 全局限速闸门：真正发起模型调用前取得出发许可，错开请求节律、规避账户级速率限制 ——
  await paceForRateLimit()

  let backend: TryOutcome | null = null
  if (useBackend) {
    backend = await tryBackend()
    if (backend.kind === 'ok') return { content: backend.content, failed: false }
    // 仅走后端代理（不回退浏览器直连）时，后端已给出明确结果则直接返回，
    // 避免把「后端调用失败」被回退的浏览器直连（CORS 必失败 / 结构不符）误判成「模型返回空」。
    if (!useDirectFallback) {
      if (backend.kind === 'empty') return { content: null, failed: false } // 模型确实返回空
      const r: LLMNonStreamResult = {
        content: null,
        failed: true,
        reason: backend?.reason || '后端模型接口调用失败',
        statusCode: backend?.kind === 'http' ? backend.statusCode : undefined,
      }
      if (isRateLimitReason(r.reason)) notifyRateLimited()
      return r
    }
  }
  const direct = await tryDirect()
  if (direct.kind === 'ok') return { content: direct.content, failed: false }
  if (direct.kind === 'empty') return { content: null, failed: false } // 模型真返回空 → 视为「无实质内容」

  // 后端与直连都未成功：上报失败（优先用最终尝试 direct 的原因）
  const failed = direct.kind === 'http' || direct.kind === 'net' ? direct : backend
  const failedReason = failed && (failed.kind === 'http' || failed.kind === 'net') ? failed.reason : undefined
  const reason = failedReason || (backend?.kind === 'http' ? backend.reason : '模型接口调用失败')
  const r: LLMNonStreamResult = { content: null, failed: true, reason, statusCode: failed?.kind === 'http' ? failed.statusCode : undefined }
  if (isRateLimitReason(r.reason)) notifyRateLimited()
  return r
}

/**
 * 非流式一次性补全（用于知识库整表/整文档总结等离线批处理场景）。
 * 优先后端代理 /api/chat-once（局域网部署无 CORS 问题），失败回退直连。
 * 返回模型输出文本；无 Key / 调用失败 / 模型返回空 均返回 null。
 * 若需区分「调用失败」与「返回空」，请使用 callLLMNonStreamDetailed。
 */
export async function callLLMNonStream(
  messages: ChatMessageDto[],
  options?: { modelId?: string; maxTokens?: number; useBackend?: boolean; useDirectFallback?: boolean; timeoutMs?: number }
): Promise<string | null> {
  const r = await callLLMNonStreamDetailed(messages, options)
  return r.content
}
