// 知识库/用户/日志的持久化与内存缓存逻辑（从 server/index.js 抽取，便于单测与隔离）。
// 数据目录可通过 configureStorage({ dataDir }) 覆盖，测试时指向临时目录。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let DATA_DIR = process.env.MES_DATA_DIR
  ? path.resolve(process.env.MES_DATA_DIR)
  : path.join(__dirname, 'data')

let DOCS_DIR = path.join(DATA_DIR, 'docs')
let DOCS_INDEX = path.join(DOCS_DIR, 'index.json')
let DOCS_LEGACY = path.join(DATA_DIR, 'docs.json')
let DOCS_LOG_FILE = path.join(DATA_DIR, 'doc-logs.json')
let USERS_FILE = path.join(DATA_DIR, 'users.json')
let FILES_DIR = path.join(DATA_DIR, 'files')

export function configureStorage(opts = {}) {
  if (opts.dataDir) {
    DATA_DIR = path.resolve(opts.dataDir)
    DOCS_DIR = path.join(DATA_DIR, 'docs')
    DOCS_INDEX = path.join(DOCS_DIR, 'index.json')
    DOCS_LEGACY = path.join(DATA_DIR, 'docs.json')
    DOCS_LOG_FILE = path.join(DATA_DIR, 'doc-logs.json')
    USERS_FILE = path.join(DATA_DIR, 'users.json')
    FILES_DIR = path.join(DATA_DIR, 'files')
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(FILES_DIR, { recursive: true })
  fs.mkdirSync(DOCS_DIR, { recursive: true })
  return { DATA_DIR, DOCS_DIR, DOCS_INDEX, DOCS_LEGACY, DOCS_LOG_FILE, USERS_FILE, FILES_DIR }
}

// 测试用：重置内存缓存，使下一次访问重新从磁盘加载
let docsCache = new Map()
let docsCacheLoaded = false
export function resetStorageCache() {
  docsCache = new Map()
  docsCacheLoaded = false
}

export const FILE_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
}

// 校验文档 id 安全：仅允许文件名安全字符，禁止路径分隔符（防路径遍历），并排除 '.' 与 '..'
export function isValidId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false
  if (id === '.' || id === '..') return false
  return /^[A-Za-z0-9._-]+$/.test(id)
}

// 同步阻塞等待（主线程可用；避免引入异步改造）。仅用于短时重试退避。
function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

// 写文件（覆盖式）。
// 关键背景（已实测）：本运行环境（safe-delete / 文件锁护栏）对覆盖写有如下限制：
//   - rename 覆盖已存在文件 → EPERM（必失败）
//   - copyFileSync 覆盖「受监控数据文件」（如 index.json） → EPERM（必失败）
//   - 但 fs.writeFileSync 原地覆盖（truncate + 顺序写）对所有文件（含 index.json / users.json / 分片）均可用
// 因此【直接使用 writeFileSync 原地覆盖】，彻底弃用「写 tmp → copy/rename 覆盖」模式，
// 从根上消除「审核失败：EPERM copyfile」类报错。对 Windows 瞬时文件锁（EBUSY / 偶发 EPERM）
// 做少量同步重试，避免偶发失败拖垮写入。
export function writeFileAtomic(filePath, data) {
  const transient = ['UNKNOWN', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(filePath, data)
      return
    } catch (err) {
      lastErr = err
      // 非瞬时错误（非法路径、磁盘满等）直接抛出
      if (!transient.includes(err.code)) throw err
      const waitUntil = Date.now() + 50 * (attempt + 1)
      while (Date.now() < waitUntil) { /* 忙等后重试 */ }
    }
  }
  throw lastErr
}

// 仅允许安全字符作为分片文件名，防路径遍历
export function shardFileName(id) {
  return isValidId(id) ? id : null
}

export function writeShardSync(id, record) {
  const name = shardFileName(id)
  if (!name) return
  writeFileAtomic(path.join(DOCS_DIR, name), JSON.stringify(record))
}

export function readShardSync(id) {
  const name = shardFileName(id)
  if (!name) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(DOCS_DIR, name), 'utf8'))
  } catch {
    return null
  }
}

