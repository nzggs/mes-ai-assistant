// ===== 知识库文档台账（只读轻量索引）=====
// 目的：给 AI / 前端一份「权威的文档清单」，避免模型靠数"可注入正文的文档"来回答
// 「知识库里有几篇文档」而数错（正文被剥离且本次未命中的 approved 文档会被漏算）。
//
// 设计红线：
//   ① 过滤删除墓碑（deleted === true），否则总数会被"已删除"占位记录撑大；
//   ② 返回项绝不携带 textContent / content / summaryChunks 等重字段；
//   ③ status 缺省归一化为 pending，与前端 docStore 的白名单保持一致；
//   ④ counts 三态（approved/pending/rejected）一次给全，调用方无需自己数。
//
// 数据来源（全部复用已导出 API，不改动 storage.js / searchIndex.js）：
//   readDocs()            —— storage 权威真值（含全部状态）
//   lightweightDoc()      —— 剥离正文的轻量投影
//   hasDocument() / indexedPageCount() —— 倒排索引侧：是否可检索 / 已索引页数
import { readDocs, lightweightDoc } from './storage.js'
import { hasDocument, indexedPageCount } from './searchIndex.js'

const STATUSES = ['approved', 'pending', 'rejected']

/** status 缺省（如墓碑外的异常记录）按 pending 处理，与前端归一化口径一致 */
function normStatus(doc) {
  return STATUSES.includes(doc.status) ? doc.status : 'pending'
}

/** 单篇文档的台账投影：只出元数据 */
function projectLedger(id, doc) {
  const light = lightweightDoc(doc)
  return {
    id,
    name: doc.name || '',
    type: doc.type || doc.fileType || '',
    status: normStatus(doc),
    pages: doc.pages ?? null,
    chunks: light.chunks ?? doc.chunks ?? 0,
    size: doc.size || '',
    uploadDate: doc.uploadDate || '',
    approvedDate: doc.approvedDate || '',
    uploaderName: doc.uploaderName || '',
    indexed: hasDocument(id),
    indexedPages: indexedPageCount(id),
  }
}

/**
 * 文档台账查询。
 * @param {object} opts
 * @param {string|null} opts.status  按 status 过滤（approved/pending/rejected），null 为不过滤
 * @param {string} opts.q            按文档名包含关键字过滤
 * @param {number} opts.limit        返回条数上限
 */
export function listDocuments({ status = null, q = '', limit = 200 } = {}) {
  // ① 墓碑过滤是第一条红线：deleted === true 的记录仍在存储里，不能计入台账
  const all = readDocs().filter(r => r?.doc && r.doc.deleted !== true)
  const items = all.map(r => projectLedger(r.id, r.doc))
  const counts = { total: items.length, approved: 0, pending: 0, rejected: 0 }
  for (const it of items) counts[it.status]++
  let out = items
  if (status) out = out.filter(it => it.status === status)
  const kw = String(q || '').trim().toLowerCase()
  if (kw) out = out.filter(it => it.name.toLowerCase().includes(kw))
  return { items: out.slice(0, limit), counts, total: out.length }
}

/** 挂载路由：GET /api/documents（只读，无鉴权，与其他检索类接口同级） */
export function registerDocIndexRoutes(app) {
  app.get('/api/documents', (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status).slice(0, 20) : null
      const q = String(req.query.q || '').slice(0, 200)
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500)
      res.json(listDocuments({ status, q, limit }))
    } catch (err) {
      console.error('[internal error]', err)
      res.status(500).json({ error: '服务器内部错误，请稍后再试' })
    }
  })
}
