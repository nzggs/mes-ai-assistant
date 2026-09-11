// 「APC 和 RTO」数据接口封装。
//
// 后端只读读取 HANA（或内置仿真源）中记录的过程数据列值，并给出设定值优化建议。
// 所有接口均为只读；服务端另有限流与短 TTL 缓存，前端刷新不会压垮数据源。

import { BACKEND_BASE, getAdminToken } from './backend'
import type {
  ApcConfigPatch,
  ApcConfigResponse,
  ApcDatabaseDraft,
  ApcOverview,
  ApcOptimization,
  ApcHistoryResponse,
  ApcParamConfig,
  ApcProjectDraft,
  ApcProjectFull,
  ApcProjectSummary,
  ApcQueryConfig,
  ApcQueryPreview,
  ApcStatusResponse,
  ApcTestDbResult,
  MesGuide,
  MesQueryResult,
} from '../types'

const DEFAULT_TIMEOUT = 12_000

async function fetchJson<T>(url: string, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    let payload: any = null
    try {
      payload = await res.json()
    } catch {
      payload = null
    }
    if (!res.ok) {
      const msg = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`
      throw new Error(msg)
    }
    return payload as T
  } finally {
    clearTimeout(timer)
  }
}

export interface ApcFetchOptions {
  /** 统计窗口（分钟），服务端限制 5 ~ 1440 */
  minutes?: number
  /** 监测项目 id（缺省默认项目） */
  project?: string
  /** 强制绕过服务端缓存 */
  refresh?: boolean
  timeoutMs?: number
}

function windowQuery(opts: ApcFetchOptions): string {
  const parts: string[] = []
  if (opts.minutes && Number.isFinite(opts.minutes)) {
    parts.push(`minutes=${Math.round(opts.minutes)}`)
  }
  if (opts.project) parts.push(`project=${encodeURIComponent(opts.project)}`)
  if (opts.refresh) parts.push('refresh=1')
  return parts.length ? `?${parts.join('&')}` : ''
}

/** 功能与数据源状态 */
export async function fetchApcStatus(opts: ApcFetchOptions = {}): Promise<ApcStatusResponse> {
  return fetchJson<ApcStatusResponse>(`${BACKEND_BASE}/api/apc/status`, opts.timeoutMs ?? 6000)
}

/** 过程参数概览：实时值 + 统计量 + 趋势 */
export async function fetchApcOverview(opts: ApcFetchOptions = {}): Promise<ApcOverview> {
  return fetchJson<ApcOverview>(
    `${BACKEND_BASE}/api/apc/overview${windowQuery(opts)}`,
    opts.timeoutMs
  )
}

/** 优化建议：过程参数设定值建议值 */
export async function fetchApcOptimization(
  opts: ApcFetchOptions & { codes?: string[] } = {}
): Promise<ApcOptimization> {
  const extra = opts.codes && opts.codes.length > 0
    ? `${windowQuery(opts) ? '&' : '?'}codes=${encodeURIComponent(opts.codes.join(','))}`
    : ''
  return fetchJson<ApcOptimization>(
    `${BACKEND_BASE}/api/apc/optimize${windowQuery(opts)}${extra}`,
    opts.timeoutMs
  )
}

/** 单个参数的历史数据列值曲线 */
export async function fetchApcHistory(
  code: string,
  opts: ApcFetchOptions = {}
): Promise<ApcHistoryResponse> {
  const sep = windowQuery(opts) ? '&' : '?'
  return fetchJson<ApcHistoryResponse>(
    `${BACKEND_BASE}/api/apc/history${windowQuery(opts)}${sep}code=${encodeURIComponent(code)}`,
    opts.timeoutMs
  )
}

// ===== 问答（聊天）中的 MES 数据直查 =====
//
// 与 APC 取数共用服务端硬性要求：只允许 SELECT、行数硬上限、连接/语句超时。
// 模型在回答里输出 ```mes-sql 推荐查询后，前端把 SQL 提交到 /api/mes/query 执行。

/** MES 直查指引：下拉菜单槽位、推荐 SQL 模板、参数编码白名单、硬性限制 */
export async function fetchMesGuide(timeoutMs = 8000): Promise<MesGuide> {
  return fetchJson<MesGuide>(`${BACKEND_BASE}/api/mes/guide`, timeoutMs)
}

/** 执行模型推荐的只读 SQL（服务端硬护栏），超时上限放宽到语句超时以上 */
export async function queryMesData(payload: { slot: string; sql: string }, timeoutMs = 40_000): Promise<MesQueryResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BACKEND_BASE}/api/mes/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    let body: any = null
    try { body = await res.json() } catch { body = null }
    if (!res.ok) {
      const msg = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
      throw new Error(msg)
    }
    return body as MesQueryResult
  } finally {
    clearTimeout(timer)
  }
}

// ===== 数据源配置（数据库登录 / SQL 查询语句 / 参数配置）=====
//
// 这些接口在服务端全部挂着 requireAdmin，必须带 X-Admin-Token；
// 密码只进不出：读回来的配置里没有密码原文，只有 passwordSet 布尔值。

/** 携带管理员令牌的请求头 */
function adminHeaders(): Record<string, string> {
  const token = getAdminToken()
  return token
    ? { 'Content-Type': 'application/json', 'X-Admin-Token': token }
    : { 'Content-Type': 'application/json' }
}

