// 整篇总结「后台常驻任务」模块（ESM）。
// 把原先由前端 JS 驱动、关闭/刷新即中断的总结流程，改为由后端 worker 执行并持久化。
// 前端只负责「发起 + 订阅进度」，因此关闭窗口/刷新浏览器后，任务在后端继续跑。
//
// 设计要点：
//  - 每个任务落盘到 server/data/tasks/<id>.json（每完成一段即刷新），服务重启可断点续跑。
//  - 磁盘上的任务文件【不含 apiKey】（安全）；apiKey 仅驻留内存，进程崩溃重启后无 key 的任务标记 failed 需重发。
//  - 限流闸门 paceForRateLimit 采用「指数退避 + 冷却后回落」，避免持续失败时被永久卡在长间隔（前端的死亡螺旋）。
//  - 单文档同时只跑一个总结任务（runningByDoc 集合），避免互相踩踏。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { PROVIDERS } from '../shared/providers.js'
import {
  getPaths, writeShardSync, readShardSync, writeFileAtomic, setDocInCache,
} from './storage.js'
import { extractPdfTextFromFile } from './pdfExtract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, 'data', 'tasks')
fs.mkdirSync(TASKS_DIR, { recursive: true })

// 内存态：taskId -> task。task 同时是落盘对象（persist 时剔除 apiKey）。
const activeTasks = new Map()
// 正在某 doc 上跑的任务（保证单 doc 串行）
const runningByDoc = new Set()

// ===== 工具：与前端对齐的纯函数 =====

// MiniMax 等需要 GroupId 拼接
function buildProviderUrl(provider, groupId) {
  if (provider && provider.id === 'minimax' && groupId) {
    const sep = provider.apiUrl.includes('?') ? '&' : '?'
    return `${provider.apiUrl}${sep}GroupId=${encodeURIComponent(groupId)}`
  }
  return provider ? provider.apiUrl : ''
}

// 把 pdf 文本按「--- 第X页 ---」切成 pages
function buildPagesFromText(text) {
  const pages = []
  const re = /---\s*第([\dIVXLC]+)页\s*---/g
  const parts = text.split(re)
  let i = 1
  while (i + 1 < parts.length) {
    const label = parts[i]
    const body = (parts[i + 1] || '').trim()
    i += 2
    if (!body) continue
    pages.push({ title: `第${label}页`, paragraphs: [body] })
  }
  if (pages.length === 0) {
    const t = text.trim()
    if (t) pages.push({ title: '全文', paragraphs: [t] })
  }
  return pages
}

// 按 size 切块，尽量在标点断句
function splitIntoChunks(text, size) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    if (end < text.length) {
      const region = text.slice(end - 100, end)
      const lastBreak = Math.max(
        region.lastIndexOf('\n'),
        region.lastIndexOf('。'),
        region.lastIndexOf('.'),
        region.lastIndexOf('；'),
        region.lastIndexOf(';'),
      )
      if (lastBreak > 50) end = end - 100 + lastBreak + 1
    }
    const c = text.slice(start, end).trim()
    if (c.length > 20) chunks.push(c)
    start = end
  }
  return chunks
}

const MERGE_BATCH = 6
const MAX_BATCH_INPUT_CHARS = 12000

