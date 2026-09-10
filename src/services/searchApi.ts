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
  opts: { topK?: number; perHitChars?: number; timeoutMs?: number } = {}
): Promise<ServerSearchHit[]> {
  const q = (query || '').trim()
  if (!q) return []
  const topK = Math.min(Math.max(opts.topK ?? 20, 1), 200)
  const perHitChars = Math.min(Math.max(opts.perHitChars ?? 6000, 200), 60000)
  const url = `${BACKEND_BASE}/api/search?q=${encodeURIComponent(q)}&topK=${topK}&perHitChars=${perHitChars}`
  try {
    const data = await fetchJson(url, opts.timeoutMs ?? DEFAULT_TIMEOUT)
    return Array.isArray(data?.hits) ? data.hits as ServerSearchHit[] : []
  } catch {
    return []
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
  opts: { topK?: number; perHitChars?: number; timeoutMs?: number } = {}
): Promise<ServerSearchHit[]> {
  const status = await fetchSearchStatus()
  if (!status?.ready) return []
  return searchOnServer(query, opts)
}
