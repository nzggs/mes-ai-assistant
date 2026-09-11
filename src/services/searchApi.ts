// 服务端检索（倒排索引）调用封装。
//
// 背景：超大文档（XML 数据导出常达数千条记录 / 数十 MB）的正文不再随文档列表全量下发到
// 浏览器（/api/docs 会剥离 content 并标记 contentOmitted），否则「换一台浏览器打开」就要
// 拉取几十 MB 正文。这类文档的问答检索改由服务端倒排索引承担：
//   提问 → GET /api/search 拿 Top-K 命中页 → 前端据此组装知识上下文
// 服务未就绪 / 请求失败 / 超时时，自动退回「本地已加载正文」的既有检索路径，不影响任何现有功能。

import { BACKEND_BASE } from './backend'
import type { KnowledgeDoc } from '../types'

export interface ServerSearchHit {
  docId: string
  docName: string
  pageIndex: number
  pageTitle: string
  score: number
  text: string
  /** 对象编号（页标题 `·` 前，如 query.ce.sop.list / UM0CEMM005 / PM1CEMM017） */
  objectNo?: string
  /** 对象描述（页标题 `·` 后） */
  objectDesc?: string
  /** 对象类型（正文里的 TYPE_CATEGORY_NO，如 query.sql / widget） */
  objectType?: string
  /** 页类别：sql / script / widget / flow / other */
  kind?: string
  /** 该页正文是否被裁剪（smartTrim 生效时结构类页会被压短） */
  trimmed?: boolean
}

/** 对象目录条目（/api/objects，无正文） */
export interface SearchObject {
  docId: string
  docName: string
  pageIndex: number
  objectNo: string
  objectDesc: string
  objectType: string
  kind: string
  score: number
}

export interface SearchStatus {
  enabled: boolean
  ready: boolean
  building: boolean
  docCount: number
  pageCount: number
  termCount: number
  postings: number
}

/** 检索可选参数：按模型档位传入（见 shared/modelProfile.js） */
export interface SearchOptions {
  topK?: number
  perHitChars?: number
  timeoutMs?: number
  /** 按页类别裁剪界面/流程大 JSON（默认不开 → 老行为不变） */
  smartTrim?: boolean
  /** 给 query.sql / 含 STATEMENT 的页提权（问 SQL 时开启） */
  boostSql?: boolean
  /** 结构类页的裁剪上限（字符） */
  structChars?: number
}

const DEFAULT_TIMEOUT = 4000

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 探测服务端检索是否可用（带缓存，避免每次提问都请求） */
let cachedStatus: SearchStatus | null = null
let statusCheckedAt = 0
const STATUS_TTL_MS = 30_000

export async function fetchSearchStatus(force = false): Promise<SearchStatus | null> {
  const now = Date.now()
  if (!force && cachedStatus && now - statusCheckedAt < STATUS_TTL_MS) return cachedStatus
  try {
    const data = await fetchJson(`${BACKEND_BASE}/api/search/status`, 2500)
    cachedStatus = data && typeof data === 'object' ? (data as SearchStatus) : null
    statusCheckedAt = now
  } catch {
    // 后端不可达：清除缓存，下次再试（不把 cachedStatus 置 true）
    cachedStatus = null
    statusCheckedAt = now
  }
  return cachedStatus
}

/** 供 UI 展示用的同步读取（可能为 null） */
export function getCachedSearchStatus(): SearchStatus | null {
  return cachedStatus
}

/**
 * 执行一次服务端检索。任何异常都返回空数组（由调用方继续走本地检索），不影响提问流程。
 * @param perHitChars 单条命中页正文上限（控制响应体与上下文预算）
 */
