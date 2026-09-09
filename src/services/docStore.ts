/**
 * 知识库文档持久化存储
 * - IndexedDB 作为本地缓存（含原始文件 Blob，供本浏览器离线使用）
 * - 后端 server（3001）作为跨浏览器/跨设备持久化（外部浏览器也能看到）
 * - 读取优先后端，后端不可达时回退 IndexedDB
 */
import type { KnowledgeDoc, TableSummary, SummaryChunk } from '../types'
import { BACKEND_BASE, getAdminToken } from './backend'
import { reportError } from './errorReporter'

const DB_NAME = 'mes-ai-knowledge'
const DB_VERSION = 1
const STORE = 'docs'

let backendAvailable: boolean | null = null

async function checkBackend(): Promise<boolean> {
  if (backendAvailable === true) return true
  try {
    const res = await fetch(`${BACKEND_BASE}/api/health`)
    backendAvailable = res.ok ? true : null
  } catch {
    backendAvailable = null // 失败不缓存，下次允许重试
  }
  return backendAvailable === true
}

function blobToBase64(blob: Blob): Promise<string | undefined> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : undefined)
    }
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(blob)
  })
}

async function postToBackend(doc: KnowledgeDoc, fileBase64?: string): Promise<void> {
  if (!(await checkBackend())) return
  let res: Response
  try {
    res = await fetch(`${BACKEND_BASE}/api/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': getAdminToken() },
      body: JSON.stringify({ id: doc.id, doc, fileBase64 }),
    })
  } catch {
    return // 网络错误（后端不可达）时忽略，本地 IndexedDB 仍有数据
  }
  if (!res.ok) {
    // 后端明确拒绝（如 409 文档已被删除）：抛错让调用方感知，不做静默失败
    const data = await res.json().catch(() => null)
    throw new Error(data?.error || `后端保存失败 (${res.status})`)
  }
}

async function deleteFromBackend(id: string): Promise<void> {
  if (!(await checkBackend())) return
  try {
    // B1：管理路由需携带管理员令牌（未配置 ADMIN_TOKEN 时服务端放行）
    await fetch(`${BACKEND_BASE}/api/docs/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': getAdminToken() },
    })
  } catch { /* 忽略 */ }
}

/** 迁移本地 IndexedDB 文档到后端（启动时调用，保证外部浏览器可见） */
export async function syncLocalToBackend(): Promise<void> {
  if (!(await checkBackend())) return
  try {
    const res = await fetch(`${BACKEND_BASE}/api/docs`)
    if (!res.ok) return
    const remote = await res.json() as { id: string }[]
    const remoteIds = new Set(remote.map(r => r.id))
    const db = await getDb()
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<StoredDocRecord[]>
    const records = (await requestResult<StoredDocRecord[]>(req)) || []
    for (const r of records) {
      if (remoteIds.has(r.id)) continue
      const fileBase64 = r.blob ? await blobToBase64(r.blob) : undefined
      await postToBackend(r.doc, fileBase64)
    }
  } catch { /* 忽略 */ }
}

export interface StoredDocRecord {
  id: string
  doc: KnowledgeDoc // 不含 pdfUrl/fileUrl（blob URL 刷新即失效，恢复时重建）
  blob?: Blob // 原始文件内容
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('打开 IndexedDB 失败'))
  })
}

/** 复用 IndexedDB 连接，避免每次操作重复打开 */
function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch(err => {
      dbPromise = null // 失败后允许下次重试
      throw err
    })
  }
  return dbPromise
}

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB 操作失败'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'))
  })
}

/** 剥离 blob URL 字段，避免刷新后残留失效 URL */
function stripUrls(doc: KnowledgeDoc): KnowledgeDoc {
  const copy: KnowledgeDoc = { ...doc }
  delete copy.pdfUrl
  delete copy.fileUrl
  return copy
}

/**
 * IndexedDB 瘦身：只持久化轻量元数据 + 原始 Blob，剥离重字段（正文 textContent、
 * 分页 content、总结切片 summaryChunks），显著降低本地存储体积（5000 份量级尤为明显）。
 * 完整正文仍由后端分片存储；联网时 getAllDocs 以「后端完整文档」为准用于检索，检索结果不变；
 * 仅在离线（后端不可达）时退化为元数据可用。
 */
function slimDoc(doc: KnowledgeDoc): KnowledgeDoc {
  const copy: KnowledgeDoc = { ...doc }
  delete copy.pdfUrl
  delete copy.fileUrl
  delete (copy as any).textContent
  delete (copy as any).content
  delete (copy as any).summaryChunks
  return copy
}

