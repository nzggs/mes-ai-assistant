// 知识上下文组装（文档台账 docIndex）回归用例。
//
// 背景缺陷：给模型的「共 N 篇已入库文档」的 N 用的是 usableDocs.length（approved **且**
// 有正文可注入/本次命中）。超大 XML（contentOmitted）正文被剥离后，若本次提问又没命中它，
// 就会被漏算——线上 5 篇 approved 被答成 4 篇（漏掉的是 Z_LOGIC_202609101240.xml）。
// 修复：buildKnowledgeContext 新增可选第 7 参 docIndex（/api/documents 台账），
// N 改为台账真值 counts.approved；不传时行为与历史逐字一致。
import { describe, it, expect } from 'vitest'
import { buildKnowledgeContext } from './knowledgeService'
import type { ServerSearchHit, DocIndexResult, DocIndexItem } from './searchApi'

const QUERY = '现在知识库里有几篇文档'

/** 有正文的 approved 文档（浏览器内可检索） */
function contentDoc(name: string, text: string) {
  return {
    id: `doc-${name}`, name, type: name.endsWith('.xml') ? 'xml' : 'pdf',
    status: 'approved', textContent: text, keywords: [],
  } as any
}

/** 超大 XML 的瘦身形态：正文不在浏览器里 */
function slimXmlDoc(name: string, pageCount: number) {
  return {
    id: `doc-${name}`, name, type: 'xml', status: 'approved',
    contentOmitted: true, pageCount, keywords: [],
  } as any
}

function hit(docId: string, docName: string): ServerSearchHit {
  return { docId, docName, pageIndex: 0, pageTitle: 'X · Y', score: 10, text: '命中内容' }
}

/**
 * 复刻线上形态：5 篇 approved，其中只有 4 篇"有正文可注入"——
 * pdf 有 textContent；Z_QUEUE 未达剥离阈值有 content；Z_WIDGET / Z_FLOW 靠本次命中；
 * **Z_LOGIC 既无正文又零命中 → 历史口径下被漏算的那一篇**。
 */
function buildFiveApprovedDocs() {
  const docs = [
    contentDoc('SAP HANA数据库SQL参考手册.pdf', 'x'.repeat(200)),
    { id: 'doc-Z_QUEUE.xml', name: 'Z_QUEUE_202609101238.xml', type: 'xml', status: 'approved', content: [{ title: 'QUEUE · 队列', paragraphs: ['队列数据'] }], keywords: [] } as any,
    slimXmlDoc('Z_WIDGET_202609101235.xml', 1265),
    slimXmlDoc('Z_FLOW_202609101240.xml', 1350),
    slimXmlDoc('Z_LOGIC_202609101240.xml', 2035),
  ]
  const hits: ServerSearchHit[] = [
    hit('doc-SAP HANA数据库SQL参考手册.pdf', 'SAP HANA数据库SQL参考手册.pdf'),
    hit('doc-Z_WIDGET_202609101235.xml', 'Z_WIDGET_202609101235.xml'),
    hit('doc-Z_FLOW_202609101240.xml', 'Z_FLOW_202609101240.xml'),
  ]
  return { docs, hits }
}

function ledgerDoc(name: string, pages: number, indexed = true): DocIndexItem {
  return {
    id: `doc-${name}`, name, type: name.endsWith('.xml') ? 'xml' : 'pdf', status: 'approved',
    pages, chunks: 0, size: '', uploadDate: '', approvedDate: '', uploaderName: '',
    indexed, indexedPages: pages,
  }
}

function ledger(over: Partial<DocIndexResult['counts']> = {}, items?: DocIndexItem[]): DocIndexResult {
  const items_ = items ?? [
    ledgerDoc('SAP HANA数据库SQL参考手册.pdf', 228),
    ledgerDoc('Z_QUEUE_202609101238.xml', 54),
    ledgerDoc('Z_WIDGET_202609101235.xml', 1265),
    ledgerDoc('Z_FLOW_202609101240.xml', 1350),
    ledgerDoc('Z_LOGIC_202609101240.xml', 2035),
  ]
  return {
    items: items_,
    total: items_.length,
    counts: { total: items_.length, approved: items_.length, pending: 0, rejected: 0, ...over },
  }
}

describe('不传 docIndex：与历史行为逐字一致（零回归）', () => {
  it('头部仍是 usableDocs.length（4），且不出现台账表', () => {
    const { docs, hits } = buildFiveApprovedDocs()
    const ctx = buildKnowledgeContext(docs, QUERY, 60000, 'detail', hits, null)
    // 历史口径：只有 4 篇"有正文可注入"，头部就是 4（缺陷本身，但不传参时不改变）
    expect(ctx).toContain('共 4 篇已入库文档')
    expect(ctx).not.toContain('| 文档名 | 类型 |')
  })

  it('没有任何 approved 文档时仍返回空串', () => {
    const ctx = buildKnowledgeContext([], QUERY, 60000, 'detail', [], null, ledger())
    expect(ctx).toBe('')
  })
})

describe('传入 docIndex：计数以台账真值为准（核心修复）', () => {
  it('5 篇 approved 但仅 4 篇有正文 → 必须报 5 篇（线上缺陷的精确复现场景）', () => {
    const { docs, hits } = buildFiveApprovedDocs()
    const ctx = buildKnowledgeContext(docs, QUERY, 60000, 'detail', hits, null, ledger())
    expect(ctx).toContain('共 5 篇已入库文档')
    expect(ctx).not.toContain('共 4 篇')
  })

  it('全部 approved 文档都进入台账表，含正文被剥离/未命中的那篇', () => {
    const { docs, hits } = buildFiveApprovedDocs()
    const ctx = buildKnowledgeContext(docs, QUERY, 60000, 'detail', hits, null, ledger())
    expect(ctx).toContain('| 文档名 | 类型 | 页数 | 状态 | 可检索 |')
    expect(ctx).toContain('Z_LOGIC_202609101240.xml') // 漏算的那篇必须在清单里
    expect(ctx).toContain('Z_QUEUE_202609101238.xml')
    expect(ctx).toContain('已入库')
  })

  it('存在待审核文档时补注「另有 N 篇待审核」', () => {
    const { docs, hits } = buildFiveApprovedDocs()
    const items = [...ledger().items, { ...ledgerDoc('待审核文档.docx', 3), status: 'pending' }]
    const lg = ledger({ total: 6, approved: 5, pending: 1, rejected: 0 }, items)
    const ctx = buildKnowledgeContext(docs, QUERY, 60000, 'detail', hits, null, lg)
    expect(ctx).toContain('共 5 篇已入库文档')
    expect(ctx).toContain('另有 1 篇待审核文档（尚未入库，不作为回答依据）')
    // 待审核文档不出现在台账表里（只列 approved）
    expect(ctx).not.toContain('待审核文档.docx')
  })

  it('台账计入目录预算：目录超预算时仍保留文档名（不省略条目）', () => {
    const { docs, hits } = buildFiveApprovedDocs()
    // 极小预算：台账表占掉大部分，目录块降级为只列文档名，但台账表本身不应被丢弃
    const ctx = buildKnowledgeContext(docs, QUERY, 1200, 'detail', hits, null, ledger())
    expect(ctx).toContain('共 5 篇已入库文档')
    expect(ctx).toContain('Z_LOGIC_202609101240.xml')
  })
})
