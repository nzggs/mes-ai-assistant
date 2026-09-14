// 用户「记忆」接口封装（个性化偏好，如"生成的 SQL 列名注释要加双引号"）。
//
// 记忆按登录用户归属：服务端按 username 存取（与知识库操作日志一致的归属方式），
// 内容为非敏感偏好文本。问答时前端会把当前用户的记忆注入上下文，
// 使模型生成的内容（尤其是 MES 直查 SQL）符合个人偏好。

import { BACKEND_BASE } from './backend'

export interface UserMemory {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

export interface MemoryLimits {
  maxLen: number
  maxPerUser: number
}

const DEFAULT_TIMEOUT = 12_000

async function requestJson<T>(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
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

function buildInit(method: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  return { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
}

/** 拉取当前用户的记忆列表 */
export async function fetchUserMemories(username: string, timeoutMs?: number): Promise<{ memories: UserMemory[]; limits?: MemoryLimits }> {
  const q = `username=${encodeURIComponent(username)}`
  return requestJson(`${BACKEND_BASE}/api/memories?${q}`, buildInit('GET'), timeoutMs)
}

/** 新增一条记忆，返回最新列表 */
export async function addUserMemory(username: string, content: string): Promise<{ memories: UserMemory[] }> {
  return requestJson(`${BACKEND_BASE}/api/memories`, buildInit('POST', { username, content }))
}

/** 更新一条记忆，返回最新列表 */
export async function updateUserMemory(username: string, id: string, content: string): Promise<{ memories: UserMemory[] }> {
  return requestJson(`${BACKEND_BASE}/api/memories/${encodeURIComponent(id)}`, buildInit('PUT', { username, content }))
}

/** 删除一条记忆，返回最新列表 */
export async function deleteUserMemory(username: string, id: string): Promise<{ memories: UserMemory[] }> {
  const q = `username=${encodeURIComponent(username)}`
  return requestJson(`${BACKEND_BASE}/api/memories/${encodeURIComponent(id)}?${q}`, buildInit('DELETE'))
}

/** 把记忆列表压成注入上下文的文本块（含"记住偏好"时的保存机制约定；无记忆时只注入机制说明） */
export function buildMemoryContext(memories: UserMemory[] | null | undefined): string {
  const items = (memories || [])
    .map(m => `- ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n')
  return `\n\n## 用户记忆（当前用户的长期个性化偏好，请在本轮回答中遵守）\n${items || '（暂无）'}\n
### 记忆保存机制（重要）
当用户要求你"记住 / 记一下 / 以后遵守"某个偏好或规则时：不要只口头答应，必须输出**恰好一个** \`\`\`user-memory 代码块，块内只写要记住的规则原文（≤500 字，不加解释、不加代码块标记以外的内容）。系统会自动把它保存到该用户的记忆管理并在界面回显确认。只有输出了该代码块，才可以对用户说"已记住"；未输出代码块时不得声称已记住。与用户当前问题无关的闲聊、普通问答一律不要输出该代码块。`
}
