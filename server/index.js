import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { fileURLToPath, pathToFileURL } from 'url'
import { createSystemPrompt } from './systemPrompt.js'
import { PROVIDERS } from '../shared/providers.js'
import {
  configureStorage, resetStorageCache, getPaths,
  isValidId, writeShardSync, readShardSync, rebuildIndexSync, ensureDocsCache, setDocInCache,
  readDocs, withDocsWrite, withUsersWrite, readUsers, writeUsers,
  readLogs, appendLog, writeFileSafe, LOG_ACTIONS, lightweightDoc, FILE_MIME,
} from './storage.js'
import { extractPdfTextFromFile } from './pdfExtract.js'
import { startSummary, getTask, cancelTask, listTasks, recoverSummaryTasks, startTaskCleanup } from './summaryTask.js'
import { configureSearchIndex, buildIndex, search as searchInIndex, getStatus as getIndexStatus, upsertDocument, removeDocument, hasDocument, pagesOfDoc } from './searchIndex.js'

// 优先加载项目根目录 .env，再用 server/.env 覆盖（server/.env 为后端配置真相源）。
dotenv.config()
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env') })

// 全局兜底：未捕获的 Promise 拒绝只记录不退出，避免单个请求异常把整个服务拖垮
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

// 确保数据目录存在（默认 server/data，可用 MES_DATA_DIR 环境变量覆盖，便于测试隔离）
configureStorage()
// 检索索引用 storage 的分片读取获取页正文
configureSearchIndex({ fetchDocRecord: (id) => readShardSync(id) })

// ===== 超大文档列表瘦身阈值 =====
// XML 数据导出常达数千条记录、数十 MB 正文。若每次同步文档列表都全量下发，
// 新浏览器首次打开就要拉取全部正文（数十 MB）并常驻内存。
// 超过阈值的文档只下发元数据（contentOmitted），正文改由 GET /api/docs/:id/pages 按需取，
// 问答检索改由服务端倒排索引 GET /api/search 承担（不受瘦身影响）。
const SLIM_PAGE_THRESHOLD = Number(process.env.SLIM_PAGE_THRESHOLD || 200)      // 页数超过
const SLIM_TEXT_THRESHOLD = Number(process.env.SLIM_TEXT_THRESHOLD || 800_000)  // 或正文字符数超过

/**
 * 估算文档正文字符数（content 结构化分页 / textContent 扁平全文两种形态）。
 * 注意：巨型文档（数十 MB）不能逐页全量求和（每次列表请求都要多花上百毫秒），
 * 因此取前若干页做「采样 × 页数」外推，O(采样量) 即可判断量级。
 */
function estimateTextLen(doc) {
  if (!doc) return 0
  if (typeof doc.textContent === 'string' && doc.textContent.length > 0) return doc.textContent.length
  if (!Array.isArray(doc.content)) return 0
  const pages = doc.content
  if (pages.length <= 20) {
    let n = 0
    for (const p of pages) {
      n += (p && typeof p.title === 'string') ? p.title.length : 0
      if (p && Array.isArray(p.paragraphs)) {
        for (const t of p.paragraphs) n += String(t == null ? '' : t).length
      }
    }
    return n
  }
  let sample = 0
  const SAMPLE = 20
  for (let i = 0; i < SAMPLE; i++) {
    const p = pages[i]
    sample += (p && typeof p.title === 'string') ? p.title.length : 0
    if (p && Array.isArray(p.paragraphs)) {
      for (const t of p.paragraphs) sample += String(t == null ? '' : t).length
    }
  }
  return Math.round(sample / SAMPLE) * pages.length
}

/** 是否需要在列表接口里剥离正文 */
function shouldStripContent(doc) {
  if (!doc) return false
  const hasContent = Array.isArray(doc.content) && doc.content.length > 0
  if (hasContent) return doc.content.length > SLIM_PAGE_THRESHOLD || estimateTextLen(doc) > SLIM_TEXT_THRESHOLD
  // 仅有扁平全文的文档（早期上传的 PDF 等）：同样按字符数上限判断
  const textLen = typeof doc.textContent === 'string' ? doc.textContent.length : 0
  return textLen > SLIM_TEXT_THRESHOLD
}

/** 剥离后的页数估值（避免为了算页数而全量切分正文） */
function approxPageCount(doc) {
  if (Array.isArray(doc.content) && doc.content.length > 0) return doc.content.length
  const textLen = typeof doc.textContent === 'string' ? doc.textContent.length : 0
  return textLen > 0 ? Math.max(1, Math.ceil(textLen / 4000)) : 0
}

const app = express()
// SSE 响应头（流式聊天接口复用）
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
}
const PORT = process.env.PORT || 3001
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// CORS 配置：本应用后端本身就是"CORS 代理"角色（前端直连被浏览器跨域拦截时走后端代理），
// 故允许任意来源（含局域网 IP、WorkBuddy 预览面板等动态 origin）。
// 安全性由 X-Api-Key 校验、可选 ADMIN_TOKEN、每 IP 限流（chatRateLimit）共同保障。
// 注：破坏性写接口（POST /api/docs、DELETE /api/docs/:id、用户表）另由 requireAdmin 保护，
// 默认部署仅回环地址可写、非回环必须携带 ADMIN_TOKEN（见 requireAdmin）。
app.use(cors({
  origin: true, // 回显请求 Origin，放行所有来源（同源无 Origin 也放行）
  credentials: true,
}))
app.use(express.json({ limit: '100mb' }))

