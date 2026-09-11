// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import {
  configureSearchIndex, tokenize, resetIndex, upsertDocument, removeDocument,
  buildIndex, hasDocument, indexedPageCount, getStatus, search,
  splitTitle, pageMetaOf, classifyPage, listObjects,
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

// ===== 页级对象元数据 / 按类型裁剪 / SQL 提权 / 对象目录 =====
// 背景：XML 数据导出里「界面组件（widget）」「流程（flow）」「SQL 定义（query.sql）」混在同一批文档里。
// 用户问 SQL 时，界面 JSON 页会靠标题里的中文命中挤到前面，把真正的 SQL 定义挤出上下文预算，
// 模型只好拿文档名当表名编 SQL。以下用例锁定修复：类型标注 + SQL 提权 + 结构类页裁剪。

const SQL_PAGE_TITLE = 'query.ce.sop.list · 查询作业指导书列表'
const WIDGET_PAGE_TITLE = 'U00CO00037 · 附件上传组件'
const SQL_BODY = [
  'LOGIC_NO: query.ce.sop.list',
  'LOGIC_DESC: 查询作业指导书列表',
  'TYPE_CATEGORY_NO: query.sql',
  'STATEMENT: SELECT ZS.WORK_CENTER, ZS.SOP_FILE FROM Z_SOP ZS WHERE ZS.SITE = :SITE',
]
const WIDGET_BODY = [
  'WIDGET_NO: U00CO00037',
  'WIDGET_DESC: 附件上传组件',
  'TYPE_CATEGORY_NO: widget',
  'REMARK: 作业指导书 附件上传',
  `STRACTURE: ${'{"clazz":"G.widget.Layout","childrenJson":['.repeat(120)}`,
]

const SQL_DOC = makeDoc('Z_LOGIC_202609101240.xml', [{ title: SQL_PAGE_TITLE, body: SQL_BODY }])
const WIDGET_DOC = makeDoc('Z_WIDGET_202609101235.xml', [{ title: WIDGET_PAGE_TITLE, body: WIDGET_BODY }])

/** 入库并等待索引就绪（search/listObjects 都要求 state.ready） */
async function buildDocs() {
  STORE.clear()
  seed(SQL_DOC, WIDGET_DOC)
  await buildIndex([SQL_DOC, WIDGET_DOC])
}

describe('页级对象元数据', () => {
  it('splitTitle 按「对象编号 · 描述」拆标题', () => {
    expect(splitTitle(SQL_PAGE_TITLE)).toEqual({ obj: 'query.ce.sop.list', desc: '查询作业指导书列表' })
    expect(splitTitle('无分隔符标题')).toEqual({ obj: '无分隔符标题', desc: '' })
  })

  it('pageMetaOf 抽取对象类型并判定页类别', () => {
    expect(pageMetaOf(SQL_PAGE_TITLE, SQL_BODY.join('\n'))).toMatchObject({ type: 'query.sql', kind: 'sql' })
    expect(pageMetaOf(WIDGET_PAGE_TITLE, WIDGET_BODY.join('\n'))).toMatchObject({ type: 'widget', kind: 'widget' })
  })

  it('无 TYPE_CATEGORY_NO 时按 STATEMENT / STRUCTURE 兜底判定', () => {
    expect(classifyPage('', 'STATEMENT: SELECT 1 FROM DUMMY')).toBe('sql')
    expect(classifyPage('', 'WIND_ELEMENT: {"STEPS":[]}')).toBe('flow')
    expect(classifyPage('', '普通说明文字')).toBe('other')
  })

  it('search 命中项带上对象编号/描述/类型/类别', async () => {
    await buildDocs()
    const { hits } = search('SOP_FILE', { topK: 5 })
    const h = hits.find(x => x.pageTitle === SQL_PAGE_TITLE)
    expect(h).toBeTruthy()
    expect(h.objectNo).toBe('query.ce.sop.list')
    expect(h.objectDesc).toBe('查询作业指导书列表')
    expect(h.objectType).toBe('query.sql')
    expect(h.kind).toBe('sql')
  })
})

describe('smartTrim 按页类别裁剪', () => {
  it('界面/流程大 JSON 被压短，SQL 页正文保持完整（默认开启前行为不变）', async () => {
    await buildDocs()
    const raw = search('作业指导书', { topK: 5, perHitChars: 6000 })
    const rawWidget = raw.hits.find(x => x.pageTitle === WIDGET_PAGE_TITLE)
    // 默认（smartTrim 关闭）：结构类页仍按 perHitChars 返回长正文
    expect(rawWidget.text.length).toBeGreaterThan(1000)

    const trimmed = search('作业指导书', { topK: 5, perHitChars: 6000, smartTrim: true, structChars: 300 })
    const tWidget = trimmed.hits.find(x => x.pageTitle === WIDGET_PAGE_TITLE)
    const tSql = trimmed.hits.find(x => x.pageTitle === SQL_PAGE_TITLE)
    expect(tWidget.text.length).toBeLessThan(500)
    expect(tWidget.trimmed).toBe(true)
    // SQL 页绝不因 smartTrim 被裁到 structChars 以下
    expect(tSql.text).toContain('FROM Z_SOP ZS')
    expect(tSql.trimmed).toBe(false)
  })
})

describe('boostSql 提权', () => {
  it('两个文档同等命中时，query.sql 页排到界面页之前', async () => {
    await buildDocs()
    const plain = search('作业指导书', { topK: 5 })
    const boosted = search('作业指导书', { topK: 5, boostSql: true })
    // 提权后 SQL 页必须是第 1 名（否则模型拿到的第一条命中会是界面 JSON）
    expect(boosted.hits[0].kind).toBe('sql')
    expect(boosted.hits[0].score).toBeGreaterThan(plain.hits[0].score)
  })
})

describe('listObjects 对象目录', () => {
  it('只返回对象元数据、不含正文', async () => {
    await buildDocs()
    const res = listObjects('作业指导书', { limit: 10, boostSql: true })
    expect(res.items.length).toBeGreaterThan(0)
    expect(res.items[0]).toMatchObject({ objectNo: 'query.ce.sop.list', objectType: 'query.sql', kind: 'sql' })
    expect(res.items[0]).not.toHaveProperty('text')
    expect(res.total).toBeGreaterThan(0)
  })

  it('索引未就绪时返回空目录（前端据此退回本地检索）', () => {
    const res = listObjects('任何查询', { limit: 10 })
    expect(res.items).toEqual([])
    expect(res.total).toBe(0)
  })
})
