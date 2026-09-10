import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  decodeEntities,
  parseRecordFields,
  pickObjectKey,
  pickDescKey,
  tableNameFromRoot,
  recordToPage,
  parseXmlText,
  parseXmlFile,
} from './xmlParser'

const LOGIC_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<SELECT_FROM_Z_LOGIC_WHERE_IS_CURRENT_Y_ORDER_BY_LOGIC_NO_>
  <DATA_RECORD>
    <SID>262648de-2795-4466-afd0-5980898a1379</SID>
    <LOGIC_NO>C</LOGIC_NO>
    <LOGIC_DESC>查询库存列表</LOGIC_DESC>
    <TYPE_CATEGORY_NO>query.sql</TYPE_CATEGORY_NO>
    <STATEMENT>SELECT '1' SEQ FROM DUMMY</STATEMENT>
    <METHOD_NAME></METHOD_NAME>
  </DATA_RECORD>
  <DATA_RECORD>
    <SID>aee92167-1fdb-49ac-a219-78e37edd4a98</SID>
    <LOGIC_NO>ENTER.EVENT.POD.BZ.ITEM.LOAD</LOGIC_NO>
    <LOGIC_DESC>包装的产品条码回车事件</LOGIC_DESC>
    <STATEMENT>var myData = G.getPlugin("B").custom.getData();
var param = {"SFC":myData.SFC};</STATEMENT>
    <METHOD_NAME>query</METHOD_NAME>
  </DATA_RECORD>
</SELECT_FROM_Z_LOGIC_WHERE_IS_CURRENT_Y_ORDER_BY_LOGIC_NO_>
`

const QUEUE_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<SELECT_FROM_Z_QUEUE>
  <DATA_RECORD>
    <SID>CE_QUEUE_2</SID>
    <QUEUE>param.download.process</QUEUE>
    <FLOW_NO>PM1CEEI028</FLOW_NO>
    <QUEUQ_DESC>下载工艺参数</QUEUQ_DESC>
    <ENABLE>Y</ENABLE>
  </DATA_RECORD>
</SELECT_FROM_Z_QUEUE>
`

/** 构造最小可用的假 File：只实现 parseXmlFile 用到的 size / slice */
function makeFakeFile(content: string): File {
  const bytes = new TextEncoder().encode(content)
  return {
    size: bytes.length,
    slice(start: number, end: number) {
      const part = bytes.slice(start, end)
      return {
        arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      }
    },
  } as unknown as File
}