// ===== 简单内存限流（防局域网内无限调用消耗 API Key 额度）=====
// 每个 IP 每分钟最多 RATE_LIMIT 次 LLM 调用；超限返回 429。
// 本地/局域网部署下，真正的速率限制应在模型提供商侧（由前端出发闸门处理），
// 此处仅作兜底防爆，阈值需足够宽以容纳「整篇总结」动辄数十段 + 重试的批量调用，避免后端自身 429 与前端闸门打架。
const RATE_LIMIT = 300
const RATE_WINDOW_MS = 60 * 1000
const rateLimitMap = new Map() // ip -> { count, resetAt }
export function chatRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  let entry = rateLimitMap.get(ip)
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS }
    rateLimitMap.set(ip, entry)
  }
  entry.count++
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
  }
  next()
}
// 定期清理过期条目，避免 Map 无限增长
setInterval(() => {
  const now = Date.now()
  for (const [ip, e] of rateLimitMap) {
    if (e.resetAt <= now) rateLimitMap.delete(ip)
  }
}, 5 * 60 * 1000).unref()

// ===== 管理路由鉴权（B1）=====
// 管理类路由（用户表读写、删除文档、写文档）的访问控制：
//  - 设置了 ADMIN_TOKEN：必须携带匹配的 X-Admin-Token 头，否则 403；
//  - 未设置 ADMIN_TOKEN：仅允许回环地址（127.0.0.1 / ::1）访问，非回环地址返回 403。
// 这样在「本机单用户」默认场景下无需配置即可正常使用，同时杜绝局域网任意主机
// 未经授权即清空知识库/用户表/写入文档。若要向局域网开放写操作，请设置 ADMIN_TOKEN
// 并在调用方带上该令牌。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''
function isLoopback(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}
export function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN) {
    const provided = req.headers['x-admin-token']
    if (provided === ADMIN_TOKEN) return next()
    return res.status(403).json({ error: '需要管理员令牌（ADMIN_TOKEN）' })
  }
  if (isLoopback(req)) return next()
  return res.status(403).json({ error: '管理操作仅允许本机访问；局域网开放请设置 ADMIN_TOKEN' })
}

// 为需要 GroupId 的厂商在接口 URL 上拼接 ?GroupId=xxx（如 MiniMax chatcompletion_v2）
export function buildProviderUrl(provider, groupId) {
  if (provider && provider.id === 'minimax' && groupId) {
    const sep = provider.apiUrl.includes('?') ? '&' : '?'
    return `${provider.apiUrl}${sep}GroupId=${encodeURIComponent(groupId)}`
  }
  return provider ? provider.apiUrl : ''
}

// 统一错误响应：业务错误（带 err.status，通常为 4xx）保留原状态码与文案（如 404 文档不存在、409 同名冲突），
// 仅对真实的 500 内部错误脱敏（记录日志 + 返回通用文案），避免把本地路径/内部细节经 err.message 泄露给调用方。
function fail(res, err) {
  const status = err && err.status ? err.status : 500
  if (status === 500) return internalError(res, err)
  return res.status(status).json({ error: String(err && err.message ? err.message : err) })
}
// 内部错误统一脱敏：记录真实错误到服务端日志，但只向客户端返回通用文案，
// 避免把本地文件路径/内部细节经 err.message 泄露给调用方。
function internalError(res, err) {
  console.error('[internal error]', err)
  return res.status(500).json({ error: '服务器内部错误，请稍后再试' })
}

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'proxy',
    providers: Object.keys(PROVIDERS),
    timestamp: new Date().toISOString(),
  })
})

// 列出文档（拆分存储适配）
// - 不带 page 参数：向后兼容路径，返回完整数组（前端 getAllDocs 用于检索，必须含正文/切片）。
//   但超过 SLIM_* 阈值的超大文档（如 XML 数据导出）会剥离正文，改由新增的
//   GET /api/docs/:id/pages 按需取页 + GET /api/search 服务端检索兜住，
//   避免「换一台浏览器就要全量拉取数十 MB 正文」；带 includeContent=1 可强制下发全量。
// - 带 page 参数：分页 + 轻量元数据（不含 textContent/content/summaryChunks），供列表 UI 翻页，降低传输与解析成本
app.get('/api/docs', (_req, res) => {
  try {
    const { page, pageSize, status, q, includeContent } = _req.query
    const all = readDocs()
    if (page === undefined) {
      const list = all.map(r => {
        const doc = { ...r.doc }
        delete doc.fileUrl
        delete doc.pdfUrl
        if (includeContent !== '1' && shouldStripContent(doc)) {
          doc.content = []
          if (typeof doc.textContent === 'string') doc.textContent = ''
          doc.contentOmitted = true
          doc.pageCount = approxPageCount(r.doc)
        }
        return { id: r.id, doc }
      })
      return res.json(list)
    }
    let items = all
    if (status) items = items.filter(r => (r.doc.status || 'pending') === status)
    if (q) {
      const s = String(q).toLowerCase()
      items = items.filter(r => (r.doc.name || '').toLowerCase().includes(s))
    }
    const total = items.length
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200)
    const p = Math.max(parseInt(page, 10) || 1, 1)
    const start = (p - 1) * ps
    const pageItems = items.slice(start, start + ps).map(r => ({ id: r.id, doc: lightweightDoc(r.doc) }))
    res.json({ items: pageItems, total, page: p, pageSize: ps })
  } catch (err) {
    return internalError(res, err)
  }
})