/** 保存新上传文档（元数据 + 原始文件 Blob），并同步到后端 */
export async function saveUploadedDoc(doc: KnowledgeDoc, blob: Blob): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put({ id: doc.id, doc: slimDoc(stripUrls(doc)), blob } as StoredDocRecord)
  // IndexedDB 落盘完成即返回，保证"上传后立即刷新"也能从 IndexedDB 恢复文档
  await txDone(tx)

  // 同步后端（携带原始文件，供外部浏览器阅读原文）放后台执行，不阻塞上传；
  // 后端同步失败不致命（IndexedDB 已兜底，getAllDocs 会在后端缺失时自动补传），但需记录以便排查
  blobToBase64(blob)
    .then(fileBase64 => {
      if (fileBase64) return postToBackend(stripUrls(doc), fileBase64)
    })
    .catch(err => console.warn('文档后端同步失败（本地已保留，稍后自动补传）:', err))
}

/** 更新文档元数据（保留已存的原始文件 Blob；用于 AI 提取/审核状态等更新），并同步后端 */
export async function saveMeta(doc: KnowledgeDoc): Promise<void> {
  const db = await getDb()
  const store = db.transaction(STORE, 'readonly').objectStore(STORE)
  const existing = await requestResult<StoredDocRecord | undefined>(
    store.get(doc.id) as IDBRequest<StoredDocRecord | undefined>
  )
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put({ id: doc.id, doc: slimDoc(stripUrls(doc)), blob: existing?.blob } as StoredDocRecord)
  await txDone(tx)

  await postToBackend(stripUrls(doc))
}

/**
 * 持久化整表/整文档总结（map-reduce 结果）到文档，并同步后端 + 本地 IndexedDB。
 * 这样「点一次/问一次」后知识库记住了，刷新、重开页面、换浏览器都能直接复用，不再每次重新生成。
 * @param doc 当前文档（用于计算内容哈希与保留 Blob）
 * @param sheetKey FULL_DOC_SUMMARY_KEY（整篇）或纯表名
 */
export async function saveTableSummary(
  doc: KnowledgeDoc,
  sheetKey: string,
  text: string
): Promise<{ tableSummaries: { [sheetKey: string]: TableSummary } }> {
  // 内容哈希（本地计算，避免引入 knowledgeService 依赖）
  const src = doc.content && doc.content.length > 0
    ? doc.content.map(p => p.title + ':' + p.paragraphs.join('\n')).join('\n')
    : (doc.textContent || '')
  let h = 5381
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0
  const contentHash = 'h' + h.toString(36) + ':' + src.length

  const entry: TableSummary = { text, updatedAt: Date.now(), contentHash }

  // 生成可检索切片：将总结文本切成 ~800 字片段，作为普通检索来源，
  // 使总结内容可被常规问答（无"总结"意图词）召回，而不必每次触发昂贵的总体归纳
  const chunks: SummaryChunk[] = chunkText(text, 800).map(t => ({
    sheetKey,
    label: sheetKey === '__doc__'
      ? `《${doc.name}》整篇 AI 总结`
      : `《${doc.name}》标签页「${sheetKey}」AI 总结`,
    text: t,
  }))
  // 合并：移除同一 sheetKey 的旧切片，追加新切片（避免重复累积）
  const prevChunks = (doc.summaryChunks || []).filter(c => c.sheetKey !== sheetKey)
  const summaryChunks = [...prevChunks, ...chunks]

  const tableSummaries = { ...(doc.tableSummaries || {}), [sheetKey]: entry }
  const updated: KnowledgeDoc = { ...doc, tableSummaries, summaryChunks }
  // 同步"知识切片"计数（原文切片 + 总结切片），便于前端展示
  updated.chunks = Math.ceil(src.length / 4096) + summaryChunks.length

  // 先落本地 IndexedDB（本地真相），再尽力同步后端。
  // 后端同步失败（如 LAN IP 下大 body 被拒、409 墓碑）不得中断保存流程：
  // 本地已保存成功即视为成功，UI 应立即更新（对勾/已保存提示/日志），
  // 后端差异由下次 getAllDocs 自动补传或用户手动重传修正。
  try {
    await saveMeta(updated)
  } catch (e) {
    console.warn('[docStore] 总结已保存到本地，后端同步失败（可稍后自动补传）:', (e as Error)?.message || e)
  }
  return { tableSummaries }
}

/** 将长文本按固定步长切分为检索片段 */
function chunkText(text: string, size: number): string[] {
  const res: string[] = []
  for (let i = 0; i < text.length; i += size) {
    const t = text.slice(i, i + size).trim()
    if (t) res.push(t)
  }
  return res
}

