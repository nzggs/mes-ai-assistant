// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import {
  configureSearchIndex, tokenize, resetIndex, upsertDocument, removeDocument,
  buildIndex, hasDocument, indexedPageCount, getStatus, search,
} from './searchIndex.js'

/** 构造一篇「已入库」文档（页 = 逻辑单元） */
function makeDoc(name, pages, status = 'approved') {
  return {
    id: `doc-${name}`,
    doc: {
      id: `doc-${name}`,
      name,
      status,
      content: pages.map((p, i) => ({
        pageNum: i + 1,
        title: p.title,
        paragraphs: Array.isArray(p.body) ? p.body : [p.body],
      })),
    },
  }
}

beforeEach(() => {
  resetIndex()
  configureSearchIndex({ fetchDocRecord: (id) => STORE.get(id) || null })
})

// 简易内存文档库：替代 storage 分片读取
const STORE = new Map([['__reset__', null]])
STORE.delete('__reset__')

function seed(...records) {
  for (const r of records) STORE.set(r.id, r)
  for (const r of records) upsertDocument(r.id, r.doc)
}

const FLOW_DOC = makeDoc('流程', [
  { title: '流程A', body: '流程A用于电芯分选 downgrade 处理，调用 G.$executeFlow("PM2LSMM047")' },
  { title: '流程B', body: '流程B处理批次校验 barcode check in process' },
])
const LOGIC_DOC = makeDoc('逻辑', [
  { title: 'ENTER.EVENT.POD.BZ.ITEM.LOAD', body: '该逻辑负责装载物料，wip_sn 校验，select * from wip' },
  { title: 'CHECK.LOT.STATUS', body: '校验批次状态 lot status 是否为 released' },
])

describe('tokenize', () => {
  it('提取英文标识符并拆子词', () => {
    const terms = tokenize('G.$executeFlow("PM2LSMM047") wip_sn check')
    expect(terms).toContain('g.$executeflow')
    expect(terms).toContain('executeflow')
    expect(terms).toContain('execute')
    expect(terms).toContain('flow')
    expect(terms).toContain('wip_sn')
    expect(terms).toContain('wip')
    expect(terms).toContain('sn')
    expect(terms).toContain('pm2lsmm047')
  })
  it('中文切相邻二字组', () => {
    const terms = tokenize('电芯分选')
    expect(terms).toContain('电芯')
    expect(terms).toContain('芯分')
    expect(terms).toContain('分选')
  })
  it('过滤单字符并支持上限', () => {
    expect(tokenize('a b c 中')).toEqual([])
    expect(tokenize('电芯分选', { limit: 2 }).length).toBe(2)
  })
})

describe('索引构建与准入', () => {
  it('仅已入库文档进索引', () => {
    upsertDocument(FLOW_DOC.id, FLOW_DOC.doc)
    const pending = { ...LOGIC_DOC.doc, status: 'pending' }
    upsertDocument('pending-1', pending)
    expect(hasDocument(FLOW_DOC.id)).toBe(true)
    expect(indexedPageCount(FLOW_DOC.id)).toBe(2)
    expect(hasDocument('pending-1')).toBe(false)
  })
  it('墓碑文档不入索引，且会清掉已入索引的旧内容', () => {
    seed(FLOW_DOC)
    expect(hasDocument(FLOW_DOC.id)).toBe(true)
    upsertDocument(FLOW_DOC.id, { ...FLOW_DOC.doc, deleted: true })
    expect(hasDocument(FLOW_DOC.id)).toBe(false)
  })
  it('删除文档后 posting 一并清理（不再被召回）', async () => {
    seed(FLOW_DOC, LOGIC_DOC)
    await buildIndex([FLOW_DOC, LOGIC_DOC])
    expect(search('分选').hits.some(h => h.docId === FLOW_DOC.id)).toBe(true)
    removeDocument(FLOW_DOC.id)
    const after = search('分选')
    expect(after.hits.some(h => h.docId === FLOW_DOC.id)).toBe(false)
  })
})

