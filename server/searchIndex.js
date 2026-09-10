// 服务端「页级倒排索引」：零依赖实现，用于消除前端拉取超大型文档（如 XML 数据导出，
// 单篇可达数万-数百万字）全量正文后在浏览器里做 O(N×M) 全量扫文本的性能与体积瓶颈。
//
// 设计要点：
// 1. 索引单元 = DocPage（与前端 buildKnowledgeContext 的检索单元一致），一条 XML 记录即一页；
//    PDF/Office 文档的既有分页行为完全不变，只是多了一条可选的检索通道。
// 2. 只为 status === 'approved'（已入库）的文档建索引，与问答两侧口径一致。
// 3. 索引常驻内存，**不落盘**：进程重启后后台异步重建，构建期间 /api/search 返回 ready:false，
//    前端自动退回本地既有检索路径（零功能回退、只是性能退化为现状水平）。
// 4. 三级瘦身防止超大文档把内存打爆：
//    - 单页 term 上限（MAX_TERMS_PER_PAGE）
//    - 单 term 倒排长度上限（MAX_DF_PER_TERM，超过即视为停用词整体丢弃）
//    - 全局 posting 预算（MAX_TOTAL_POSTINGS）
//    三者共同保证：代码片段里极高重复度的模板词（select/from/STEPS/REF_TYPE…）被自动剔除，
//    保留下来的正是有区分度的业务值（对象名、表名、业务字段值）。
import { readShardSync } from './storage.js'

// ===== 可调参数（可用环境变量覆盖，便于按部署规模调优）=====
const MAX_TERMS_PER_PAGE = Number(process.env.MES_IDX_MAX_TERMS_PER_PAGE || 4000) // 单页最多索引多少个「不同 term」（太小会截断页尾内容，造成漏召回）
const MAX_DF_PER_TERM = Number(process.env.MES_IDX_MAX_DF || 1500)   // 单 term 倒排长度上限（超出即整词丢弃，等价于停用词）
const MAX_TOTAL_POSTINGS = Number(process.env.MES_IDX_MAX_POSTINGS || 3_000_000) // 全局 posting 预算（内存兜底）
const MAX_QUERY_TERMS = 64           // 单次查询最多使用多少个 term
const MAX_PAGE_CHARS = 200_000       // 单页参与建索引的最大字符数

/** 索引运行时状态 */
const state = {
  /** term -> number[]（扁平数组：docIdx, pageIdx 交替） */
  terms: new Map(),
  /** 被判为高频而整体丢弃的 term（等价于停用词），避免后续文档又重新建表 */
  killed: new Set(),
  /** docId -> { i: docIdx, name, titles: string[] } */
  docs: new Map(),
  /** docIdx -> docId（反查；删除后置 null 形成可复用空洞） */
  docIds: [],
  totalPostings: 0,
  ready: false,
  building: false,
}

/** 取完整文档记录（默认走 storage 分片；单测可用 configureSearchIndex 覆盖） */
let fetchDocRecord = (id) => readShardSync(id)

/**
 * 注入文档读取器（单测 / 数据目录隔离用途）。
 */
export function configureSearchIndex(opts = {}) {
  if (typeof opts.fetchDocRecord === 'function') fetchDocRecord = opts.fetchDocRecord
}

// ===== 分词 =====
// 同时产出两类 term，兼顾「中英混合的企业知识库」：
//  - ASCII 标识符：`PM2LSMM047`、`G.$executeFlow`、`wip_sn` 等。除整体外还按 `_ . - $` 拆子词、
//    按 camelCase 再拆一次（executeFlow → execute / flow），提升「只说半个名字」的召回。
//  - CJK 相邻二字组（bigram）：中文没有空格，bigram 是最稳的零依赖切分方式。
const termRe = /[A-Za-z_][A-Za-z0-9_$.-]{1,}/g
const cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

export function tokenize(text, { limit = Infinity } = {}) {
  if (!text) return []
  const out = []
  const push = (t) => {
    if (t.length >= 2 && out.length < limit) out.push(t)
  }
  let m
  termRe.lastIndex = 0
  while ((m = termRe.exec(text)) !== null) {
    const raw = m[0].replace(/[.-]+$/, '')
    const t = raw.toLowerCase()
    push(t)
    if (t.length > 3) {
      // 含分隔符拆子词（wip_sn → wip/sn）
      const parts = t.split(/[._$-]+/).filter(p => p.length >= 2)
      if (parts.length > 0 && (parts.length > 1 || parts[0] !== t)) for (const p of parts) push(p)
      // camelCase 拆子词：必须在小写化【之前】按原始大小写切，否则 G.$executeFlow 只剩 executeflow
      const camel = raw.replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[\s._$-]+/).map(s => s.toLowerCase()).filter(p => p.length >= 2)
      if (camel.length > 1) for (const p of new Set(camel)) push(p)
    }
    if (out.length >= limit) break
  }
  cjkRe.lastIndex = 0
  while ((m = cjkRe.exec(text)) !== null) {
    const seg = m[0]
    if (seg.length === 1) { push(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) push(seg.slice(i, i + 2))
    if (out.length >= limit) break
  }
  return out
}