/** 带管理鉴权的请求：失败时把 HTTP 状态码挂在 error 上，便于上层区分 403 */
async function adminRequest<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BACKEND_BASE}${path}`, { ...init, signal: controller.signal })
    let payload: any = null
    try {
      payload = await res.json()
    } catch {
      payload = null
    }
    if (!res.ok) {
      const msg = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`
      const err = new Error(msg) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    return payload as T
  } finally {
    clearTimeout(timer)
  }
}

export interface ApcConfigSaveResult {
  ok: boolean
  saved: string[]
  config: ApcConfigResponse
}

/** 读取当前配置（数据库 / 取数 SQL / 参数目录，密码不回传） */
export async function fetchApcConfig(): Promise<ApcConfigResponse> {
  return adminRequest<ApcConfigResponse>('/api/apc/config', { headers: adminHeaders() })
}

/** 保存配置：按段提交，只传改动过的段（database / queries / params / meta） */
export async function saveApcConfig(patch: ApcConfigPatch): Promise<ApcConfigSaveResult> {
  return adminRequest<ApcConfigSaveResult>('/api/apc/config', {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify(patch),
  })
}

export type ApcConfigSection = 'database' | 'queries' | 'params' | 'meta' | 'limits'

/** 把某一段恢复为种子文件 / 环境变量提供的默认值（projectId 仅对 queries/params 生效） */
export async function resetApcConfig(section: ApcConfigSection, databaseId?: string, projectId?: string): Promise<ApcConfigSaveResult> {
  return adminRequest<ApcConfigSaveResult>('/api/apc/config/reset', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ section, databaseId, projectId }),
  })
}

// ===== 监测项目 CRUD =====

/** 监测项目列表（摘要，不含 queries/params 全文） */
export async function fetchApcProjects(timeoutMs = 8000): Promise<{ projects: ApcProjectSummary[] }> {
  return fetchJson<{ projects: ApcProjectSummary[] }>(`${BACKEND_BASE}/api/apc/projects`, timeoutMs)
}

/** 监测项目详情（含 queries/params 全文；给项目编辑器用） */
export async function fetchApcProject(id: string, timeoutMs = 8000): Promise<{ project: ApcProjectFull }> {
  return fetchJson<{ project: ApcProjectFull }>(`${BACKEND_BASE}/api/apc/projects/${encodeURIComponent(id)}`, timeoutMs)
}

/** 新建监测项目（仅管理员） */
export async function createApcProject(draft: ApcProjectDraft): Promise<{ ok: boolean; project: ApcProjectFull; projects: ApcProjectSummary[] }> {
  return adminRequest<{ ok: boolean; project: ApcProjectFull; projects: ApcProjectSummary[] }>(
    '/api/apc/projects',
    { method: 'POST', headers: adminHeaders(), body: JSON.stringify(draft) },
    20_000
  )
}

/** 更新监测项目（仅管理员；只覆盖传入字段） */
export async function updateApcProject(id: string, draft: ApcProjectDraft): Promise<{ ok: boolean; project: ApcProjectFull; projects: ApcProjectSummary[] }> {
  return adminRequest<{ ok: boolean; project: ApcProjectFull; projects: ApcProjectSummary[] }>(
    `/api/apc/projects/${encodeURIComponent(id)}`,
    { method: 'PUT', headers: adminHeaders(), body: JSON.stringify(draft) },
    20_000
  )
}

/** 删除监测项目（仅管理员；默认项目不可删） */
export async function deleteApcProject(id: string): Promise<{ ok: boolean; projects: ApcProjectSummary[] }> {
  return adminRequest<{ ok: boolean; projects: ApcProjectSummary[] }>(
    `/api/apc/projects/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: adminHeaders() },
    20_000
  )
}

/**
 * 用页面上的草稿凭据测试连接（不落盘）。
 * 服务端会真连一次数据库，超时上限 30s，因此这里放宽前端等待时间。
 */
export async function testApcDatabase(database: ApcDatabaseDraft, id?: string): Promise<ApcTestDbResult> {
  return adminRequest<ApcTestDbResult>(
    '/api/apc/config/test-db',
    { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ database, id }) },
    40_000
  )
}

/** 试运行取数 SQL：真实执行一次只读查询，返回列名与前 N 行；slot 指定用哪个数据库系统试 */
export async function previewApcQuery(payload: {
  queries?: ApcQueryConfig
  params?: ApcParamConfig[]
  minutes?: number
  maxRows?: number
  slot?: string
}): Promise<ApcQueryPreview> {
  return adminRequest<ApcQueryPreview>(
    '/api/apc/config/preview-query',
    { method: 'POST', headers: adminHeaders(), body: JSON.stringify(payload) },
    40_000
  )
}

/** 本地保存管理员令牌（与知识库/用户管理共用同一个键） */
export function setAdminToken(token: string): void {
  if (typeof window === 'undefined') return
  const t = String(token || '').trim()
  if (t) localStorage.setItem('mes-ai-admin-token', t)
  else localStorage.removeItem('mes-ai-admin-token')
}

/** 是否已有可用令牌（构建期烧入或本地填写） */
export function hasAdminToken(): boolean {
  return Boolean(getAdminToken())
}