// 按需取「某一页范围」的正文（配 /api/docs 的超大文档瘦身使用）。
// 前端在浏览/预览/构建上下文时才拉取需要的页，避免一次性把数十 MB 正文拉到浏览器。
app.get('/api/docs/:id/pages', (req, res) => {
  const { id } = req.params
  if (!isValidId(id)) return res.status(400).json({ error: '非法的文档 id' })
  ensureDocsCache()
  const rec = readDocs().find(r => r.id === id) || readShardSync(id)
  if (!rec || (rec.doc && rec.doc.deleted)) return res.status(404).json({ error: '文档不存在' })
  // 与索引使用同一套页视图：仅有 textContent 的文档（早期上传的 PDF 等）也能按需取页
  const pages = pagesOfDoc(rec.doc)
  const from = Math.max(0, parseInt(req.query.from, 10) || 0)
  // 单次最多下发 500 页，防止被一次性拉爆（超大文档应配合 titles/服务端检索定位后再取页）
  const MAX_RANGE = 500
  let to = req.query.to !== undefined ? parseInt(req.query.to, 10) : pages.length
  if (!Number.isFinite(to) || to < from) to = pages.length
  to = Math.min(to, from + MAX_RANGE)
  // 标题过滤（精确匹配 SNAPSHOT list）：一次性指定多个 page index 时用 indices=1,2,3
  let picked = null
  if (typeof req.query.indices === 'string' && req.query.indices.trim()) {
    const set = req.query.indices.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0 && n < pages.length)
    picked = Array.from(new Set(set)).sort((a, b) => a - b).slice(0, MAX_RANGE).map(i => ({ ...pages[i], pageNum: pages[i].pageNum ?? i + 1 }))
  }
  res.json({
    id,
    total: pages.length,
    from,
    to: picked ? pages.length : Math.min(to, pages.length),
    pages: picked || pages.slice(from, Math.min(to, pages.length)),
  })
})

// 页标题清单（体积极小，供超大文档在前端做对象名定位/翻页导航）
app.get('/api/docs/:id/titles', (req, res) => {
  const { id } = req.params
  if (!isValidId(id)) return res.status(400).json({ error: '非法的文档 id' })
  ensureDocsCache()
  const rec = readDocs().find(r => r.id === id) || readShardSync(id)
  if (!rec || (rec.doc && rec.doc.deleted)) return res.status(404).json({ error: '文档不存在' })
  const pages = pagesOfDoc(rec.doc)
  res.json({ id, total: pages.length, titles: pages.map(p => String(p && p.title || '')) })
})

// ===== 服务端检索（倒排索引） =====
// 背景：超大文档正文不再全量下发到浏览器后，前端无法再做本地全量扫文本。
// 由服务端承担一次检索：给定查询，返回跨文档的 Top-K 命中页（含截断后的正文片段），
// 前端据此直接组装问答上下文。索引未就绪时返回 ready:false，前端自动退回原有本地检索路径。
app.get('/api/search/status', (_req, res) => {
  res.json(getIndexStatus())
})

app.get('/api/search', (req, res) => {
  try {
    const q = String(req.query.q || '').slice(0, 500)
    const topK = Math.min(Math.max(parseInt(req.query.topK, 10) || 20, 1), 200)
    const perHitChars = Math.min(Math.max(parseInt(req.query.perHitChars, 10) || 6000, 200), 60000)
    const docIdsRaw = typeof req.query.docIds === 'string' ? req.query.docIds : null
    const docIds = docIdsRaw ? docIdsRaw.split(',').filter(Boolean).slice(0, 200) : null
    const status = getIndexStatus()
    if (!status.ready) return res.json({ ...status, hits: [], tookMs: 0, total: 0 })
    const result = searchInIndex(q, { topK, perHitChars, docIds })
    res.json({ ...result, ...getIndexStatus() })
  } catch (err) {
    return internalError(res, err)
  }
})

// 获取单篇完整文档（含正文），供前端按需补全检索内容
app.get('/api/docs/:id', (req, res) => {
  const { id } = req.params
  if (!isValidId(id)) return res.status(400).json({ error: '非法的文档 id' })
  ensureDocsCache()
  const rec = readDocs().find(r => r.id === id) || readShardSync(id)
  if (!rec || (rec.doc && rec.doc.deleted)) return res.status(404).json({ error: '文档不存在' })
  const doc = { ...rec.doc }
  delete doc.fileUrl
  delete doc.pdfUrl
  res.json({ id, doc })
})