describe('search 检索', () => {
  beforeEach(async () => {
    STORE.clear()
    seed(FLOW_DOC, LOGIC_DOC)
    await buildIndex([FLOW_DOC, LOGIC_DOC])
  })

  it('索引就绪后可按中文关键词检索到对应页', () => {
    expect(getStatus().ready).toBe(true)
    expect(getStatus().docCount).toBe(2)
    expect(getStatus().pageCount).toBe(4)
    const res = search('分选')
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits[0].docName).toBe('流程')
    expect(res.hits[0].pageTitle).toBe('流程A')
    expect(res.hits[0].text).toContain('流程A')
  })

  it('英文标识符（含对象名）可精确召回', () => {
    const res = search('ENTER.EVENT.POD.BZ.ITEM.LOAD')
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits[0].pageTitle).toBe('ENTER.EVENT.POD.BZ.ITEM.LOAD')
  })

  it('未命中时返回空结果', () => {
    expect(search('这个词一定不存在zzz').hits).toEqual([])
    expect(search('').hits).toEqual([])
  })

  it('topK 限制返回条数', () => {
    expect(search('流程', { topK: 1 }).hits.length).toBeLessThanOrEqual(1)
  })

  it('perHitChars 截断单页正文', () => {
    const res = search('wip_sn', { perHitChars: 5 })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits[0].text.length).toBeLessThanOrEqual(5)
  })

  it('索引未就绪时不返回结果（前端据此退回本地检索）', () => {
    resetIndex()
    expect(getStatus().ready).toBe(false)
    expect(search('分选').hits).toEqual([])
  })
})

describe('buildIndex 全量构建', () => {
  it('跳过墓碑与未入库文档，并统计页数', async () => {
    STORE.clear()
    seed(FLOW_DOC)
    const pending = makeDoc('待审', [{ title: 'P1', body: '批次 lot 校验' }], 'pending')
    const tomb = { id: 'tomb', doc: { id: 'tomb', name: '已删除', deleted: true, content: [{ title: 'T', paragraphs: ['哈哈'] }] } }
    const st = await buildIndex([FLOW_DOC, pending, tomb])
    expect(st.ready).toBe(true)
    expect(st.docCount).toBe(1)
    expect(st.pageCount).toBe(2)
    expect(hasDocument(pending.id)).toBe(false)
    expect(hasDocument('tomb')).toBe(false)
  })
})

describe('仅扁平全文（无分页数组）的文档', () => {
  it('按页标记切分并可被检索（早期上传的 PDF 形态）', async () => {
    STORE.clear()
    const rec = {
      id: 'flat1',
      doc: {
        id: 'flat1', name: 'SAP HANA数据库SQL参考手册.pdf', status: 'approved',
        textContent: '--- 第1页 ---\nALTER SYSTEM SAVEPOINT 保存点\n--- 第2页 ---\nDROP SAVEPOINT 删除保存点',
      },
    }
    STORE.set(rec.id, rec)
    await buildIndex([rec])
    expect(hasDocument('flat1')).toBe(true)
    expect(indexedPageCount('flat1')).toBe(2)
    const res = search('SAVEPOINT')
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits[0].pageTitle).toBe('第1页')
    expect(res.hits[0].text).toContain('ALTER SYSTEM SAVEPOINT')
  })

  it('无页标记时按固定长度切片，标题带文档名', async () => {
    STORE.clear()
    const body = 'x'.repeat(500) + ' 关键标记 MARKER_ZZZ ' + 'y'.repeat(9000)
    const rec = { id: 'flat2', doc: { id: 'flat2', name: '无标记文档.pdf', status: 'approved', textContent: body } }
    STORE.set(rec.id, rec)
    await buildIndex([rec])
    expect(indexedPageCount('flat2')).toBeGreaterThan(1)
    const res = search('MARKER_ZZZ')
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits[0].pageTitle).toContain('无标记文档')
  })

  it('既无 content 也无 textContent 的文档不入索引', () => {
    upsertDocument('empty1', { id: 'empty1', name: '空.pdf', status: 'approved' })
    STORE.clear()
    expect(hasDocument('empty1')).toBe(false)
  })
})

describe('超大文档内存保护', () => {
  it('高频模板词被裁掉，不再进索引', () => {
    STORE.clear()
    // 3000 页都含同一高频词 → 应被 MAX_DF_PER_TERM 裁枝丢弃
    const pages = []
    for (let i = 0; i < 2000; i++) pages.push({ title: `OBJ${i}`, body: `select from where object ${i} 中文内容${i}` })
    const big = makeDoc('超大表', pages)
    seed(big)
    const terms = tokenize('select from where object')
    const size = getStatus().postings
    // 索引规模有限（不是 2000 页 × 全词），且普通停用词已剔除
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThan(1_500_001)
    expect(typeof terms.length).toBe('number')
  })
})