// ===== 文档增删 =====

function allocDocIdx() {
  for (let i = 0; i < state.docIds.length; i++) if (state.docIds[i] == null) return i
  state.docIds.push(null)
  return state.docIds.length - 1
}

function pruneDocSlots() {
  while (state.docIds.length > 0 && state.docIds[state.docIds.length - 1] == null) state.docIds.pop()
}

/** 移除某篇文档的全部 posting。文档未入索引时（meta 缺失）立即返回，避免全表扫描。 */
function evictDoc(docId) {
  const meta = state.docs.get(docId)
  if (!meta) return
  const target = meta.i
  let removed = 0
  for (const [term, hits] of state.terms) {
    let w = 0
    for (let r = 0; r < hits.length; r += 2) {
      if (hits[r] === target) { removed++; continue }
      hits[w] = hits[r]; hits[w + 1] = hits[r + 1]
      w += 2
    }
    if (w !== hits.length) {
      hits.length = w
      if (hits.length === 0) state.terms.delete(term)
    }
  }
  state.totalPostings -= removed
  if (state.totalPostings < 0) state.totalPostings = 0
  state.docs.delete(docId)
  state.docIds[target] = null
  pruneDocSlots()
}

/**
 * 噪声 term 判定：数据库导出里大量存在 `SID` / `REF_OBJ_SID` 这类 UUID 与随机串，
 * 它们基数极高（几乎每行一个新词）却基本不会被用于检索，是典型「索引膨胀源」。
 * 丢弃规则：长度 ≥ 20 且仅由 [a-z0-9-] 组成（形如完整 UUID `e2f1c8b0-3a4d-4e5f-…`）。
 * 注意：UUID 被拆出的短片段（8/12 位）仍保留，必要时仍可据此定位。
 */
function isNoiseTerm(t) {
  return t.length >= 20 && /^[a-z0-9-]+$/.test(t)
}

/**
 * 建立 / 刷新单篇文档的索引。
 * - deleted 墓碑 或 status !== 'approved' 或正文为空 → 不入索引（并清理已存在的旧索引）
 * @returns {boolean} 是否真正入索引
 */
export function upsertDocument(docId, doc) {
  if (!docId || !doc) return false
  evictDoc(docId)
  if (doc.deleted === true) return false
  if ((doc.status || 'pending') !== 'approved') return false
  const pages = Array.isArray(doc.content) ? doc.content : []
  if (pages.length === 0) return false

  const docIdx = allocDocIdx()
  const meta = { i: docIdx, name: doc.name || '', titles: new Array(pages.length) }
  state.docs.set(docId, meta)
  // 关键：占位后 allocDocIdx 才会把下一个 idx 分配给别篇；
  // 否则 docIds[i] 仍为 null，后续文档会复用同一个 docIdx，导致不同文档的命中互相串页。
  state.docIds[docIdx] = docId

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p] || {}
    const title = String(page.title || '')
    const body = Array.isArray(page.paragraphs) ? page.paragraphs.join('\n') : String(page.paragraphs || '')
    meta.titles[p] = title
    const source = `${title}\n${body}`.slice(0, MAX_PAGE_CHARS)
    const uniq = new Set(tokenize(source))
    let added = 0
    for (const term of uniq) {
      if (added >= MAX_TERMS_PER_PAGE) break
      // 丢弃 UUID / 长随机串（基数极高又几乎不会被检索，是最大的索引膨胀源）
      if (isNoiseTerm(term)) continue
      let hits = state.terms.get(term)
      if (!hits) {
        if (state.killed.has(term)) continue // 已判为高频停用词，整库不再收录
        if (state.totalPostings >= MAX_TOTAL_POSTINGS) continue
        hits = []
        state.terms.set(term, hits)
      }
      hits.push(docIdx, p)
      state.totalPostings++
      added++
      // 高频模板词（select/where/STEPS…）：区分度极低而内存代价极高，达到阈值即整词入黑名单。
      // 黑名单必须记录：否则后续文档遇到同一个词时会重新建表，导致该词最终只保留「最后处理的那部分
      // 文档」，召回结果整体偏向文档处理顺序（这是一个隐蔽且严重的排序缺陷）。
      if (hits.length / 2 > MAX_DF_PER_TERM) {
        state.totalPostings -= hits.length / 2
        state.terms.delete(term)
        state.killed.add(term)
      }
    }
  }
  return true
}

/** 删除 / 墓碑化文档时调用 */
export function removeDocument(docId) {
  evictDoc(docId)
}

/** 清空索引（全量重建前 / 单测重置） */
export function resetIndex() {
  state.terms = new Map()
  state.killed = new Set()
  state.docs = new Map()
  state.docIds = []
  state.totalPostings = 0
  state.ready = false
  state.building = false
}

// ===== 全量构建 =====

/**
 * 异步构建全量索引。逐篇让出主线程（每 20 篇 setImmediate），
 * 避免一次性阻塞数秒导致 health 检查与其他接口排队。
 * @param {Array<{id:string, doc:any}>} records 文档记录（含墓碑，内部会跳过）
 */
