// 知识上下文组装（检索相关）回归用例。
//
// 背景缺陷：XML 数据导出文档正文不下发浏览器（contentOmitted），于是
//   ① 上下文里的「文档目录」一个对象名都列不出来；
//   ② 命中页里界面组件（widget）的大 JSON 把真正的 SQL 定义（query.sql）挤出了单篇预算；
//   模型因此拿**文档名**当数据库表，编出 `FROM Z_WIDGET ... LIKE '%作业指导书%'` 这种不存在的 SQL。
// 本文件锁定修复后的行为：对象目录注入、SQL 页优先、跨文档保底配额、预算不再被空目录浪费。
import { describe, it, expect } from 'vitest'
import { buildKnowledgeContext } from './knowledgeService'
import type { ServerSearchHit, SearchObject } from './searchApi'

const LOGIC_DOC_NAME = 'Z_LOGIC_202609101240.xml'
const WIDGET_DOC_NAME = 'Z_WIDGET_202609101235.xml'
const FLOW_DOC_NAME = 'Z_FLOW_202609101240.xml'
const LOGIC_ID = `doc-${LOGIC_DOC_NAME}`
const WIDGET_ID = `doc-${WIDGET_DOC_NAME}`
const FLOW_ID = `doc-${FLOW_DOC_NAME}`

/** 构造「超大 XML 文档」的瘦身形态：有 id/name/status，但正文不在浏览器里 */
function slimXmlDoc(name: string, pageCount: number) {
  return {
    id: `doc-${name}`,
    name,
    type: 'xml',
    status: 'approved',
    contentOmitted: true,
    pageCount,
    keywords: [],
  } as any
}

function hit(over: Partial<ServerSearchHit> & { docId: string; docName: string }): ServerSearchHit {
  return { pageIndex: 0, pageTitle: 'X · Y', score: 10, text: '', ...over }
}

const QUERY = '给出查询作业指导书明细有哪些文件上传过的SQL'

const SQL_STATEMENT = [
  'SELECT ZS.WORK_CENTER, ZS.ITEM, ZS.OPERATION, ZS.SOP_FILE, ZS.CREATE_USER',
  'FROM Z_SOP ZS',
  "INNER JOIN ITEM IT ON IT.SITE = ZS.SITE AND ZS.ITEM = IT.ITEM AND IT.CURRENT_REVISION = 'true'",
  'WHERE ZS.SITE = :SITE',
].join('\n')

const sqlHit: ServerSearchHit = hit({
  docId: LOGIC_ID,
  docName: LOGIC_DOC_NAME,
  pageIndex: 603,
  pageTitle: 'query.ce.sop.list · 查询作业指导书列表',
  score: 38.7,
  objectNo: 'query.ce.sop.list',
  objectDesc: '查询作业指导书列表',
  objectType: 'query.sql',
  kind: 'sql',
  text: `query.ce.sop.list · 查询作业指导书列表\nLOGIC_NO: query.ce.sop.list\nTYPE_CATEGORY_NO: query.sql\nSTATEMENT: ${SQL_STATEMENT}`,
})

const widgetHit: ServerSearchHit = hit({
  docId: WIDGET_ID,
  docName: WIDGET_DOC_NAME,
  pageIndex: 770,
  pageTitle: 'UM0CEMM005 · 作业指导书维护',
  score: 37.8,
  objectNo: 'UM0CEMM005',
  objectDesc: '作业指导书维护',
  objectType: 'widget',
  kind: 'widget',
  text: `UM0CEMM005 · 作业指导书维护\nWIDGET_NO: UM0CEMM005\nTYPE_CATEGORY_NO: widget\nSTRACTURE: ${'{"clazz":"G.widget.Layout"},'.repeat(400)}`,
})

const flowHit: ServerSearchHit = hit({
  docId: FLOW_ID,
  docName: FLOW_DOC_NAME,
  pageIndex: 646,
  pageTitle: 'PM1CEMM017 · 作业指导书维护-保存',
  score: 29.4,
  objectNo: 'PM1CEMM017',
  objectDesc: '作业指导书维护-保存',
  objectType: 'A',
  kind: 'flow',
  text: `PM1CEMM017 · 作业指导书维护-保存\nFLOW_NO: PM1CEMM017\nWIND_ELEMENT: ${'{"STEPS":[]},'.repeat(300)}`,
})

const DOCS = [slimXmlDoc(LOGIC_DOC_NAME, 2035), slimXmlDoc(WIDGET_DOC_NAME, 1265), slimXmlDoc(FLOW_DOC_NAME, 1350)]
const HITS = [widgetHit, sqlHit, flowHit] // 故意让界面页分数更高、排在前面
const OBJECTS: SearchObject[] = [
  { docId: LOGIC_ID, docName: LOGIC_DOC_NAME, pageIndex: 603, objectNo: 'query.ce.sop.list', objectDesc: '查询作业指导书列表', objectType: 'query.sql', kind: 'sql', score: 38.7 },
  { docId: LOGIC_ID, docName: LOGIC_DOC_NAME, pageIndex: 602, objectNo: 'query.ce.sop', objectDesc: '查询作业指导书', objectType: 'query.sql', kind: 'sql', score: 38.7 },
  { docId: WIDGET_ID, docName: WIDGET_DOC_NAME, pageIndex: 770, objectNo: 'UM0CEMM005', objectDesc: '作业指导书维护', objectType: 'widget', kind: 'widget', score: 37.8 },
]

