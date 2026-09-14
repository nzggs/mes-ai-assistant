import fs from 'fs'
import path from 'path'

/**
 * 按用户的"记忆"存储（个性化偏好，如"生成的 SQL 列名注释要加双引号"）。
 *
 * 落盘文件：${MES_DATA_DIR:-server/data}/user-memories.json（被 .gitignore 覆盖）。
 * 结构：{ version: 1, updatedAt, users: { [username]: [ { id, content, createdAt, updatedAt } ] } }
 *
 * 说明：本应用的用户身份在前端维护（localStorage 会话），服务端没有按用户签发
 * 会话令牌；与"知识库操作日志"一致，按请求携带的 username 归属记忆。记忆属
 * 非敏感的个性化偏好（不含凭据），且服务端对内容做长度/数量硬限制。
 */

const MEMORY_MAX_LEN = 500
const MEMORY_MAX_PER_USER = 50

let MEMORIES_FILE = null
let queue = Promise.resolve()
let cache = null

/** 数据目录：与 apcConfig 保持一致的解析规则 */
function dataDir() {
  return process.env.MES_DATA_DIR
    ? path.resolve(process.env.MES_DATA_DIR)
    : path.join(__dirname, 'data')
}

/** 运行期存储路径（可用 USER_MEMORIES_FILE 覆盖，测试用） */
export function memoriesFilePath() {
  const custom = (process.env.USER_MEMORIES_FILE || '').trim()
  return custom ? path.resolve(custom) : path.join(dataDir(), 'user-memories.json')
}

/** 测试/重载：重置内存缓存与文件路径 */
export function configureMemoryStore(opts = {}) {
  if (opts.file) MEMORIES_FILE = path.resolve(opts.file)
  else MEMORIES_FILE = null
  cache = null
}

function file() {
  if (!MEMORIES_FILE) MEMORIES_FILE = memoriesFilePath()
  return MEMORIES_FILE
}

function emptyDoc() {
  return { version: 1, updatedAt: new Date().toISOString(), users: {} }
}

function readDoc() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    const doc = JSON.parse(raw)
    if (doc && typeof doc === 'object' && doc.users && typeof doc.users === 'object') {
      cache = doc
    } else {
      cache = emptyDoc()
    }
  } catch {
    cache = emptyDoc()
  }
  return cache
}

/** 原子写盘（临时文件 + rename），避免半写状态。Windows 下 rename 目标可能被短暂占用，加重试。 */
function persist(doc) {
  doc.updatedAt = new Date().toISOString()
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmp, target)
      cache = doc
      return
    } catch (err) {
      lastErr = err
      const spinStart = Date.now()
      while (Date.now() - spinStart < 50) { /* 忙等 50ms 后重试 */ }
    }
  }
  try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略清理失败 */ }
  throw lastErr
}

/** 串行化写队列：避免并发请求相互覆盖 */
function enqueue(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(() => {}, () => {})
  return run
}

/** 用户名校验：仅作 JSON 键（非路径），限制长度并排除控制字符；返回 trim 后的用户名 */
function requireUsername(u) {
  const name = typeof u === 'string' ? u.trim() : ''
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    const err = new Error('username 非法')
    err.status = 400
    throw err
  }
  return name
}

function normalizeContent(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return { error: '记忆内容不能为空' }
  if (s.length > MEMORY_MAX_LEN) return { error: `记忆内容不能超过 ${MEMORY_MAX_LEN} 字` }
  return { content: s }
}

/** 读取某用户的记忆列表（新用户返回空数组）。校验失败以 rejection 形式抛出。 */
export async function listMemories(username) {
  const uname = requireUsername(username)
  const doc = readDoc()
  const list = doc.users[uname]
  return Array.isArray(list) ? list.map((m) => ({ ...m })) : []
}

/** 新增一条记忆，返回该用户完整列表 */
export async function addMemory(username, content) {
  const uname = requireUsername(username)
  const norm = normalizeContent(content)
  if (norm.error) {
    const err = new Error(norm.error)
    err.status = 400
    throw err
  }
  return enqueue(() => {
    const doc = readDoc()
    if (!Array.isArray(doc.users[uname])) doc.users[uname] = []
    if (doc.users[uname].length >= MEMORY_MAX_PER_USER) {
      const err = new Error(`每个用户最多保存 ${MEMORY_MAX_PER_USER} 条记忆`)
      err.status = 400
      throw err
    }
    const now = new Date().toISOString()
    const item = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: norm.content,
      createdAt: now,
      updatedAt: now,
    }
    doc.users[uname].push(item)
    persist(doc)
    return listMemories(uname)
  })
}

/** 更新一条记忆（必须属于该用户），返回该用户完整列表 */
export async function updateMemory(username, id, content) {
  const uname = requireUsername(username)
  if (typeof id !== 'string' || !id.startsWith('mem-')) {
    const err = new Error('记忆 id 非法')
    err.status = 400
    throw err
  }
  const norm = normalizeContent(content)
  if (norm.error) {
    const err = new Error(norm.error)
    err.status = 400
    throw err
  }
  return enqueue(() => {
    const doc = readDoc()
    const list = doc.users[uname]
    const item = Array.isArray(list) ? list.find((m) => m.id === id) : null
    if (!item) {
      const err = new Error('记忆不存在或不属于当前用户')
      err.status = 404
      throw err
    }
    item.content = norm.content
    item.updatedAt = new Date().toISOString()
    persist(doc)
    return listMemories(uname)
  })
}

/** 删除一条记忆（必须属于该用户），返回该用户完整列表 */
export async function deleteMemory(username, id) {
  const uname = requireUsername(username)
  if (typeof id !== 'string' || !id.startsWith('mem-')) {
    const err = new Error('记忆 id 非法')
    err.status = 400
    throw err
  }
  return enqueue(() => {
    const doc = readDoc()
    const list = doc.users[username]
    if (!Array.isArray(list) || !list.some((m) => m.id === id)) {
      const err = new Error('记忆不存在或不属于当前用户')
      err.status = 404
      throw err
    }
    doc.users[uname] = list.filter((m) => m.id !== id)
    if (doc.users[uname].length === 0) delete doc.users[uname]
    persist(doc)
    return listMemories(uname)
  })
}

/** 清空某账号的全部记忆（删除账号时同步调用；账号本无记忆则不动文件），返回清除条数 */
export async function deleteAllMemories(username) {
  const uname = requireUsername(username)
  return enqueue(() => {
    const doc = readDoc()
    const list = doc.users[uname]
    if (!Array.isArray(list) || list.length === 0) return 0
    delete doc.users[uname]
    persist(doc)
    return list.length
  })
}

export const MEMORY_LIMITS = { maxLen: MEMORY_MAX_LEN, maxPerUser: MEMORY_MAX_PER_USER }