describe('xmlParser - 实体与字段', () => {
  it('解码 XML 实体', () => {
    expect(decodeEntities('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d')
    expect(decodeEntities('&quot;x&quot; &apos;y&apos;')).toBe('"x" \'y\'')
    expect(decodeEntities('&#65;&#x42;')).toBe('AB')
    expect(decodeEntities('plain text')).toBe('plain text')
  })

  it('解析字段并保留多行值，空字段保留为空串', () => {
    const fields = parseRecordFields(
      '<SID>abc</SID><LOGIC_NO>C</LOGIC_NO><STATEMENT>SELECT 1\nFROM DUAL</STATEMENT><EMPTY></EMPTY>'
    )
    expect(fields.SID).toBe('abc')
    expect(fields.LOGIC_NO).toBe('C')
    expect(fields.STATEMENT).toBe('SELECT 1\nFROM DUAL')
    expect(fields.EMPTY).toBe('')
  })

  it('剥离 CDATA 包裹', () => {
    const fields = parseRecordFields('<STATEMENT><![CDATA[SELECT * FROM T]]></STATEMENT>')
    expect(fields.STATEMENT).toBe('SELECT * FROM T')
  })

  it('从根元素推断表名（Z_ 前缀、_WHERE_/_ORDER_ 后缀剥离）', () => {
    expect(tableNameFromRoot('SELECT_FROM_Z_LOGIC_WHERE_IS_CURRENT_Y_ORDER_BY_LOGIC_NO_')).toBe('LOGIC')
    expect(tableNameFromRoot('SELECT_FROM_Z_QUEUE')).toBe('QUEUE')
    expect(tableNameFromRoot('SELECT_FROM_Z_WIDGET')).toBe('WIDGET')
    expect(tableNameFromRoot('Z_FLOW')).toBe('FLOW')
  })

  it('对象编号优先 *_NO 并排除 UUID 形态的 SID', () => {
    const fields = parseRecordFields(
      '<SID>262648de-2795-4466-afd0-5980898a1379</SID><LOGIC_NO>C</LOGIC_NO>'
    )
    expect(pickObjectKey(fields)).toBe('LOGIC_NO')
  })

  it('表名推断优先：QUEUE 表取 QUEUE 而非 FLOW_NO', () => {
    const fields = { SID: 'CE_QUEUE_2', QUEUE: 'param.download.process', FLOW_NO: 'PM1CEEI028' }
    expect(pickObjectKey(fields, 'QUEUE')).toBe('QUEUE')
    // 不传表名时按首个 *_NO 回退
    expect(pickObjectKey(fields)).toBe('FLOW_NO')
    expect(pickObjectKey({ SID: 'CE_QUEUE_2' })).toBe('SID')
  })

  it('跳过枚举类编号字段（TYPE_CATEGORY_NO / STATUS_CATEGORY_NO）', () => {
    const fields = { SID: 'x', TYPE_CATEGORY_NO: 'widget', WIDGET_NO: 'U00CO00031', STATUS_CATEGORY_NO: 'enable' }
    expect(pickObjectKey(fields, 'WIDGET')).toBe('WIDGET_NO')
    expect(pickObjectKey(fields)).toBe('WIDGET_NO')
  })

  it('描述字段识别 *_DESC（含拼写变体 QUEUQ_DESC）', () => {
    expect(pickDescKey({ LOGIC_DESC: '查询库存' }, 'LOGIC')).toBe('LOGIC_DESC')
    expect(pickDescKey({ QUEUQ_DESC: '下载工艺参数' }, 'QUEUE')).toBe('QUEUQ_DESC')
    expect(pickDescKey({ FLOW_NO: 'A' })).toBe('')
  })
})

describe('xmlParser - 记录转页面', () => {
  it('标题为「对象编号 · 描述」，空字段不进页', () => {
    const fields = { SID: 'x', LOGIC_NO: 'C', LOGIC_DESC: '查询库存列表', STATEMENT: 'SELECT 1', EMPTY: '  ' }
    const { page, objectName, objectDesc } = recordToPage(fields, 1, 'LOGIC_NO', 'LOGIC_DESC')
    expect(objectName).toBe('C')
    expect(objectDesc).toBe('查询库存列表')
    expect(page.title).toBe('C · 查询库存列表')
    expect(page.pageNum).toBe(1)
    expect(page.paragraphs.some(p => p.startsWith('STATEMENT:'))).toBe(true)
    expect(page.paragraphs.some(p => p.startsWith('EMPTY:'))).toBe(false)
  })
})

describe('xmlParser - 整文件解析', () => {
  it('解析 LOGIC 样例：2 条记录 → 2 页，根元素与字段名正确', () => {
    const r = parseXmlText(LOGIC_SAMPLE)
    expect(r.recordCount).toBe(2)
    expect(r.pages).toHaveLength(2)
    expect(r.rootTag).toBe('SELECT_FROM_Z_LOGIC_WHERE_IS_CURRENT_Y_ORDER_BY_LOGIC_NO_')
    expect(r.objectKey).toBe('LOGIC_NO')
    expect(r.descKey).toBe('LOGIC_DESC')
    expect(r.pages[0].title).toBe('C · 查询库存列表')
    expect(r.pages[1].title).toBe('ENTER.EVENT.POD.BZ.ITEM.LOAD · 包装的产品条码回车事件')
    expect(r.fieldNames).toContain('STATEMENT')
    expect(r.text).toContain('【C · 查询库存列表】')
  })

  it('解析 QUEUE 样例：无 *_NO 时以 QUEUE 作为对象编号', () => {
    const r = parseXmlText(QUEUE_SAMPLE)
    expect(r.recordCount).toBe(1)
    expect(r.objectKey).toBe('QUEUE')
    expect(r.pages[0].title).toBe('param.download.process · 下载工艺参数')
  })

  it('分块读取（每块 64 字节）与整读结果一致：不丢记录、不截断', async () => {
    const file = makeFakeFile(LOGIC_SAMPLE)
    const streamed = await parseXmlFile(file, { chunkSize: 64 })
    const whole = parseXmlText(LOGIC_SAMPLE)
    expect(streamed.recordCount).toBe(whole.recordCount)
    expect(streamed.text).toBe(whole.text)
    expect(streamed.pages.map(p => p.title)).toEqual(whole.pages.map(p => p.title))
  })

  it('大记录跨多个块也能完整还原', async () => {
    const big = '<STATEMENT>' + 'X'.repeat(5000) + '</STATEMENT>'
    const xml = `<ROOT><DATA_RECORD><LOGIC_NO>BIG</LOGIC_NO>${big}</DATA_RECORD></ROOT>`
    const streamed = await parseXmlFile(makeFakeFile(xml), { chunkSize: 100 })
    expect(streamed.recordCount).toBe(1)
    expect(streamed.pages[0].paragraphs.some(p => p.includes('X'.repeat(5000)))).toBe(true)
  })
})

// 真实导出样例（项目外目录）：存在时才跑，用于验证解析规则与真实数据吻合
const SAMPLE_DIR = 'C:/Users/Administrator/WorkBuddy/AI智能助手/例子'
describe('xmlParser - 真实导出样例', () => {
  const hasSamples = fs.existsSync(SAMPLE_DIR)

  it.skipIf(!hasSamples)('Z_QUEUE 样例：54 条记录，对象名为 QUEUE', () => {
    const file = path.join(SAMPLE_DIR, fs.readdirSync(SAMPLE_DIR).find(f => f.startsWith('Z_QUEUE') && f.endsWith('.xml'))!)
    const r = parseXmlText(fs.readFileSync(file, 'utf-8'))
    expect(r.recordCount).toBe(54)
    expect(r.objectKey).toBe('QUEUE')
    expect(r.pages[0].title).toContain('param.download.process')
  })

  it.skipIf(!hasSamples)('Z_LOGIC 样例：2035 条记录，对象名为 LOGIC_NO', () => {
    const file = path.join(SAMPLE_DIR, fs.readdirSync(SAMPLE_DIR).find(f => f.startsWith('Z_LOGIC') && f.endsWith('.xml'))!)
    const r = parseXmlText(fs.readFileSync(file, 'utf-8'))
    expect(r.recordCount).toBe(2035)
    expect(r.objectKey).toBe('LOGIC_NO')
    expect(r.descKey).toBe('LOGIC_DESC')
  })

  it.skipIf(!hasSamples)('Z_WIDGET / Z_FLOW 样例：记录数与对象名正确（14MB+ 大文件）', () => {
    const files = fs.readdirSync(SAMPLE_DIR).filter(f => f.endsWith('.xml'))
    const widget = path.join(SAMPLE_DIR, files.find(f => f.startsWith('Z_WIDGET'))!)
    const flow = path.join(SAMPLE_DIR, files.find(f => f.startsWith('Z_FLOW'))!)
    const rw = parseXmlText(fs.readFileSync(widget, 'utf-8'))
    const rf = parseXmlText(fs.readFileSync(flow, 'utf-8'))
    expect(rw.recordCount).toBe(1265)
    expect(rw.objectKey).toBe('WIDGET_NO')
    expect(rf.recordCount).toBe(1350)
    expect(rf.objectKey).toBe('FLOW_NO')
  })
})