// 保存/更新文档（可选携带原始文件 base64）—— 写操作需管理鉴权
app.post('/api/docs', requireAdmin, async (req, res) => {
  try {
    const { id, doc, fileBase64 } = req.body || {}
    if (!id || !doc) return res.status(400).json({ error: 'id 和 doc 为必填' })
    if (!isValidId(id)) return res.status(400).json({ error: '非法的文档 id' })

    // I4：上传前校验原始文件体积与类型，拒绝超大/非法文件写盘
    if (typeof fileBase64 === 'string' && fileBase64.length > 0) {
      const approxBytes = Math.floor((fileBase64.length * 3) / 4)
      if (approxBytes > 100 * 1024 * 1024) {
        return res.status(413).json({ error: '文件过大（上限 100MB）' })
      }
      const ext = ((doc.name || '').split('.').pop() || '').toLowerCase()
      if (!Object.keys(FILE_MIME).includes(ext)) {
        return res.status(400).json({ error: `不支持的文件类型: .${ext}` })
      }
    }

    const isReupload = typeof fileBase64 === 'string' && fileBase64.length > 0

    // 在串行队列内完成 read-modify-write（B2 防并发丢数据；R5 跨端同名去重）。
    // 只写对应分片 + 重建轻量索引，不再重写整文件（性能关键改进）。
    await withDocsWrite(() => {
      ensureDocsCache()
      const docs = readDocs()
      const existing = docs.find(r => r.id === id)
      // 若该文档已被删除（墓碑），且本次不是重新上传，拒绝更新，防止用旧数据把已删除文档“复活”
      if (existing && existing.doc.deleted && !isReupload) {
        const e = new Error('该文档已被删除，无法更新（请刷新页面）')
        e.status = 409
        throw e
      }
      // R5：非重传的新文档若与已存在（未删除）文档同名 → 拒绝并回传已有 id，避免跨浏览器重复
      if (!existing && !isReupload) {
        const dup = docs.find(r => r.doc.name === doc.name && !r.doc.deleted)
        if (dup) {
          const e = new Error('同名文档已存在')
          e.status = 409
          e.existingId = dup.id
          throw e
        }
      }
      const record = { id, doc: { ...doc } }
      delete record.doc.deleted // 重新上传时清除删除墓碑
      delete record.doc.fileUrl
      delete record.doc.pdfUrl
      setDocInCache(id, record) // 更新内存缓存
      writeShardSync(id, record) // 仅写这一篇分片（O(1)，不再重写全量）
      rebuildIndexSync() // 轻量索引很小，整体重写开销可忽略
      // 同步更新服务端倒排索引：仅在已入索引或本次已入库时刷新，避免巨量文档重复构建
      if (hasDocument(id) || (record.doc.status === 'approved' && !record.doc.deleted)) {
        try { upsertDocument(id, record.doc) } catch (e) { console.error('[warn] 检索索引更新失败:', e && e.message) }
      }
    })

    if (typeof fileBase64 === 'string' && fileBase64.length > 0) {
      // 写盘包一层兜底：瞬时错误重试已由 writeFileSafe 处理；即便最终失败也只记录、不抛出，
      // 避免把整个服务进程拖垮（文档元数据已落盘，仅“阅读原文”可能 404，可由用户重传）
      try {
        const filesDir = getPaths().FILES_DIR
        await writeFileSafe(path.join(filesDir, id), Buffer.from(fileBase64, 'base64'))
        const ext = (doc.name || '').split('.').pop() || 'bin'
        await writeFileSafe(path.join(filesDir, id + '.ext'), ext)
      } catch (err) {
        console.error('[warn] 原始文件写盘失败（文档元数据已保存）:', err)
      }
    }
    res.json({ ok: true, id })
  } catch (err) {
    const status = err && err.status ? err.status : 500
    res.status(status).json({
      error: String(err && err.message ? err.message : err),
      ...(err && err.existingId ? { existingId: err.existingId } : {}),
    })
  }
})

// 删除文档（标记删除墓碑而非物理删除，防止其他浏览器本地缓存刷新时"复活"）
app.delete('/api/docs/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    if (!isValidId(id)) return res.status(400).json({ error: '非法的文档 id' })
    // 只更新对应分片为墓碑 + 重建轻量索引（不重写整文件）
    await withDocsWrite(() => {
      ensureDocsCache()
      const existing = readDocs().find(r => r.id === id)
      if (!existing) {
        const e = new Error('文档不存在')
        e.status = 404
        throw e
      }
      const tombstone = { id, doc: { deleted: true, name: '已删除', id } }
      setDocInCache(id, tombstone)
      writeShardSync(id, tombstone)
      rebuildIndexSync()
      // 未入库文档的正文与总结切片都不进问答检索，索引同样应移除（防止已删文档内容被召回）
      try { removeDocument(id) } catch (e) { console.error('[warn] 检索索引移除失败:', e && e.message) }
    })
    try { fs.unlinkSync(path.join(getPaths().FILES_DIR, id)) } catch { /* 忽略 */ }
    try { fs.unlinkSync(path.join(getPaths().FILES_DIR, id + '.ext')) } catch { /* 忽略 */ }
    res.json({ ok: true })
  } catch (err) {
    return fail(res, err)
  }
})

// 获取原始文件（阅读原文/在线预览/下载）
app.get('/api/docs/:id/file', (req, res) => {
  const { id } = req.params
  if (!isValidId(id)) return res.status(400).json({ error: '非法的文档 id' })
  const filePath = path.join(getPaths().FILES_DIR, id)
  // 防御性校验：确保解析后的路径仍位于 FILES_DIR 内（双保险，配合 isValidId）
  if (path.resolve(filePath) !== path.resolve(getPaths().FILES_DIR, id)) {
    return res.status(400).json({ error: '非法路径' })
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' })
  let ext = 'bin'
  try { ext = fs.readFileSync(path.join(getPaths().FILES_DIR, id + '.ext'), 'utf8') } catch { /* 忽略 */ }
  res.setHeader('Content-Type', FILE_MIME[ext] || 'application/octet-stream')
  res.setHeader('Content-Disposition', 'inline')
  fs.createReadStream(filePath).pipe(res)
})

// 提取后端托管 PDF 的文本内容（服务端 pdfjs，规避浏览器端取不出文字层的问题）
// 仅读取 files/ 下的 PDF，不重命名/不删除，规避环境中 rename 覆盖被拦的问题。
app.get('/api/docs/:id/text', async (req, res) => {
  const { id } = req.params
  if (!isValidId(id)) return res.status(400).json({ error: '非法的文档 id' })
  try {
    const filesDir = getPaths().FILES_DIR
    const filePath = path.join(filesDir, id)
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' })
    let ext = 'bin'
    try { ext = (fs.readFileSync(path.join(filesDir, id + '.ext'), 'utf8') || '').toLowerCase() } catch { /* 忽略 */ }
    if (ext !== 'pdf') return res.status(400).json({ error: '仅支持 PDF 文本提取' })
    const text = await extractPdfTextFromFile(filePath)
    res.json({ text })
  } catch (err) {
    return internalError(res, err)
  }
})

// ===== 用户表持久化（跨浏览器/设备共享）=====
app.get('/api/users', requireAdmin, (_req, res) => {
  res.json({ users: readUsers() })
})
app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { users } = req.body || {}
    if (!users || typeof users !== 'object' || Array.isArray(users)) {
      return res.status(400).json({ error: 'users 为必填对象' })
    }
    // 串行化整表写入（B2 / I5：避免并发注册/同步时整表覆盖丢失账号）。
    // 注意：withUsersWrite 会先 readUsers() 再回调 fn(旧对象) 最后 writeUsers(该对象)，
    // 因此回调里必须「覆盖到读到的对象」而非直接 writeUsers，否则会被随后用旧对象写回覆盖掉。
    await withUsersWrite((localUsers) => {
      for (const k of Object.keys(localUsers)) delete localUsers[k]
      Object.assign(localUsers, users)
    })
    res.json({ ok: true })
  } catch (err) {
    return internalError(res, err)
  }
})