function splitReduceBatches(items, mergeBatch = MERGE_BATCH, maxInputChars = MAX_BATCH_INPUT_CHARS) {
  const batches = []
  let cur = []
  let curLen = 0
  for (const it of items) {
    if (cur.length > 0 && (cur.length >= mergeBatch || curLen + it.length > maxInputChars)) {
      batches.push(cur)
      cur = []
      curLen = 0
    }
    cur.push(it)
    curLen += it.length
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

function estimateReduceBatchCount(items, mergeBatch = MERGE_BATCH, maxInputChars = MAX_BATCH_INPUT_CHARS) {
  let total = 0
  let level = items
  let guard = 0
  while (level.length > 1 && guard++ < 20) {
    const batches = splitReduceBatches(level, mergeBatch, maxInputChars)
    total += batches.length
    level = batches.map(() => '')
  }
  return total
}

// 固定步长切分（落库检索切片）
function chunkText(text, size) {
  const res = []
  for (let i = 0; i < text.length; i += size) {
    const t = text.slice(i, i + size).trim()
    if (t) res.push(t)
  }
  return res
}

function contentHashOf(doc) {
  const src = doc.content && doc.content.length > 0
    ? doc.content.map(p => p.title + ':' + p.paragraphs.join('\n')).join('\n')
    : (doc.textContent || '')
  let h = 5381
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0
  return 'h' + h.toString(36) + ':' + src.length
}

// ===== 全局出发限流闸门（指数退避 + 冷却后回落） =====
let _lastStart = 0
let _intervalMs = 800
const _FLOOR_INTERVAL = 800
const _CEIL_INTERVAL = 20000
let _rateLimitedAt = 0
const _COOLDOWN_MS = 40000
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function isRateLimitReason(reason) {
  if (!reason) return false
  const r = String(reason).toLowerCase()
  return /速率限制|rate.?limit|429|too many|频率|过于频繁|请稍后|overload|过载|busy|请求过快|控制请求频率/.test(r)
}

async function paceForRateLimit() {
  const wait = Math.max(0, _intervalMs - (Date.now() - _lastStart))
  if (wait > 0) await sleep(wait)
  _lastStart = Date.now()
  // 冷却期过后，间隔指数回落（不再只增不减，避免死亡螺旋）
  if (_rateLimitedAt && Date.now() - _rateLimitedAt > _COOLDOWN_MS) {
    _intervalMs = Math.max(_FLOOR_INTERVAL, _intervalMs / 2)
    _rateLimitedAt = 0
  }
}

function notifyRateLimited() {
  _rateLimitedAt = Date.now()
  _intervalMs = Math.min(_CEIL_INTERVAL, Math.max(_intervalMs * 2, 6000))
}

// ===== 后端调用模型（对齐 /api/chat-once 逻辑，但内部直连、可携带 apiKey） =====
async function callProviderOnce({ apiKey, providerId, modelId, groupId, messages, maxTokens = 4096, timeoutMs = 30000 }) {
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
  const clientTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 170000) : 30000
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), Math.max(8000, clientTimeout - 5000))
  try {
    const res = await fetch(buildProviderUrl(provider, groupId), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { content: null, failed: true, reason: `${provider.name} API 调用失败 (${res.status}): ${txt.slice(0, 300)}` }
    }
    const data = await res.json().catch(() => null)
    if (data?.base_resp && typeof data.base_resp.status_code === 'number' && data.base_resp.status_code !== 0) {
      return { content: null, failed: true, reason: `${provider.name} API 调用失败: ${data.base_resp.status_msg || ('状态码 ' + data.base_resp.status_code)}` }
    }
    if (data?.error) {
      return { content: null, failed: true, reason: `${provider.name} API 调用失败: ${data.error.message || data.error}` }
    }
    const content = data?.choices?.[0]?.message?.content ?? data?.output?.text
    if (typeof content !== 'string' || content.length === 0) {
      return { content: null, failed: true, reason: `${provider.name} 返回为空（Key 无效或参数不被支持）` }
    }
    return { content, failed: false }
  } catch (err) {
    const aborted = !!(err && (err.name === 'AbortError' || controller.signal.aborted))
    return { content: null, failed: true, reason: aborted ? '模型接口响应超时（请稍后重试或降低并发）' : String(err?.message || err) }
  } finally {
    clearTimeout(t)
  }
}