export async function buildIndex(records) {
  if (state.building) return getStatus()
  state.building = true
  state.ready = false
  state.terms = new Map()
  state.killed = new Set()
  state.docs = new Map()
  state.docIds = []
  state.totalPostings = 0
  const list = Array.isArray(records) ? records : []
  try {
    for (let i = 0; i < list.length; i++) {
      const rec = list[i]
      if (!rec || !rec.id || !rec.doc) continue
      try { upsertDocument(rec.id, rec.doc) } catch { /* 单篇失败不影响整体 */ }
      if (i % 20 === 19) await new Promise(r => setImmediate(r))
    }
    state.ready = true
  } finally {
    state.building = false
  }
  return getStatus()
}

/** 索引状态（前端据此决定是否走服务端检索） */
export function getStatus() {
  let pageCount = 0
  for (const d of state.docs.values()) pageCount += d.titles.length
  return {
    enabled: true,
    ready: state.ready && !state.building,
    building: state.building,
    docCount: state.docs.size,
    pageCount,
    termCount: state.terms.size,
    postings: state.totalPostings,
  }
}

// ===== 检索 =====

/** 取一页正文（从 storage 分片读取，读不到则不返回正文） */
function readPage(docId, pageIdx) {
  let rec = null
  try { rec = fetchDocRecord(docId) } catch { rec = null }
  if (!rec || !rec.doc || rec.doc.deleted) return null
  const pages = Array.isArray(rec.doc.content) ? rec.doc.content : []
  const page = pages[pageIdx]
  if (!page) return null
  const head = String(page.title || '')
  const body = Array.isArray(page.paragraphs) ? page.paragraphs.join('\n') : String(page.paragraphs || '')
  return { head, text: head ? `${head}\n${body}` : body }
}

/**
 * 关键词检索（页级）。
 * @returns {{ hits: Array<{docId,docName,pageIndex,pageTitle,score,text}>, tookMs:number, total:number }}
 */
export function search(query, { topK = 20, perHitChars = 6000, docIds = null } = {}) {
  const started = Date.now()
  const q = String(query || '').trim()
  if (!q || !state.ready) return { hits: [], tookMs: 0, total: 0 }

  const terms = Array.from(new Set(tokenize(q))).slice(0, MAX_QUERY_TERMS)
  if (terms.length === 0) return { hits: [], tookMs: 0, total: 0 }

  const metaByIdx = new Map()
  let N = 0
  for (const [id, meta] of state.docs) { metaByIdx.set(meta.i, { id, meta }); N += meta.titles.length }
  if (N === 0) return { hits: [], tookMs: Date.now() - started, total: 0 }

  const allowed = Array.isArray(docIds) && docIds.length ? new Set(docIds) : null
  const acc = new Map() // key: docIdx * 1e6 + pageIdx
  for (const term of terms) {
    const hits = state.terms.get(term)
    if (!hits || hits.length === 0) continue
    const df = hits.length / 2
    // 简化 BM25：idf * tf 饱和（页内同一 term 只记一次，tf 恒为 1）
    const idf = Math.log(1 + N / (1 + df))
    for (let r = 0; r < hits.length; r += 2) {
      const docIdx = hits[r]
      const ref = metaByIdx.get(docIdx)
      if (!ref) continue
      if (allowed && !allowed.has(ref.id)) continue
      const key = docIdx * 1_000_000 + hits[r + 1]
      const prev = acc.get(key)
      if (prev) prev.score += idf
      else acc.set(key, { docIdx, pageIdx: hits[r + 1], score: idf })
    }
  }
  if (acc.size === 0) return { hits: [], tookMs: Date.now() - started, total: 0 }

  // 标题命中加权：页标题里出现的 term（对象名 / 表名场景的主路径）显著提权
  const lowered = terms.map(t => t.toLowerCase())
  for (const item of acc.values()) {
    const ref = metaByIdx.get(item.docIdx)
    if (!ref) continue
    const title = (ref.meta.titles[item.pageIdx] || '').toLowerCase()
    if (!title) continue
    for (const t of lowered) {
      if (title.includes(t)) item.score += t.length >= 4 ? 6 : 2
    }
  }

  const sorted = Array.from(acc.values()).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(topK, 200)))
  const hits = []
  for (const item of sorted) {
    const ref = metaByIdx.get(item.docIdx)
    if (!ref) continue
    const page = readPage(ref.id, item.pageIdx)
    if (!page) continue
    hits.push({
      docId: ref.id,
      docName: ref.meta.name,
      pageIndex: item.pageIdx,
      pageTitle: page.head || `第${item.pageIdx + 1}页`,
      score: Number(item.score.toFixed(4)),
      text: page.text.length > perHitChars ? page.text.slice(0, perHitChars) : page.text,
    })
  }
  return { hits, tookMs: Date.now() - started, total: acc.size }
}

/** 判断某篇文档是否已入索引 */
export function hasDocument(docId) {
  return state.docs.has(docId)
}

/** 某篇文档已入索引的页数（0 表示未入索引） */
export function indexedPageCount(docId) {
  const meta = state.docs.get(docId)
  return meta ? meta.titles.length : 0
}