export async function searchOnServer(
  query: string,
  opts: SearchOptions = {}
): Promise<ServerSearchHit[]> {
  const q = (query || '').trim()
  if (!q) return []
  const topK = Math.min(Math.max(opts.topK ?? 20, 1), 200)
  const perHitChars = Math.min(Math.max(opts.perHitChars ?? 6000, 200), 60000)
  const extra = [
    opts.smartTrim ? 'smartTrim=1' : '',
    opts.boostSql ? 'boostSql=1' : '',
    opts.structChars ? `structChars=${Math.round(opts.structChars)}` : '',
  ].filter(Boolean).join('&')
  const url = `${BACKEND_BASE}/api/search?q=${encodeURIComponent(q)}&topK=${topK}&perHitChars=${perHitChars}`
    + (extra ? `&${extra}` : '')
  try {
    const data = await fetchJson(url, opts.timeoutMs ?? DEFAULT_TIMEOUT)
    return Array.isArray(data?.hits) ? data.hits as ServerSearchHit[] : []
  } catch {
    return []
  }
}

/**
 * 取「与问题相关的对象目录」：只含对象编号/描述/类型/所属文档，**不含正文**，非常廉价。
 * 用途：把「库里存在哪些对象、分别是什么类型」喂给模型，避免它从命中正文里猜表名
 * （实测模型会把文档名 `Z_WIDGET_…xml` 当成数据库表，编造出不存在的 SQL）。
 * 失败/未就绪返回空数组，不影响提问。
 */
export async function fetchObjectIndex(
  query: string,
  opts: { limit?: number; timeoutMs?: number; boostSql?: boolean } = {}
): Promise<SearchObject[]> {
  const q = (query || '').trim()
  if (!q) return []
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200)
  const status = await fetchSearchStatus()
  if (!status?.ready) return []
  const url = `${BACKEND_BASE}/api/objects?q=${encodeURIComponent(q)}&limit=${limit}`
    + (opts.boostSql ? '&boostSql=1' : '')
  try {
    const data = await fetchJson(url, opts.timeoutMs ?? DEFAULT_TIMEOUT)
    return Array.isArray(data?.items) ? data.items as SearchObject[] : []
  } catch {
    return []
  }
}

/** 文档台账的单篇条目（服务端 /api/documents 返回，绝不携带正文） */
export interface DocIndexItem {
  id: string
  name: string
  type: string
  status: string
  pages: number | null
  chunks: number
  size: string
  uploadDate: string
  approvedDate: string
  uploaderName: string
  indexed: boolean
  indexedPages: number
}

/** 文档台账：counts 为三态权威计数，供模型直接引用而不是自己数 */
export interface DocIndexResult {
  items: DocIndexItem[]
  total: number
  counts: { total: number; approved: number; pending: number; rejected: number }
}

/**
 * 取「知识库文档台账」：权威的文档清单与状态计数，**不含正文**。
 * 与 fetchObjectIndex 的关键区别：失败/未就绪返回 **null**（而非空数组），
 * 让调用方区分「服务端不可用」与「库里真的没有文档」——前者必须维持历史行为（零回归）。
 */
export async function fetchDocumentIndex(
  opts: { status?: string; q?: string; limit?: number; timeoutMs?: number } = {}
): Promise<DocIndexResult | null> {
  const st = await fetchSearchStatus()
  if (!st?.ready) return null
  const qs = new URLSearchParams()
  if (opts.status) qs.set('status', opts.status)
  if (opts.q) qs.set('q', opts.q)
  qs.set('limit', String(Math.min(Math.max(opts.limit ?? 200, 1), 500)))
  try {
    const data = await fetchJson(`${BACKEND_BASE}/api/documents?${qs.toString()}`, opts.timeoutMs ?? DEFAULT_TIMEOUT)
    return data && Array.isArray(data.items) ? (data as DocIndexResult) : null
  } catch {
    return null
  }
}

/**
 * 提问前统一解析服务端的命中结果：
 * - 服务端索引就绪 → 走 /api/search（唯一能检索到 contentOmitted 超大文档正文的通道）
 * - 未就绪 / 失败 → 返回空数组，调用方自动退回本地既有路径（零功能回退）
 */
export async function resolveServerHits(
  query: string,
  documents: KnowledgeDoc[],
  opts: SearchOptions = {}
): Promise<ServerSearchHit[]> {
  const status = await fetchSearchStatus()
  if (!status?.ready) return []
  return searchOnServer(query, opts)
}