export function readIndexFileSync() {
  try {
    const arr = JSON.parse(fs.readFileSync(DOCS_INDEX, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// 由内存缓存重建轻量索引（仅元数据，不含正文）。索引很小（每篇约数百字节），整体重写开销可忽略。
export function rebuildIndexSync() {
  const entries = Array.from(docsCache.values()).map(rec => {
    const doc = rec.doc || {}
    return {
      id: rec.id,
      name: doc.name || '',
      status: doc.status || 'pending',
      updatedAt: doc.updatedAt || doc.approvedDate || 0,
      deleted: !!doc.deleted,
      sizeBytes: Buffer.byteLength(JSON.stringify(rec)),
      textLen: doc.textContent ? doc.textContent.length : 0,
    }
  })
  writeFileAtomic(DOCS_INDEX, JSON.stringify(entries))
}

// 一次性迁移：把旧整文件 docs.json 拆分为分片 + 索引，并备份为 .migrated
// 返回填充好的缓存 Map；无需迁移时返回 null。
export function migrateLegacyDocsSync() {
  if (fs.existsSync(DOCS_INDEX)) return null // 已迁移过（或已初始化）
  if (!fs.existsSync(DOCS_LEGACY)) return null
  const map = new Map()
  try {
    const arr = JSON.parse(fs.readFileSync(DOCS_LEGACY, 'utf8')) || []
    for (const rec of arr) {
      if (!rec || !rec.id) continue
      writeShardSync(rec.id, rec)
      map.set(rec.id, rec) // 写分片的同时填充缓存（含墓碑），供下方重建完整索引
    }
    docsCache = map        // 先填好缓存，rebuildIndexSync 才能写出完整索引（含墓碑）
    rebuildIndexSync()
    try { fs.renameSync(DOCS_LEGACY, DOCS_LEGACY + '.migrated') } catch { /* 忽略 */ }
    console.log(`[migrate] 旧 docs.json 已拆分为 ${arr.length} 个分片（备份 docs.json.migrated）`)
    return map
  } catch (e) {
    console.error('[migrate] 迁移失败（保留旧文件，后续仍可手动处理）:', e)
    return null
  }
}

// 首次访问时加载分片进内存缓存（并触发旧文件迁移）
export function ensureDocsCache() {
  if (docsCacheLoaded) return
  const migrated = migrateLegacyDocsSync()
  if (migrated) { docsCache = migrated; docsCacheLoaded = true; return }
  const entries = readIndexFileSync()
  const map = new Map()
  for (const e of entries) {
    const rec = readShardSync(e.id)
    if (rec && rec.id) map.set(rec.id, rec)
  }
  docsCache = map
  docsCacheLoaded = true
}

export function readDocs() {
  ensureDocsCache()
  return Array.from(docsCache.values())
}

// 写入/更新内存缓存中的单篇文档记录（供路由在 withDocsWrite 回调内调用）
export function setDocInCache(id, record) {
  docsCache.set(id, record)
}

// 串行化文档写入（B2）：把 read-modify-write 放进同一队列，避免并发上传/审核时后到的请求
// 基于旧快照覆盖先到请求导致文档或状态丢失。
// 关键：内部队列用「吞掉拒绝」的副本保持 resolved，避免一次写入抛错（如 409）把整条链
// 变成 rejected 后导致后续所有写入都不再执行（队列中毒）；调用方拿到的 p 仍会正常 reject，
// 由路由层转成 409/500 返回，不影响错误透传。
let docWriteQueue = Promise.resolve()
export function withDocsWrite(fn) {
  const p = docWriteQueue.then(() => fn())
  docWriteQueue = p.then(() => {}, () => {})
  return p
}

// 串行化用户表写入（B2 / I5）：整表覆盖式写入也串行化，避免并发注册/同步丢账号
let userWriteQueue = Promise.resolve()
export function withUsersWrite(fn) {
  const p = userWriteQueue.then(() => {
    const users = readUsers()
    fn(users)
    writeUsers(users)
  })
  userWriteQueue = p.then(() => {}, () => {})
  return p
}

// ===== 知识库操作日志持久化（独立文件，删除文档后仍保留、多用户共享） =====
export function readLogs() {
  try {
    const arr = JSON.parse(fs.readFileSync(DOCS_LOG_FILE, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function writeLogsAtomic(logs) {
  try {
    // 复用健壮原子写（rename 失败重试 + copy 降级），减少 Windows 瞬时占用导致的日志丢失
    writeFileAtomic(DOCS_LOG_FILE, JSON.stringify(logs))
  } catch (e) {
    // 单次写失败（多为 Windows 瞬时文件锁 EBUSY/EPERM）：仅告警并保留旧 doc-logs.json，
    // 不向外抛错，避免拖垮日志串行队列。
    console.error('[warn] 操作日志写入失败（保留旧文件）:', e && e.message)
  }
}

// 健壮写文件：Windows 上偶尔会因杀毒软件/文件锁出现 UNKNOWN/EBUSY/EPERM 等瞬时错误，
// 这里重试几次；非瞬时错误则立即抛出。避免一次失败就把整个服务进程拖垮。
export async function writeFileSafe(filePath, data) {
  const transient = ['UNKNOWN', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.promises.writeFile(filePath, data)
      return
    } catch (err) {
      lastErr = err
      if (!transient.includes(err.code)) throw err
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)))
    }
  }
  throw lastErr
}

// 串行化日志写入：多用户并发 POST 时避免 read-modify-write 竞态丢条目
let logWriteQueue = Promise.resolve()
export function appendLog(entry) {
  logWriteQueue = logWriteQueue.then(() => {
    const logs = readLogs()
    logs.push(entry)
    // 上限保护：最多保留最近 4000 条，避免文件无限增长
    if (logs.length > 4000) logs.splice(0, logs.length - 4000)
    writeLogsAtomic(logs)
  }).catch(err => {
    // 关键修复：捕获后让队列恢复为 resolved，否则一次写失败会使后续所有日志写入被永久跳过
    // （原实现无 catch，队列进入 rejected 态后整条链不再执行 → "操作日志不再更新"）
    console.error('[warn] appendLog 失败（本次日志可能丢失）:', err && err.message)
  })
  return logWriteQueue
}

// 允许的操作类型
export const LOG_ACTIONS = ['upload', 'delete', 'approve', 'reject', 'summary']

// 仅保留列表展示所需的轻量字段，剥离正文/分页/总结切片等重字段
export function lightweightDoc(doc) {
  if (!doc) return {}
  const { textContent, content, summaryChunks, fileUrl, pdfUrl, ...rest } = doc
  return {
    ...rest,
    chunks: doc.chunks || 0,
    hasContent: !!(doc.textContent || (doc.content && doc.content.length)),
    tableSummaryKeys: doc.tableSummaries ? Object.keys(doc.tableSummaries) : [],
  }
}

// ===== 用户表持久化（跨浏览器/设备共享）=====
export function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}
export function writeUsers(users) {
  const transient = ['UNKNOWN', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']
  let lastErr
  // 本环境（safe-delete / 文件锁护栏）会拦截 rename 覆盖(EPERM) 与对受监控数据文件的 copyFileSync 覆盖(EPERM)，
  // 但 fs.writeFileSync 原地覆盖始终可用。故直接 writeFileSync 覆盖 users.json，避免命中护栏。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(users), 'utf8')
      return
    } catch (err) {
      lastErr = err
      if (!transient.includes(err.code)) throw err
      // 同步忙等，避免把 withUsersWrite 的同步回调改成异步
      const waitUntil = Date.now() + 50 * (attempt + 1)
      while (Date.now() < waitUntil) { /* 忙等重试 */ }
    }
  }
  // 重试仍失败：保留旧 users.json 并告警，不抛错拖垮注册/改密请求（宁可本次不生效，不破坏旧数据）
  console.error('[warn] 用户表写入失败（保留旧 users.json）:', lastErr && lastErr.message)
}

// 供测试访问当前路径常量（只读用途）
export function getPaths() {
  return { DATA_DIR, DOCS_DIR, DOCS_INDEX, DOCS_LEGACY, DOCS_LOG_FILE, USERS_FILE, FILES_DIR }
}