// ===== 知识库操作日志（上传/删除/审核/总结 的人员与时间） =====
app.get('/api/doc-logs', (_req, res) => {
  try {
    res.json({ logs: readLogs() })
  } catch (err) {
    return internalError(res, err)
  }
})

app.post('/api/doc-logs', async (req, res) => {
  try {
    const body = req.body || {}
    const log = body.log
    if (!log || typeof log !== 'object') {
      return res.status(400).json({ error: 'log 为必填对象' })
    }
    const { action, operator, operatorName, department, target, detail } = log
    if (!LOG_ACTIONS.includes(action) || !operator) {
      return res.status(400).json({ error: 'action 与 operator 为必填且 action 须合法' })
    }
    if (typeof operator !== 'string' || operator.length > 60 ||
        (operatorName && typeof operatorName !== 'string') || (operatorName && operatorName.length > 60) ||
        (department && typeof department !== 'string') || (department && department.length > 60) ||
        (target && typeof target !== 'string') || (target && target.length > 300) ||
        (detail && typeof detail !== 'string') || (detail && detail.length > 500)) {
      return res.status(400).json({ error: '字段长度超限或类型错误' })
    }
    const entry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: String(action),
      operator: String(operator),
      operatorName: operatorName ? String(operatorName) : '',
      department: department ? String(department) : '',
      target: target ? String(target) : '',
      detail: detail ? String(detail) : '',
      time: new Date().toISOString(),
    }
    // 串行写入，避免多用户并发丢失日志（含 5000 条上限）
    await appendLog(entry)
    res.json({ ok: true, log: entry })
  } catch (err) {
    return internalError(res, err)
  }
})