// ===== 知识库操作日志（上传/删除/审核/总结） =====
// 写入后端 doc-logs.json（多用户共享、删除文档后仍保留）；后端不可达时静默失败不阻断主流程
export async function appendDocLog(log: {
  action: 'upload' | 'delete' | 'approve' | 'reject' | 'summary'
  operator: string
  operatorName?: string
  department?: string
  target?: string
  detail?: string
}): Promise<void> {
  if (!(await checkBackend())) return
  let lastErr: any = null
  // 偶发网络抖动时重试一次，避免瞬时失败误报「操作日志写入失败」
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(`${BACKEND_BASE}/api/doc-logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log }),
      })
      return
    } catch (e) {
      lastErr = e
      if (attempt === 0) await new Promise(r => setTimeout(r, 300))
    }
  }
  // 日志写入失败不影响主业务，但需在页面弹窗报警提示
  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr)
  reportError(`操作日志写入失败：${msg}`)
}

export async function getDocLogs(): Promise<import('../types').DocLog[]> {
  try {
    if (!(await checkBackend())) return []
    const res = await fetch(`${BACKEND_BASE}/api/doc-logs`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data?.logs) ? data.logs : []
  } catch {
    return []
  }
}

/** 读取所有持久化文档（合并后端 + 本地 IndexedDB；本地未同步的自动补传） */
export async function getAllDocs(): Promise<StoredDocRecord[]> {
  // 本地 IndexedDB（始终读取，作为本地真相）
  const db = await getDb()
  const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<StoredDocRecord[]>
  const local = (await requestResult<StoredDocRecord[]>(req)) || []
  const byId = new Map(local.map(r => [r.id, r]))
  const knownIds = new Set<string>() // 后端所有已知 id（含删除墓碑，用于避免复活补传）

  // 后端文档（跨浏览器共享；后端不可达时跳过）
  if (await checkBackend()) {
    try {
      const res = await fetch(`${BACKEND_BASE}/api/docs`)
      if (res.ok) {
        const list = await res.json() as { id: string; doc: KnowledgeDoc }[]
        // 后端已清空（管理员清空知识库）→ 同步清空本地 IndexedDB 缓存，保证前后端一致
        if (!list || list.length === 0) {
          await clearAllLocal()
          return []
        }
        for (const r of list || []) {
          knownIds.add(r.id)
          if ((r.doc as any).deleted) {
            // 删除墓碑：从结果移除并清理本地缓存（不补传）
            byId.delete(r.id)
            localRemove(r.id).catch(() => {})
            continue
          }
          const existing = byId.get(r.id)
          // 后端元数据为准，本地 blob 仅在本地记录存在时保留（供本浏览器离线阅读）
          byId.set(r.id, { id: r.id, doc: r.doc, blob: existing?.blob } as StoredDocRecord)
        }
      }
    } catch { /* 后端异常，仅用本地 */ }
  }

  // 本地有而后端完全不存在（非墓碑）→ 自动补传（延迟执行，不阻塞）
  if (backendAvailable === true) {
    for (const r of local) {
      if (!knownIds.has(r.id)) {
        const fileBase64 = r.blob ? await blobToBase64(r.blob) : undefined
        postToBackend(r.doc, fileBase64).catch(() => {})
      }
    }
  }

  return Array.from(byId.values())
}

/** 删除本地 IndexedDB 记录 */
async function localRemove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(id)
  await txDone(tx)
}

/** 清空本地 IndexedDB 全部文档缓存（管理员清空知识库时，前后端一起清空） */
async function clearAllLocal(): Promise<void> {
  try {
    const db = await getDb()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await txDone(tx)
  } catch { /* 忽略 */ }
}

/** 删除文档记录（本地 + 后端墓碑） */
export async function removeDoc(id: string): Promise<void> {
  await localRemove(id)
  await deleteFromBackend(id)
}

/** 从持久化记录重建可用的文档列表（本地 Blob 重建 URL；后端文档用后端文件 URL） */
export function restoreDocsFromRecords(records: StoredDocRecord[]): KnowledgeDoc[] {
  return records
    .filter(r => r && r.doc && r.doc.id)
    .map(r => {
      const raw = r.doc
      // 防御性规整：避免脏数据（缺失 summary/keywords/content 等）导致渲染崩溃
      const doc: KnowledgeDoc = {
        ...raw,
        summary: typeof raw.summary === 'string' ? raw.summary : '',
        keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
        content: Array.isArray(raw.content) ? raw.content : [],
        type: (['word', 'ppt', 'excel', 'pdf'].includes(raw.type as string) ? raw.type : 'pdf') as KnowledgeDoc['type'],
        status: (['pending', 'approved', 'rejected'].includes(raw.status as string) ? raw.status : 'pending') as KnowledgeDoc['status'],
      }
      if (r.blob) {
        const url = URL.createObjectURL(r.blob)
        if (doc.type === 'pdf') doc.pdfUrl = url
        else doc.fileUrl = url
      } else {
        // 后端持久化文档：使用后端文件 URL（跨浏览器可见）
        const url = `${BACKEND_BASE}/api/docs/${doc.id}/file`
        if (doc.type === 'pdf') doc.pdfUrl = url
        else doc.fileUrl = url
      }
      return doc
    })
}