describe('buildKnowledgeContext：对象目录注入', () => {
  it('注入对象清单，模型能看到库里真实存在的对象与类型', () => {
    const ctx = buildKnowledgeContext(DOCS, QUERY, 60000, 'detail', HITS, OBJECTS)
    expect(ctx).toContain('与问题相关的对象目录')
    expect(ctx).toContain('| 对象编号 | 描述 | 类型 | 所属文档 |')
    expect(ctx).toContain('query.ce.sop.list')
    expect(ctx).toContain('查询作业指导书列表')
    expect(ctx).toContain('query.sql')
    expect(ctx).toContain(`按相关度匹配到 ${OBJECTS.length} 个对象`)
  })

  it('不传 objectIndex 时与历史行为一致（不出现对象目录段）', () => {
    const ctx = buildKnowledgeContext(DOCS, QUERY, 60000, 'detail', HITS)
    expect(ctx).not.toContain('与问题相关的对象目录')
    expect(ctx).toContain('知识库文档目录')
  })

  it('对象描述里的竖线不会破坏表格结构', () => {
    const objs: SearchObject[] = [{ ...OBJECTS[0], objectDesc: '查询作业指导书|含附件' }]
    const ctx = buildKnowledgeContext(DOCS, QUERY, 60000, 'detail', HITS, objs)
    expect(ctx).toContain('查询作业指导书\\|含附件')
  })
})

describe('buildKnowledgeContext：SQL 页优先与保底配额', () => {
  it('注入内容含真实 SQL 定义（模型可直接逐字引用）', () => {
    const ctx = buildKnowledgeContext(DOCS, QUERY, 60000, 'detail', HITS, OBJECTS)
    expect(ctx).toContain('FROM Z_SOP ZS')
    expect(ctx).toContain('query.ce.sop.list')
    expect(ctx).toContain('（对象类型：query.sql）')
  })

  it('同一篇内 SQL 页排在界面页之前', () => {
    // 把界面页与 SQL 页放进同一篇文档，且界面页分数更高、数组顺序也在前：
    // 组内排序必须把 query.sql 页提到前面，否则它会被界面页挤出单篇预算。
    const widgetInLogic: ServerSearchHit = { ...widgetHit, docId: LOGIC_ID, score: 99 }
    const ctx = buildKnowledgeContext(DOCS, QUERY, 60000, 'detail', [widgetInLogic, sqlHit], null)
    const iSql = ctx.indexOf('query.ce.sop.list')
    const iWidget = ctx.indexOf('UM0CEMM005')
    expect(iSql).toBeGreaterThan(-1)
    expect(iWidget).toBeGreaterThan(-1)
    expect(iSql).toBeLessThan(iWidget)
  })

  it('多篇命中时每篇都能进入上下文（单篇大 JSON 不能挤掉其他文档）', () => {
    const ctx = buildKnowledgeContext(DOCS, QUERY, 60000, 'detail', HITS, OBJECTS)
    for (const name of [LOGIC_DOC_NAME, WIDGET_DOC_NAME, FLOW_DOC_NAME]) {
      expect(ctx).toContain(`### 文档：${name}`)
    }
  })

  it('预算极小时仍优先保住 SQL 定义', () => {
    const ctx = buildKnowledgeContext(DOCS, QUERY, 12000, 'detail', HITS, OBJECTS)
    expect(ctx).toContain('FROM Z_SOP ZS')
    expect(ctx).toContain(`### 文档：${LOGIC_DOC_NAME}`)
  })
})

describe('buildKnowledgeContext：XML 空目录的预算回补', () => {
  it('单篇可注入超过旧上限（contentBudget/4 时代的 ~9750）的正文', () => {
    // 一篇命中正文长 13000 字符：
    //   旧实现 perDocBudget = max(8000, 39000/4) = 9750 → 尾部标记必然被截掉；
    //   新实现 contentBudget = 60000 - 实际目录用量(≈1000)，perDocBudget ≈ 14750 → 完整注入。
    const longText = `UM2LSWR004 · 上传SVG\nWIDGET_NO: UM2LSWR004\nSTRACTURE: ${'x'.repeat(12900)}\nSOP_TAIL_MARKER`
    const longHit: ServerSearchHit = { ...widgetHit, text: longText, pageTitle: 'UM2LSWR004 · 上传SVG' }
    const ctx = buildKnowledgeContext(DOCS, QUERY, 60000, 'detail', [longHit], null)
    expect(ctx).toContain('SOP_TAIL_MARKER')
  })
})

describe('buildKnowledgeContext：档位预算不被绝对值下限击穿', () => {
  it('本地小档位（6000）下总长受控，且仍保住真实 SQL', () => {
    // 旧实现 perDocBudget = max(8000, contentBudget/4)、summaryBudget = max(16000, …)，
    // 这两个**绝对值下限**会击穿 6000 的档位预算（实测请求 6000 实际产出 7927 字符），
    // 对本地小模型既拖慢首字又挤掉其他命中文档。新实现按 totalLimit 封顶 + 按剩余预算截断。
    const bigSql: ServerSearchHit = { ...sqlHit, text: `${sqlHit.text}\n${'y'.repeat(30000)}` }
    const bigWidget: ServerSearchHit = { ...widgetHit, text: `${widgetHit.text}\n${'x'.repeat(30000)}` }
    const ctx = buildKnowledgeContext(DOCS, QUERY, 6000, 'detail', [bigSql, bigWidget], OBJECTS)
    expect(ctx).toContain('FROM Z_SOP ZS')
    expect(ctx.length).toBeLessThan(6000 * 1.35)
  })
})