// ===== 聊天接口（SSE 流式代理） =====
// 前端通过 X-Api-Key Header 传入用户自己的 API Key
// 后端仅作为 CORS 代理，不存储 Key
app.post('/api/chat', chatRateLimit, async (req, res) => {
  let chatTimeout
  let streamTotalTimeout
  // 首字节到达后解除「等待首字」超时；STREAM_TOTAL_MS 作为「整段流式」兜底上限，防止模型吐字后连接彻底卡死而无限挂起
  const STREAM_TOTAL_MS = 600000
  try {
    const { messages, useThinking = false, knowledgeContext = '', providerId = 'deepseek', modelId, groupId, timeoutMs } = req.body

    // 诊断日志：记录每次 chat 请求的提供商/模型/Key 状态/来源，便于排查「正在分析中」卡死
    const reqKey = req.headers['x-api-key'] || process.env.LLM_API_KEY
    console.log('[chat] req', JSON.stringify({
      providerId,
      modelId: modelId || '(default)',
      msgCount: Array.isArray(messages) ? messages.length : 0,
      kbLen: (knowledgeContext || '').length,
      keyPresent: !!reqKey,
      keyLen: (reqKey || '').length,
      origin: req.headers.origin || req.headers.referer || '-',
    }))

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages is required and must be an array' })
    }
    if (messages.length === 0) {
      return res.status(400).json({ error: 'messages 不能为空' })
    }

    // 基础输入防护：限制消息条数/长度，拒绝畸形或超大负载（防注入与资源耗尽）
    if (messages.length > 200) {
      return res.status(400).json({ error: '消息数量过多' })
    }
    for (const m of messages) {
      if (!m || typeof m.content !== 'string' || m.content.length > 200000) {
        return res.status(400).json({ error: '单条消息过长或格式错误' })
      }
    }
    if (typeof knowledgeContext === 'string' && knowledgeContext.length > 300000) {
      return res.status(400).json({ error: '知识库上下文过长' })
    }

    // 优先使用前端传入的 Key，其次使用 .env 中的 Key
    const apiKey = req.headers['x-api-key'] || process.env.LLM_API_KEY

    if (!apiKey || apiKey.length < 10) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({
        type: 'error',
        content: '未提供 API Key。请在页面中配置你的 API Key。',
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    // 获取提供商配置
    const provider = PROVIDERS[providerId] || PROVIDERS.deepseek
    const isLocal = providerId === 'ollama'
    const model = modelId || provider.defaultModel
    // E2：推理模型（reasoner/qwq）不支持 temperature/top_p，跳过以免代理报错；与 chat-once 保持一致
    const isReasoning = /reasoner|qwq|reasoning/i.test(model)

    // 构建系统提示词（注入知识库上下文）
    const systemPrompt = createSystemPrompt() + (knowledgeContext || '')

    // 构建请求消息
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    ]

    // 调用 LLM API（带超时与客户端断开中止，避免请求挂起占用资源）
    // 说明：使用 Node 原生 http/https 模块，而非全局 fetch(undici)。
    // undici 的 fetch 在消费 Ollama 等 SSE 流式响应时，会在连接建立 / 等待首字阶段偶发抛
    // AbortError（与部分 SSE 服务端 keep-alive 行为不兼容），导致问答直接「服务器内部错误」。
    // 改用 http.request 直接读取上游响应流并透传 SSE，规避该问题，同时保留 OpenAI→前端 {type} 格式转换。
    const upstreamUrl = new URL(buildProviderUrl(provider, groupId))
    const upstreamModule = upstreamUrl.protocol === 'https:' ? https : http

    let streamingStarted = false
    let upstreamReq

    // 统一的上游错误处理：仅在尚未正常结束时，回写 SSE error 事件
    const failUpstream = (msg) => {
      clearTimeout(chatTimeout)
      clearTimeout(streamTotalTimeout)
      console.error('[chat] upstream error:', msg)
      if (!res.headersSent) {
        res.writeHead(200, SSE_HEADERS)
        streamingStarted = true
      }
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', content: String(msg || '模型接口连接失败，请稍后再试') })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }

    // 「等待首字」上限：本地模型 150s（处理知识库大上下文时 CPU prompt 处理慢，60s 不够），云端 60s。
    // 若前端传了 timeoutMs（流式问答会传，使后端早于前端超时并先发干净错误），则取二者较小值，
    // 避免后端还在等时前端已 abort 而被误报为「后端代理不可用」。
    const maxTimeout = isLocal ? 150000 : 60000
    const chatTimeoutMs = (Number.isFinite(timeoutMs) && timeoutMs > 0)
      ? Math.min(timeoutMs, maxTimeout)
      : maxTimeout
    chatTimeout = setTimeout(() => {
      if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy()
      failUpstream(`模型响应超时（${Math.round(chatTimeoutMs / 1000)}s），请稍后再试`)
    }, chatTimeoutMs)

    // 仅在「已开始向客户端流式输出」后，才把 res 的 'close' 当成「客户端真实断开」并中止上游。
    // 否则 res 的 'close' 可能在连接建立 / keep-alive 阶段被过早触发，误伤正常请求。
    res.on('close', () => {
      if (streamingStarted && !res.writableEnded && upstreamReq && !upstreamReq.destroyed) {
        clearTimeout(chatTimeout)
        clearTimeout(streamTotalTimeout)
        upstreamReq.destroy()
      }
    })

    const requestBody = JSON.stringify({
      model,
      messages: apiMessages,
      stream: true,
      max_tokens: 8192,
      ...(isReasoning ? {} : { temperature: 0.7 }),
    })

    try {
      upstreamReq = upstreamModule.request(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      }, (upstreamRes) => {
        const status = upstreamRes.statusCode || 0
        upstreamRes.setEncoding('utf8')

        // 上游返回错误状态码：读取错误体并透出（含 Ollama/厂商的明文错误）
        if (status >= 400) {
          let errBody = ''
          upstreamRes.on('data', (c) => { errBody += c })
          upstreamRes.on('end', () => {
            clearTimeout(chatTimeout)
            let detail = errBody.slice(0, 300)
            try {
              const j = JSON.parse(errBody)
              const m = j?.error?.message || j?.error || j?.message
              if (typeof m === 'string' && m.trim()) detail = m.trim()
            } catch { /* 保留原文 */ }
            failUpstream(`${provider.name} API 调用失败 (${status}): ${detail}`)
          })
          return
        }

        // 正常：SSE 透传 + 格式转换（OpenAI delta → 前端 {type} 事件）
        res.writeHead(200, SSE_HEADERS)
        streamingStarted = true
        console.log('[chat] upstream OK, start streaming')
        // 首字节已到达：解除「等待首字」超时，避免把正常的长生成（如长篇算法说明）误杀为「响应超时」；
        // 同时启动一个更长的整段流式兜底超时，防止模型吐字后连接彻底卡死而无限挂起。
        clearTimeout(chatTimeout)
        streamTotalTimeout = setTimeout(() => {
          if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy()
          failUpstream(`模型响应超时（${Math.round(STREAM_TOTAL_MS / 1000)}s），请稍后再试`)
        }, STREAM_TOTAL_MS)
        let buffer = ''
        let sawUpstreamDone = false

        const processBuffer = () => {
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') { sawUpstreamDone = true; res.write('data: [DONE]\n\n'); continue }
            try {
              const parsed = JSON.parse(data)
              // R8：MiniMax 等接口对无效 Key/参数错误仍返回 HTTP 200，把错误塞进 SSE 首个 data 块
              // （base_resp.status_code≠0 或 error 字段）。识别后立刻以 error 事件透出，避免表现为“无响应”。
              const bizErr = (parsed?.base_resp && typeof parsed.base_resp.status_code === 'number' && parsed.base_resp.status_code !== 0)
                ? (parsed.base_resp.status_msg || `状态码 ${parsed.base_resp.status_code}`)
                : (typeof parsed?.error?.message === 'string' ? parsed.error.message
                  : (typeof parsed?.error === 'string' ? parsed.error : null))
              if (bizErr) {
                res.write(`data: ${JSON.stringify({ type: 'error', content: `${provider.name} API 调用失败: ${bizErr}` })}\n\n`)
                res.write('data: [DONE]\n\n')
                res.end()
                return
              }
              const delta = parsed.choices?.[0]?.delta
              if (delta?.reasoning_content) {
                res.write(`data: ${JSON.stringify({ type: 'thinking', content: delta.reasoning_content })}\n\n`)
              }
              if (delta?.content) {
                res.write(`data: ${JSON.stringify({ type: 'content', content: delta.content })}\n\n`)
              }
            } catch { /* 忽略解析错误 */ }
          }
        }

        upstreamRes.on('data', (chunk) => { buffer += chunk; if (!res.writableEnded) processBuffer() })
        upstreamRes.on('end', () => {
          clearTimeout(streamTotalTimeout)
          if (!res.writableEnded) {
            processBuffer()
            if (!sawUpstreamDone) res.write('data: [DONE]\n\n')
            res.end()
          }
        })
        upstreamRes.on('error', (e) => failUpstream(`模型接口流读取失败: ${e?.message || e}`))
      })

      upstreamReq.on('error', (e) => failUpstream(`模型接口连接失败: ${e?.message || e}`))
      upstreamReq.write(requestBody)
      upstreamReq.end()
    } catch (err) {
      failUpstream(`模型接口请求异常: ${err?.message || err}`)
    }
  } catch (error) {
    clearTimeout(chatTimeout)
    console.error('Chat API error:', error)
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
    }
    res.write(`data: ${JSON.stringify({
      type: 'error',
      content: '服务器内部错误，请稍后再试',
    })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }
})

// ===== 非流式一次性补全（知识库整表/整文档总结等批处理）=====
app.post('/api/chat-once', chatRateLimit, async (req, res) => {
  let onceTimeout
  try {
    const { messages, providerId = 'deepseek', modelId, maxTokens = 4096, groupId, timeoutMs } = req.body || {}
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages is required and must be an array' })
    }
    if (messages.length === 0) {
      return res.status(400).json({ error: 'messages 不能为空' })
    }

    const apiKey = req.headers['x-api-key'] || process.env.LLM_API_KEY
    if (!apiKey || apiKey.length < 10) {
      return res.status(400).json({ error: '未提供 API Key' })
    }

    const provider = PROVIDERS[providerId] || PROVIDERS.deepseek
    const model = modelId || provider.defaultModel
    const isReasoning = /reasoner|qwq|reasoning/i.test(model)
    const body = {
      model,
      messages,
      stream: false,
      max_tokens: maxTokens,
      ...(isReasoning ? {} : { temperature: 0.3, top_p: 0.85 }),
    }

    // 服务端超时须【早于】前端 fetchWithTimeout（前端传入 timeoutMs），让后端在连接断开前主动返回干净的超时错误，
    // 而非被前端中断(abort)导致前端只看到「signal is aborted without reason」、且后端连接仍被占用堆积。
    // 本地 Ollama 为离线 CPU 推理，首次加载 7B 模型可能耗时数十秒，故本地模型给予更宽裕的上限（180s）。
    const isLocal = providerId === 'ollama'
    const maxTimeout = isLocal ? 300000 : 170000
    const clientTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, maxTimeout)
      : (isLocal ? 60000 : 30000)
    const controller = new AbortController()
    onceTimeout = setTimeout(() => controller.abort(), Math.max(8000, clientTimeout - 5000))

    const response = await fetch(buildProviderUrl(provider, groupId), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return res.status(response.status).json({ error: `${provider.name} API 调用失败 (${response.status}): ${errorText}` })
    }

    const data = await response.json().catch(() => null)
    // MiniMax 等接口对无效 Key 仍返回 HTTP 200，错误藏在 body（base_resp.status_code≠0）里；
    // 否则测试"通过"判定会误判。这里识别并转为真实错误返回。
    if (data?.base_resp && typeof data.base_resp.status_code === 'number' && data.base_resp.status_code !== 0) {
      return res.status(401).json({ error: `${provider.name} API 调用失败: ${data.base_resp.status_msg || ('状态码 ' + data.base_resp.status_code)}` })
    }
    if (data?.error) {
      return res.status(400).json({ error: `${provider.name} API 调用失败: ${data.error.message || data.error}` })
    }

    const content = data?.choices?.[0]?.message?.content ?? data?.output?.text
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(502).json({ error: `${provider.name} 返回为空，可能 Key 无效或参数不被支持` })
    }
    return res.json({ content })
  } catch (err) {
    clearTimeout(onceTimeout)
    // 区分「后端到模型的请求超时(abort)」与「其他异常」：超时返回 504 + 含「超时」字样，
    // 便于前端重试逻辑识别为瞬时错误自动退避重试，而非当作硬失败直接放弃该段。
    const aborted = !!(err && (err.name === 'AbortError' || controller.signal.aborted))
    if (aborted) {
      return res.status(504).json({ error: '模型接口响应超时（请稍后重试或降低并发）' })
    }
    console.error('[chat-once] internal error:', err)
    return res.status(500).json({ error: '服务器内部错误，请稍后再试' })
  }
})

// ===== 整篇总结后台任务（关闭/刷新前端后仍在后端继续，可断点续跑）=====
app.post('/api/summary/start', async (req, res) => {
  try {
    const { docId, sheetName, instruction, providerId, modelId, groupId } = req.body || {}
    if (!docId || !isValidId(docId)) return res.status(400).json({ error: 'docId 无效' })
    // 文档必须存在，避免为不存在的文档落盘孤儿任务文件
    const shard = readShardSync(docId)
    if (!shard || !shard.doc || shard.doc.deleted) return res.status(400).json({ error: '文档不存在' })
    // 仅允许已入库（审核通过）的文档总结：
    // 未入库文档的正文与其总结切片都不会进入问答检索（buildKnowledgeContext 只取 approved），
    // 此时生成总结既浪费算力又会被误认为"已入库可用"，故直接拒绝。
    if ((shard.doc.status || 'pending') !== 'approved') {
      return res.status(400).json({ error: '文档尚未入库，请先点击「确认入库」后再进行总结' })
    }
    const apiKey = req.headers['x-api-key'] || process.env.LLM_API_KEY
    if (!apiKey || apiKey.length < 10) return res.status(400).json({ error: '未提供 API Key' })
    const task = startSummary({ docId, sheetName: sheetName || null, instruction: instruction || '', providerId: providerId || 'deepseek', modelId: modelId || null, groupId: groupId || null, apiKey })
    const { apiKey: _k, ...safe } = task
    res.json(safe)
  } catch (e) {
    return internalError(res, e)
  }
})

app.get('/api/summary/list', (req, res) => {
  try {
    const docId = req.query.docId
    res.json({ tasks: listTasks(docId || undefined) })
  } catch (e) {
    return internalError(res, e)
  }
})

app.get('/api/summary/:taskId', (req, res) => {
  if (!isValidId(req.params.taskId)) return res.status(400).json({ error: '非法的 taskId' })
  const t = getTask(req.params.taskId)
  if (!t) return res.status(404).json({ error: '任务不存在' })
  const { apiKey: _k, ...safe } = t
  res.json(safe)
})

app.post('/api/summary/:taskId/cancel', (req, res) => {
  if (!isValidId(req.params.taskId)) return res.status(400).json({ error: '非法的 taskId' })
  const ok = cancelTask(req.params.taskId)
  res.json({ ok })
})

// ===== 静态前端托管（生产/局域网部署：同一端口同时提供前端与 API）=====
const DIST_DIR = path.join(__dirname, '..', 'dist')
if (fs.existsSync(DIST_DIR)) {
  const indexHtml = path.join(DIST_DIR, 'index.html')
  app.use(express.static(DIST_DIR, { extensions: ['html'] }))
  // SPA 兜底：非 /api 的 GET 请求返回 index.html；未匹配的 /api 返回 404
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not Found' })
    if (req.method !== 'GET') return next()
    res.sendFile(indexHtml)
  })
  console.log(`  Static:    serving dist/ (本机访问 http://127.0.0.1:${PORT}；如需局域网访问请设 HOST=0.0.0.0 并配置 ADMIN_TOKEN)`)
} else {
  console.log(`  Static:    dist/ 未构建，仍可用 vite preview 访问前端`)
}

// ===== 启动服务器 =====
// 仅在直接执行本文件时监听端口（被测试/其他模块 import 时不自动启动）。
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href
const SEARCH_INDEX_ENABLED = process.env.SEARCH_INDEX !== '0'
if (isMain) {
  // 服务启动：恢复磁盘上未完成的总结任务（断点续跑）
  try { recoverSummaryTasks() } catch (e) { console.error('[summaryTask] recover failed', e && e.message) }
  // 后台构建服务端检索倒排索引（不阻塞启动；未就绪期间前端自动退回本地检索）
  if (SEARCH_INDEX_ENABLED) {
    setImmediate(() => {
      const t0 = Date.now()
      try {
        ensureDocsCache()
        const recs = readDocs()
        buildIndex(recs).then(st => {
          console.log(`  Search:    倒排索引就绪 ${st.docCount} 篇 / ${st.pageCount} 页 / ${st.termCount} 词（${Date.now() - t0}ms）`)
        }).catch(e => console.error('[searchIndex] build failed', e && e.message))
      } catch (e) {
        console.error('[searchIndex] build start failed', e && e.message)
      }
    })
  }
  // 启动周期性任务清理（删除过期终态任务文件 + 内存视图延迟回收）
  try { startTaskCleanup() } catch (e) { console.error('[summaryTask] cleanup start failed', e && e.message) }
  // 双栈监听 IPv4+IPv6（'::' 为 IPv6 通配符，Node 默认 dual-stack），
  // 使 localhost(→::1)、127.0.0.1、局域网 IPv4 均能访问，
  // 避免 Windows 浏览器把 localhost 解析为 ::1 时连接被拒而误报「后端代理不可用」。
  // 不再依赖 HOST 环境变量（旧方案设 HOST=0.0.0.0 只监听 IPv4，localhost 仍可能失败）。
  // 默认 '::' 双栈；容器部署时 Docker 默认网络可能未启用 IPv6，绑定 '::' 会失败，
  // 故支持通过 HOST 环境变量覆盖（docker-compose 中设为 0.0.0.0）。
  const HOST = process.env.HOST || '::'
  app.listen(PORT, HOST, () => {
    console.log(`\n========================================`)
    console.log(`  AI Assistant - Backend Proxy`)
    console.log(`========================================`)
    console.log(`  Port:      ${PORT} (监听 ${HOST}${HOST === '127.0.0.1' ? '，仅本机可访问' : '，已对局域网开放'})`)
    console.log(`  Mode:      CORS Proxy`)
    console.log(`  Providers: ${Object.keys(PROVIDERS).join(', ')}`)
    console.log(`----------------------------------------`)
    console.log(`  API Key 由前端用户提供（X-Api-Key Header）`)
    console.log(`  ${process.env.LLM_API_KEY ? '(.env 中的 Key 作为备用)' : '(.env 未配置 Key)'}`)
    console.log(`  ${ADMIN_TOKEN ? '管理操作：已启用 ADMIN_TOKEN' : '管理操作：仅本机(loopback)可写'}`)
    console.log(`========================================\n`)
  })
}

export { app, configureStorage, resetStorageCache }
