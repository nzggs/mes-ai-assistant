/**
 * XML 数据导出文件解析器
 *
 * 面向场景：把数据库表（页面 / 逻辑 / 流程 / 队列等）导出成 XML 后导入知识库，
 * 让 AI 在问答时参考真实的对象定义与代码。
 *
 * 典型结构（一表一文件，一条记录一个逻辑单元）：
 * <?xml version="1.0" encoding="UTF-8"?>
 * <SELECT_FROM_Z_LOGIC_...>
 *   <DATA_RECORD>
 *     <SID>...</SID>
 *     <LOGIC_NO>ENTER.EVENT.POD.BZ.ITEM.LOAD</LOGIC_NO>
 *     <LOGIC_DESC>包装的产品条码回车事件</LOGIC_DESC>
 *     <STATEMENT>SELECT ...</STATEMENT>
 *   </DATA_RECORD>
 * </SELECT_FROM_Z_LOGIC_...>
 *
 * 设计要点：
 * 1. 分块流式读取（默认 4MB/块），不把整文件一次性读进内存，可处理几十 MB 的导出文件
 * 2. 一条 <DATA_RECORD> = 一个 DocPage，页标题取「对象编号 · 对象描述」，
 *    与现有检索链路对齐（页标题命中权重 ×4，便于按对象名精确召回）
 * 3. 不调用 LLM、不做任何语义预处理，解析结果即最终入库内容
 */

import type { DocPage } from '../types'

/** 单条记录的字段快照 */
export interface XmlRecordFields {
  [field: string]: string
}

export interface XmlParseResult {
  /** 全文文本（各记录拼接，用于 textContent） */
  text: string
  /** 分页内容：一条 DATA_RECORD 一页 */
  pages: DocPage[]
  /** 根元素名（通常即导出 SQL 的可读形式，如 SELECT_FROM_Z_LOGIC_...） */
  rootTag: string
  /** 记录总数 */
  recordCount: number
  /** 识别出的对象编号字段名（如 LOGIC_NO / FLOW_NO / WIDGET_NO） */
  objectKey: string
  /** 识别出的对象描述字段名（如 LOGIC_DESC / FLOW_DESC） */
  descKey: string
  /** 全部字段名（按首次出现顺序） */
  fieldNames: string[]
}

const OPEN_TAG = '<DATA_RECORD>'
const CLOSE_TAG = '</DATA_RECORD>'
/** 每次读取的块大小：4MB，兼顾内存与读取次数 */
const CHUNK_SIZE = 4 * 1024 * 1024

/** XML 实体解码（&lt; &gt; &amp; &quot; &apos; 与数字字符引用） */
export function decodeEntities(input: string): string {
  if (!input) return ''
  if (input.indexOf('&') === -1) return input
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    // &amp; 必须最后处理，避免二次解码
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 剥离 CDATA 包裹 */
function stripCdata(value: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value)
  return m ? m[1] : value
}

/**
 * 解析单条记录的字段。
 * 只取"顶层"字段：值内部若出现同名标签（极少见）以第一个闭合标签为准。
 */
export function parseRecordFields(raw: string): XmlRecordFields {
  const fields: XmlRecordFields = {}
  const re = /<([A-Za-z_][A-Za-z0-9_.:-]*)>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]
    const value = decodeEntities(stripCdata(m[2]))
    if (!(key in fields)) fields[key] = value
  }
  return fields
}

/**
 * 从根元素名推断表名。
 * 导出文件的根元素形如 `SELECT_FROM_Z_LOGIC_WHERE_IS_CURRENT_Y_ORDER_BY_LOGIC_NO_`，
 * 其中 `Z_LOGIC` 即源表名；去掉 Z_ 前缀后得到 `LOGIC`，主编号字段即 `LOGIC_NO`。
 */
export function tableNameFromRoot(rootTag: string): string {
  if (!rootTag) return ''
  const m = /SELECT_FROM_([A-Za-z0-9_]+?)(?:_WHERE_|_ORDER_|$)/i.exec(rootTag)
  let t = m ? m[1] : rootTag
  t = t.replace(/^Z_/i, '').replace(/_+$/, '')
  return t
}