// 对齐前端的 callLLMDetailedWithRetry：仅瞬时错误退避重试；批量模式不退避、仅 1 次重试
async function callLLMDetailedWithRetry(messages, opts, maxRetries = 3, batch = false) {
  const { apiKey, providerId, modelId, groupId, maxTokens, timeoutMs } = opts
  let last = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let r
    try {
      r = await callProviderOnce({ apiKey, providerId, modelId, groupId, messages, maxTokens, timeoutMs })
    } catch (e) {
      r = { content: null, failed: true, reason: '调用异常: ' + (e?.message || String(e)) }
    }
    if (r.content && r.content.trim()) return r
    if (!r.failed) return r
    const reason = (r.reason || '').toLowerCase()
    const transient = /速率限制|rate.?limit|429|too many|timeout|timed out|timedout|network|网络|econn|etimedout|econnreset|socket|abort|signal|超时|503|502|500|暂时|请稍后|频率|busy|过载|overload|请求过于频繁/.test(reason)
    if (!transient) return r
    last = r
    if (attempt < maxRetries) {
      const isRate = /速率限制|rate.?limit|429|too many|频率|过于频繁|请稍后|overload|过载|busy|请求过快|控制请求频率/.test(reason)
      const isTimeout = /timeout|timed out|timedout|abort|signal|超时|etimedout|econnreset|socket|network|网络/.test(reason)
      // batch（map 并发）模式下也退避：原先 wait=0 会让"模型繁忙"立刻重试再次撞墙，
      // 最终被判失败而丢页；这里给一个较短但非零的退避。
      const base = isRate ? 3000 : isTimeout ? 5000 : 2000
      const wait = (batch ? Math.min(base, 1500) : base) * Math.pow(2, attempt) + Math.random() * 800
      // 限流类失败：推宽闸门
      if (isRate) notifyRateLimited()
      if (wait > 0) await sleep(wait)
    }
  }
  return last
}

// ===== 持久化 =====
function persist(task) {
  // 磁盘上剔除 apiKey，避免明文落盘
  const { apiKey, ...safe } = task
  const file = path.join(TASKS_DIR, `${task.id}.json`)
  try {
    writeFileAtomic(file, JSON.stringify(safe))
  } catch (e) {
    console.error('[summaryTask] persist failed:', task.id, e?.message)
  }
}