/** 枚举/状态类字段：不能作为对象编号（值无区分度，如 TYPE_CATEGORY_NO=widget、STATUS_CATEGORY_NO=Y） */
const NOISE_NO_FIELDS = /^(TYPE_CATEGORY_NO|STATUS_CATEGORY_NO|CATEGORY_NO|SITE_NO)$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 识别对象编号字段。优先级：
 * 1. 由表名推断的候选（`LOGIC_NO`、`QUEUE_NO`，或 `QUEUE` 这类不带 _NO 的编号字段）
 * 2. 首个非枚举的 `*_NO` 字段（按字段出现顺序）
 * 3. 常见编号字段名 / SID
 */
export function pickObjectKey(fields: XmlRecordFields, tableName = ''): string {
  const has = (k: string) => fields[k] && fields[k].trim() && !UUID_RE.test(fields[k].trim())
  if (tableName) {
    for (const candidate of [`${tableName}_NO`, tableName]) {
      if (has(candidate)) return candidate
    }
  }
  for (const k of Object.keys(fields)) {
    if (/_NO$/i.test(k) && !NOISE_NO_FIELDS.test(k) && has(k)) return k
  }
  for (const candidate of ['NAME', 'NO', 'CODE', 'ID']) {
    if (has(candidate)) return candidate
  }
  return fields['SID'] ? 'SID' : ''
}

/**
 * 识别对象描述字段：优先表名推断（`LOGIC_DESC`），
 * 否则取首个 `*_DESC`（覆盖 QUEUQ_DESC 这类拼写变体）。
 */
export function pickDescKey(fields: XmlRecordFields, tableName = ''): string {
  const has = (k: string) => fields[k] && fields[k].trim()
  if (tableName && has(`${tableName}_DESC`)) return `${tableName}_DESC`
  for (const k of Object.keys(fields)) {
    if (/_DESC$/i.test(k) && has(k)) return k
  }
  for (const candidate of ['DESCRIPTION', 'REMARK', 'DESC']) {
    if (has(candidate)) return candidate
  }
  return ''
}

/** 把一条记录渲染成 DocPage：对象名与描述在前，其余字段按原顺序，空值字段跳过 */
export function recordToPage(
  fields: XmlRecordFields,
  pageNum: number,
  objectKey: string,
  descKey: string
): { page: DocPage; objectName: string; objectDesc: string; text: string } {
  const objectName = (objectKey && fields[objectKey] ? fields[objectKey] : '').trim()
  const objectDesc = (descKey && fields[descKey] ? fields[descKey] : '').trim()
  const title = objectDesc ? `${objectName} · ${objectDesc}` : objectName || `记录 ${pageNum}`

  const paragraphs: string[] = []
  if (objectName) paragraphs.push(`${objectKey || '对象编号'}: ${objectName}`)
  if (objectDesc && descKey) paragraphs.push(`${descKey}: ${objectDesc}`)
  for (const key of Object.keys(fields)) {
    if (key === objectKey || key === descKey) continue
    const v = fields[key]
    if (!v || !v.trim()) continue // 空字段不入页，避免噪音膨胀
    paragraphs.push(`${key}: ${v}`)
  }

  const text = `【${title}】\n${paragraphs.join('\n')}`
  return { page: { pageNum, title, paragraphs }, objectName, objectDesc, text }
}

export interface ParseXmlOptions {
  /** 进度回调（0~1） */
  onProgress?: (ratio: number) => void
  /** 块大小，默认 4MB */
  chunkSize?: number
}

/**
 * 解析 XML 文件（分块流式）。
 * @param file 浏览器 File 对象（不整体读入内存）
 */
export async function parseXmlFile(file: File, options: ParseXmlOptions = {}): Promise<XmlParseResult> {
  const { onProgress, chunkSize = CHUNK_SIZE } = options
  const decoder = new TextDecoder('utf-8')

  const pages: DocPage[] = []
  const fieldNames: string[] = []
  const seenField = new Set<string>()
  let rootTag = ''
  let tableName = ''
  let objectKey = ''
  let descKey = ''
  let buf = ''
  let pageNum = 0
  let headCaptured = false
  const textParts: string[] = []

  const handleRecord = (raw: string) => {
    const fields = parseRecordFields(raw)
    if (Object.keys(fields).length === 0) return
    if (!objectKey) objectKey = pickObjectKey(fields, tableName)
    if (!descKey) descKey = pickDescKey(fields, tableName)
    for (const k of Object.keys(fields)) {
      if (!seenField.has(k)) {
        seenField.add(k)
        fieldNames.push(k)
      }
    }
    pageNum += 1
    const { page, text } = recordToPage(fields, pageNum, objectKey, descKey)
    pages.push(page)
    textParts.push(text)
  }

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, file.size)
    const arr = await file.slice(offset, end).arrayBuffer()
    buf += decoder.decode(arr, { stream: end < file.size })

    // 首块里取根元素名（形如 <SELECT_FROM_Z_LOGIC_...>）
    if (!headCaptured) {
      const m = /<([A-Za-z_][A-Za-z0-9_]*)>/.exec(buf)
      if (m && m[1] !== 'DATA_RECORD') rootTag = m[1]
      tableName = tableNameFromRoot(rootTag)
      headCaptured = true
    }

    // 逐条取出完整记录
    for (;;) {
      const s = buf.indexOf(OPEN_TAG)
      if (s === -1) {
        // 本块内没有记录起点：整段无用，清空以省内存
        buf = ''
        break
      }
      const e = buf.indexOf(CLOSE_TAG, s + OPEN_TAG.length)
      if (e === -1) {
        // 记录未在本块内闭合：丢弃起点之前的内容，保留未闭合部分等下一块
        if (s > 0) buf = buf.slice(s)
        break
      }
      const raw = buf.slice(s + OPEN_TAG.length, e)
      buf = buf.slice(e + CLOSE_TAG.length)
      handleRecord(raw)
    }

    onProgress?.(file.size ? Math.min(1, end / file.size) : 1)
  }
  buf += decoder.decode()

  return {
    text: textParts.join('\n\n'),
    pages,
    rootTag,
    recordCount: pageNum,
    objectKey,
    descKey,
    fieldNames,
  }
}

/**
 * 解析 XML 文本（Node 测试 / 小样本用）。
 * 与 parseXmlFile 逻辑一致，输入为完整字符串。
 */
export function parseXmlText(content: string): XmlParseResult {
  const pages: DocPage[] = []
  const fieldNames: string[] = []
  const seenField = new Set<string>()
  let rootTag = ''
  let objectKey = ''
  let descKey = ''
  let pageNum = 0

  const m = /<([A-Za-z_][A-Za-z0-9_]*)>/.exec(content)
  if (m && m[1] !== 'DATA_RECORD') rootTag = m[1]
  const tableName = tableNameFromRoot(rootTag)

  let pos = 0
  const textParts: string[] = []
  for (;;) {
    const s = content.indexOf(OPEN_TAG, pos)
    if (s === -1) break
    const e = content.indexOf(CLOSE_TAG, s + OPEN_TAG.length)
    if (e === -1) break
    const fields = parseRecordFields(content.slice(s + OPEN_TAG.length, e))
    pos = e + CLOSE_TAG.length
    if (Object.keys(fields).length === 0) continue
    if (!objectKey) objectKey = pickObjectKey(fields, tableName)
    if (!descKey) descKey = pickDescKey(fields, tableName)
    for (const k of Object.keys(fields)) {
      if (!seenField.has(k)) {
        seenField.add(k)
        fieldNames.push(k)
      }
    }
    pageNum += 1
    const { page, text } = recordToPage(fields, pageNum, objectKey, descKey)
    pages.push(page)
    textParts.push(text)
  }

  return { text: textParts.join('\n\n'), pages, rootTag, recordCount: pageNum, objectKey, descKey, fieldNames }
}