function loadTaskFromDisk(id) {
  try {
    const raw = fs.readFileSync(path.join(TASKS_DIR, `${id}.json`), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function listTaskFiles() {
  try {
    return fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
}

// ===== 落库：把总结结果写回后端分片（对齐前端 saveTableSummary 核心，不影响检索结构） =====
function saveSummaryToDoc(docId, sheetKey, text) {
  const rec = readShardSync(docId)
  if (!rec || !rec.doc) return false
  // 文档已被删除（分片是墓碑）：不得写回，否则会给墓碑挂上总结内容
  if (rec.doc.deleted) return false
  const doc = rec.doc
  const contentHash = contentHashOf(doc)
  const entry = { text, updatedAt: Date.now(), contentHash }
  const chunks = chunkText(text, 800).map(t => ({
    sheetKey,
    label: sheetKey === '__doc__'
      ? `《${doc.name}》整篇 AI 总结`
      : `《${doc.name}》标签页「${sheetKey}」AI 总结`,
    text: t,
  }))
  const prevChunks = (doc.summaryChunks || []).filter(c => c.sheetKey !== sheetKey)
  const summaryChunks = [...prevChunks, ...chunks]
  const tableSummaries = { ...(doc.tableSummaries || {}), [sheetKey]: entry }
  const updatedDoc = {
    ...doc,
    tableSummaries,
    summaryChunks,
    chunks: Math.ceil((doc.content && doc.content.length ? doc.content.reduce((s, p) => s + p.paragraphs.join('\n').length, 0) : (doc.textContent || '').length) / 4096) + summaryChunks.length,
  }
  // 写回保持 { id, doc } 分片结构，并同步内存缓存（GET /api/docs/:id 才能返回更新后的 tableSummaries 用于打勾）
  const updatedRec = { id: docId, doc: updatedDoc }
  writeShardSync(docId, updatedRec)
  setDocInCache(docId, updatedRec)
  return true
}

// ===== 核心：执行一个总结任务（map-reduce） =====
async function runTask(task) {
  task.status = 'running'
  task.startedAt = task.startedAt || Date.now()
  task.updatedAt = Date.now()
  persist(task)
  try {
    const { docId, sheetName, instruction, modelId, providerId, groupId, apiKey } = task

    // 0) 取文档内容（分片结构为 { id, doc: {...} }；优先 doc.content/textContent，缺失则自愈从 files 提取）
    const rec0 = readShardSync(docId)
    if (!rec0) throw new Error('文档不存在')
    // 文档已被删除（墓碑分片）：不要再消耗算力，直接终止任务
    if (rec0.doc && rec0.doc.deleted) throw new Error('文档已被删除')
    // 仅已入库文档可总结（与 /api/summary/start 校验一致，防止任务恢复后绕过）
    if ((rec0.doc?.status || 'pending') !== 'approved') throw new Error('文档尚未入库，无法总结')
    // XML 数据导出无需总结（与 /api/summary/start 校验一致，防止任务恢复/历史任务绕过）
    if ((rec0.doc?.type || '') === 'xml') throw new Error('XML 数据导出无需 AI 总结')
    let doc = rec0.doc || rec0

    if ((!doc.content || doc.content.length === 0) && !doc.textContent?.trim() && doc.pdfUrl) {
      try {
        const { FILES_DIR } = getPaths()
        const fileOnDisk = path.join(FILES_DIR, docId)
        if (fs.existsSync(fileOnDisk)) {
          const fresh = await extractPdfTextFromFile(fileOnDisk)
          if (fresh && fresh.trim()) {
            doc = { ...doc, textContent: fresh, content: buildPagesFromText(fresh) }
            // 自愈结果写回分片（保持 { id, doc } 结构），供后续与前端同步
            const updRec = { id: docId, doc }
            writeShardSync(docId, updRec)
            setDocInCache(docId, updRec)
          }
        }
      } catch (e) {
        console.warn('[summaryTask] pdf 自愈提取失败:', e?.message)
      }
    }

    // 1) 组装 sections
    const sections = []
    if (doc.content && doc.content.length > 0) {
      for (const page of doc.content) {
        const pageText = page.paragraphs.join('\n')
        if (!pageText.trim()) continue
        if (sheetName && !page.title.includes(sheetName) && sheetName !== page.title) continue
        sections.push({ title: page.title, text: pageText })
      }
    } else if (doc.textContent) {
      const markerRegex = /(---\s*第([\dIVXLC]+)页\s*---)|(===\s*(.+?)\s*===)/g
      const markers = []
      let m
      while ((m = markerRegex.exec(doc.textContent)) !== null) {
        markers.push({ label: m[1] ? `第${m[2]}页` : (m[3] || '').trim(), index: m.index })
      }
      if (markers.length > 0) {
        for (let i = 0; i < markers.length; i++) {
          const start = markers[i].index
          const end = i + 1 < markers.length ? markers[i + 1].index : doc.textContent.length
          const text = doc.textContent.slice(start, end).trim()
          if (!text) continue
          if (sheetName && !markers[i].label.includes(sheetName)) continue
          sections.push({ title: markers[i].label, text })
        }
      } else {
        const text = doc.textContent.trim()
        if (text && !sheetName) sections.push({ title: doc.name, text })
      }
    }

    if (sections.length === 0) {
      task.status = 'failed'
      task.error = '文档无可用文本内容，无法总结'
      persist(task)
      return
    }

    // 2) 切块
    const chunkSize = 2000
    const tasks = []
    let idx = 0
    for (const sec of sections) {
      for (const c of splitIntoChunks(sec.text, chunkSize)) {
        if (!c.trim()) continue
        tasks.push({ title: sec.title, chunk: c, index: idx++ })
      }
    }
    if (tasks.length === 0) {
      task.status = 'failed'
      task.error = '文档切分为空（可能内容均为空白）'
      persist(task)
      return
    }

    // 预填已完成段（断点续跑：磁盘 partials 已有的段落直接复用）
    const partials = new Array(tasks.length).fill('')
    let prefilled = 0
    if (Array.isArray(task.partials)) {
      for (let i = 0; i < tasks.length && i < task.partials.length; i++) {
        if (task.partials[i] && task.partials[i].trim()) {
          partials[i] = task.partials[i]
          prefilled++
        }
      }
    }
    task.partials = partials
    task.total = tasks.length
    task.done = prefilled
    task.stage = 'map'
    persist(task)

    const MAX_SUMMARY_MS = 25 * 60 * 1000
    const makeMeta = () => ({ elapsedMs: Date.now() - task.startedAt })

    const report = (done, total, stage, partial) => {
      task.done = done
      task.total = total
      task.stage = stage
      if (partial !== undefined) task.partial = partial
      task.updatedAt = Date.now()
      persist(task)
    }

    // 3) MAP
    report(prefilled, tasks.length, 'map', '')
    const sysPrompt = '你是针对知识密度极高的参考类文档（如字典、手册、术语表、规范、参数表）的逐条信息抽取助手。请对下面这段内容做【逐条信息抽取】：把其中出现的每一个有意义的条目（术语/字段/命令/参数/代号/步骤/条目/条目项等）及其关键属性（定义、取值/范围、用途、默认值、单位、关联关系等）都提取出来，尽量保留原词、原数值与层级关系；宁可多提、不可遗漏；不要编造；若本段确无实质信息，回复"无实质内容"。'
    let nextTask = prefilled
    let done = prefilled
    // 本地模型（Ollama）一次只能串行处理一个请求，并发 3 会直接返回"模型繁忙"→ 整页丢失；
    // 云端模型才用并发提速。
    const providerCfg = PROVIDERS[providerId] || {}
    const isLocalProvider = /ollama/i.test(String(providerId || '')) || /11434/.test(String(providerCfg.apiUrl || ''))
    const CONCURRENCY = isLocalProvider ? 1 : 3
    // 失败段索引：主循环只登记、不写死失败文本，交由补跑阶段重试，避免"跳过该页继续"造成丢页
    const failedIdx = new Set()
    const joinPartials = () => partials.filter(p => p && p.trim()).join('\n\n')
    const buildMapMessages = (t) => ([
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `【所属：${t.title}】\n\n${t.chunk}` },
    ])

    const mapWorker = async () => {
      while (nextTask < tasks.length) {
        if (task.cancelled) break
        if (Date.now() - task.startedAt > MAX_SUMMARY_MS) { task._aborted = true; break }
        const i = nextTask++
        // 续跑：已完成的段直接跳过
        if (partials[i] && partials[i].trim()) {
          done++
          report(done, tasks.length, 'map', joinPartials())
          continue
        }
        const t = tasks[i]
        await paceForRateLimit()
        if (task.cancelled) break
        const r = await callLLMDetailedWithRetry(
          buildMapMessages(t),
          { apiKey, providerId, modelId, groupId, maxTokens: 4096, timeoutMs: 30000 },
          2, true,
        )
        if (r.content && r.content.trim()) {
          partials[i] = r.content.trim()
        } else {
          // 留空（非空串会让续跑误判为"已完成"而永久跳过该页）
          failedIdx.add(i)
        }
        done++
        report(done, tasks.length, 'map', joinPartials())
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => mapWorker()))

    // 3.5) 失败段补跑：串行 + 逐轮拉长退避，把"繁忙/限流"导致的丢页找回来
    const RETRY_ROUNDS = [
      { waitMs: 5000, maxRetries: 2 },
      { waitMs: 15000, maxRetries: 3 },
      { waitMs: 40000, maxRetries: 3 },
    ]
    for (const round of RETRY_ROUNDS) {
      if (task.cancelled || task._aborted || failedIdx.size === 0) break
      // 预留收尾时间，避免补跑把整个任务拖到超时
      if (Date.now() - task.startedAt > MAX_SUMMARY_MS * 0.85) { task._aborted = true; break }
      task.retrying = failedIdx.size
      task.updatedAt = Date.now()
      persist(task)
      await sleep(round.waitMs)
      for (const i of [...failedIdx]) {
        if (task.cancelled || task._aborted) break
        if (Date.now() - task.startedAt > MAX_SUMMARY_MS) { task._aborted = true; break }
        const t = tasks[i]
        await paceForRateLimit()
        const r = await callLLMDetailedWithRetry(
          buildMapMessages(t),
          { apiKey, providerId, modelId, groupId, maxTokens: 4096, timeoutMs: 45000 },
          round.maxRetries, false,
        )
        if (r.content && r.content.trim()) {
          partials[i] = r.content.trim()
          failedIdx.delete(i)
          task.retrying = failedIdx.size
          report(done, tasks.length, 'map', joinPartials())
        }
      }
    }
    task.retrying = 0
    // 补跑后仍失败的段：明确标注缺失位置（再次总结时这些段为空，会被自动重试补齐）
    if (failedIdx.size > 0) {
      task.failedChunks = [...failedIdx].map(i => ({ index: i, title: tasks[i].title }))
      for (const i of failedIdx) {
        if (!partials[i] || !partials[i].trim()) {
          partials[i] = `⚠AI调用失败（第 ${i + 1} 段：${tasks[i].title}）：该部分本次未生成，请稍后重新点击总结以补齐（已完成段落会自动复用）`
        }
      }
      report(done, tasks.length, 'map', joinPartials())
    }

    if (task.cancelled) {
      task.status = 'cancelled'
      persist(task)
      return
    }

    // 4) REDUCE
    const SUMMARY_LLM_TIMEOUT_MS = 120000
    const SUMMARY_MERGE_MAX_TOKENS = 4096
    const REDUCE_SYS = '你是知识密度极高的参考类文档（字典/手册/术语表/规范/参数表）整理专家。基于提供的若干分段抽取结果，输出一份【覆盖全部内容、不截断、不遗漏】的合并归纳：完整保留所有条目及其关键属性、术语定义、参数说明、命令与步骤要点，并按原文档层级（标签页/章节/分组）清晰组织，便于作为检索型参考资料长期使用。严格基于提供的内容，不得编造其中不存在的条目或数值。不要输出"第N级归纳/第X段"之类的层级标题行，直接给出合并后的内容。'
    const scopeDesc = sheetName ? `文档《${doc.name}》中的标签页「${sheetName}」` : `文档《${doc.name}》的全部内容`
    const userExtra = instruction && instruction.trim() ? `\n\n用户特别要求（请在归纳中重点回应）：${instruction.trim()}` : ''
    const allPartials = partials.filter(p => p && p.trim()).map((p, i) => `【第${i + 1}段】\n${p}`)
    const totalReduceBatches = estimateReduceBatchCount(allPartials)
    report(0, totalReduceBatches, 'reduce')
    let reduceDone = 0
    let levelItems = allPartials
    let levelNo = 1
    const REDUCE_MAX_LEVELS = 32

    const runPool = async (items, worker, concurrency = 3) => {
      const results = new Array(items.length)
      let next = 0
      async function pump() {
        while (next < items.length) {
          const i = next++
          results[i] = await worker(items[i], i)
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => pump()))
      return results
    }

    while (levelItems.length > 1 && levelNo <= REDUCE_MAX_LEVELS) {
      if (task.cancelled || task._aborted || Date.now() - task.startedAt > MAX_SUMMARY_MS) { task._aborted = true; break }
      const batches = splitReduceBatches(levelItems)
      const subSummaries = await runPool(batches, async (batch) => {
        const joinedBatch = batch.join('\n\n')
        await paceForRateLimit()
        if (task.cancelled) return joinedBatch
        const out = await callLLMDetailedWithRetry(
          [
            { role: 'system', content: REDUCE_SYS },
            { role: 'user', content: `请将下面 ${batch.length} 组分段抽取结果合并为一份【覆盖全部内容、不截断、不遗漏】的归纳（保留全部条目与关键属性，按原层级组织），这是对${scopeDesc}的第 ${levelNo} 级部分归纳：${userExtra}\n\n${joinedBatch}` },
          ],
          { apiKey, providerId, modelId, groupId, maxTokens: SUMMARY_MERGE_MAX_TOKENS, timeoutMs: SUMMARY_LLM_TIMEOUT_MS },
          1, false,
        )
        const merged = out && out.content && out.content.trim() ? out.content.trim() : joinedBatch
        return merged.length > MAX_BATCH_INPUT_CHARS
          ? merged.slice(0, MAX_BATCH_INPUT_CHARS) + '\n…（内容过长已截断）'
          : merged
      })
      reduceDone += batches.length
      report(reduceDone, Math.max(totalReduceBatches, reduceDone), 'reduce', subSummaries.join('\n\n'))
      levelItems = subSummaries
      levelNo++
    }
    if (levelItems.length > 1) levelItems = [`【降级汇总·未完全压缩】\n${levelItems.join('\n\n')}`]

    let finalSummary = levelItems[0]?.replace(/【第\d+级·组\d+】\n?/g, '').trim() || null
    if (!finalSummary || !finalSummary.trim()) finalSummary = null
    if (finalSummary && finalSummary.includes('⚠AI调用失败')) {
      const missing = Array.isArray(task.failedChunks) ? task.failedChunks.length : 0
      const where = missing > 0
        ? `共 ${missing} 段未生成（${task.failedChunks.slice(0, 10).map(c => c.title).join('、')}${missing > 10 ? ' 等' : ''}）`
        : '部分内容未能生成'
      finalSummary = `⚠ 提示：本次总结${where}，通常为模型繁忙/限流或网络异常所致。请稍后重新点击总结——已完成的段落会自动复用，只补跑缺失部分。\n\n` + finalSummary
    }
    if (task._aborted) {
      finalSummary = finalSummary
        ? `⚠ 本次整篇总结因超过最长运行时间已自动终止，以下为已完成部分的汇总。请检查模型 API Key / 额度 / 网络，或稍后重试。\n\n` + finalSummary
        : `⚠ 本次整篇总结因超过最长运行时间已自动终止，且未能在时限内完成任何段落的总结。请检查模型 API Key / 额度 / 网络后重试。`
    }

    // 落库
    if (finalSummary) {
      const sheetKey = sheetName || '__doc__'
      try {
        saveSummaryToDoc(docId, sheetKey, finalSummary)
      } catch (e) {
        console.error('[summaryTask] 落库失败:', docId, e?.message)
      }
    }
    task.result = finalSummary
    task.status = finalSummary ? 'done' : 'failed'
    task.error = finalSummary ? null : '未取得模型输出'
    task.stage = 'done'
    task.done = task.total
    task.summaryLog = { action: 'summary', target: sheetName ? `${doc.name} · ${sheetName}` : doc.name }
    persist(task)
  } catch (err) {
    task.status = 'failed'
    task.error = String(err?.message || err)
    persist(task)
  } finally {
    runningByDoc.delete(task.docId)
    // 终态任务延迟从内存移除（磁盘文件保留一段时间供前端读取最终状态）
    scheduleTaskMemoryEviction(task.id)
  }
}

// ===== 对外接口 =====
export function startSummary({ docId, sheetName, instruction, providerId, modelId, groupId, apiKey }) {
  // 单文档同时只跑一个：has + add 必须在同步代码块内完成，避免两个并发请求都通过 has 检查后双跑
  if (runningByDoc.has(docId)) {
    // 返回该 doc 正在跑的任务（让前端直接订阅）
    for (const t of activeTasks.values()) {
      if (t.docId === docId && (t.status === 'running' || t.status === 'pending')) return t
    }
  }
  runningByDoc.add(docId)
  const id = `sum-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const task = {
    id,
    docId,
    sheetName: sheetName || null,
    instruction: instruction || '',
    providerId: providerId || 'deepseek',
    modelId: modelId || null,
    groupId: groupId || null,
    apiKey, // 仅内存
    status: 'pending',
    stage: 'map',
    done: 0,
    total: 0,
    partial: '',
    partials: [],
    result: null,
    error: null,
    cancelled: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  activeTasks.set(id, task)
  persist(task)
  // 异步执行，不阻塞请求
  runTask(task).catch(e => {
    console.error('[summaryTask] runTask crashed:', e?.message)
    task.status = 'failed'
    task.error = String(e?.message || e)
    persist(task)
    runningByDoc.delete(task.docId)
  })
  return task
}

export function getTask(id) {
  // 内存优先，磁盘兜底
  if (activeTasks.has(id)) return activeTasks.get(id)
  const fromDisk = loadTaskFromDisk(id)
  if (fromDisk) {
    // 不含 apiKey，无法继续；但可返回状态供展示
    return fromDisk
  }
  return null
}

export function cancelTask(id) {
  const t = activeTasks.get(id) || loadTaskFromDisk(id)
  if (!t) return false
  t.cancelled = true
  if (t.status === 'running' || t.status === 'pending') {
    t.status = 'cancelled'
    persist(t)
    scheduleTaskMemoryEviction(id)
  }
  return true
}

export function listTasks(docId) {
  const all = [...activeTasks.values()]
  const disk = listTaskFiles()
    .map(f => loadTaskFromDisk(f.replace(/\.json$/, '')))
    .filter(Boolean)
  const merged = new Map()
  for (const t of [...all, ...disk]) {
    // 同 doc 取最新一个活跃任务
    if (docId && t.docId !== docId) continue
    const existing = merged.get(t.docId)
    if (!existing || (t.updatedAt || 0) > (existing.updatedAt || 0)) merged.set(t.docId, t)
  }
  return [...merged.values()].map(t => ({
    id: t.id, docId: t.docId, sheetName: t.sheetName,
    status: t.status, stage: t.stage, done: t.done, total: t.total,
    updatedAt: t.updatedAt, error: t.error,
    hasApiKey: !!t.apiKey,
  }))
}

// 服务启动时调用：扫描磁盘，把 running/pending 任务恢复为 pending 重新入队（无 apiKey 则标记 failed）
export function recoverSummaryTasks() {
  for (const f of listTaskFiles()) {
    const id = f.replace(/\.json$/, '')
    const t = loadTaskFromDisk(id)
    if (!t) continue
    if (t.status === 'running' || t.status === 'pending') {
      // 同一 doc 已在跑（如崩溃残留 + 手动重开）则跳过，避免并发双跑互相踩踏
      if (runningByDoc.has(t.docId)) continue
      if (!t.apiKey) {
        // 进程崩溃重启，内存 key 已丢失，无法续跑
        t.status = 'failed'
        t.error = '服务重启，原任务的 API Key 已丢失，请重新发起总结'
        try { writeFileAtomic(path.join(TASKS_DIR, f), JSON.stringify(t)) } catch {}
        continue
      }
      // 复位为 pending 重新执行（断点续跑依赖已落盘的 partials）
      t.status = 'pending'
      runningByDoc.add(t.docId)
      activeTasks.set(id, t)
      const task = t
      runTask(task).catch(e => {
        task.status = 'failed'
        task.error = String(e?.message || e)
        persist(task)
        runningByDoc.delete(task.docId)
      })
    }
  }
}

// ===== 周期清理：避免 server/data/tasks/ 无限增长 + activeTasks 内存泄漏 =====
// - 已终态（done/failed/cancelled）且超过 24h 的任务文件直接删除；
// - 已终态任务从内存 activeTasks 中延迟移除（保留 10 分钟供前端轮询读取最终状态，之后回退磁盘文件）。
const TASK_FILE_RETENTION_MS = 24 * 60 * 60 * 1000
const TASK_MEM_RETENTION_MS = 10 * 60 * 1000
let taskCleanupTimer = null
function cleanupTasks() {
  const now = Date.now()
  for (const f of listTaskFiles()) {
    const id = f.replace(/\.json$/, '')
    const t = loadTaskFromDisk(id)
    if (!t) continue
    const terminal = t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'
    if (!terminal) continue
    // 终态超过保留期：删除磁盘文件，并从内存移除
    if (now - (t.updatedAt || 0) > TASK_FILE_RETENTION_MS) {
      try { fs.unlinkSync(path.join(TASKS_DIR, f)) } catch {}
      activeTasks.delete(id)
    }
  }
}
export function startTaskCleanup() {
  if (taskCleanupTimer) return
  taskCleanupTimer = setInterval(cleanupTasks, 30 * 60 * 1000)
  taskCleanupTimer.unref?.()
}
// 任务进入终态后，延迟从 activeTasks 移除（保留一段时间供前端读取最终状态）
export function scheduleTaskMemoryEviction(id) {
  setTimeout(() => {
    const t = activeTasks.get(id)
    if (t && (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled')) {
      activeTasks.delete(id)
    }
  }, TASK_MEM_RETENTION_MS).unref?.()
}
