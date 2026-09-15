// 纯文本家族（.txt / .md / .csv）解析：编码自适应解码 + 分页切分。
// 现场导出的文本常见 UTF-8 / UTF-8 BOM / UTF-16 / GBK 四种编码，
// 其中 GBK 若被按 UTF-8 硬解会整篇乱码并污染检索与总结，故此处逐编码锁定行为。
// .md / .csv 与 .txt 共用同一条链路，因此解码用例对三者同样成立，另补 md/csv 的分页特性。
import { describe, it, expect } from 'vitest'
import { decodePlainText, splitPlainTextPages, isPlainTextType, PLAIN_TEXT_TYPES } from './knowledgeService'

/** UTF-8 字节 */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** GBK 字节（手工构造，TextEncoder 只支持 UTF-8；'中文' = D6D0 CEC4） */
const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])

describe('isPlainTextType', () => {
  it('txt / md / csv 属于纯文本家族', () => {
    expect(PLAIN_TEXT_TYPES).toEqual(['txt', 'md', 'csv'])
    for (const t of PLAIN_TEXT_TYPES) expect(isPlainTextType(t)).toBe(true)
  })

  it('二进制与结构化格式不属于纯文本家族', () => {
    for (const t of ['word', 'ppt', 'excel', 'pdf', 'xml']) expect(isPlainTextType(t)).toBe(false)
  })

  it('空值不会误判', () => {
    expect(isPlainTextType(undefined)).toBe(false)
    expect(isPlainTextType('')).toBe(false)
  })
})

describe('decodePlainText', () => {
  it('UTF-8（无 BOM）中文正常解码', () => {
    expect(decodePlainText(utf8('注液量 3.2g'))).toBe('注液量 3.2g')
  })

  it('UTF-8 BOM 被剥离，不残留 \\uFEFF', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('化成工艺')])
    const text = decodePlainText(bytes)
    expect(text).toBe('化成工艺')
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('UTF-16LE BOM 被识别并按 UTF-16 解码', () => {
    // '中' = U+4E2D → LE 字节 2D 4E；'文' = U+6587 → 87 65
    const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])
    expect(decodePlainText(bytes)).toBe('中文')
  })

  it('非法 UTF-8 字节回退 GBK 解码（不乱码）', () => {
    expect(decodePlainText(GBK_ZHONGWEN)).toBe('中文')
  })

  it('GBK 与 UTF-8 混排时的中文行同样可读', () => {
    const bytes = new Uint8Array([...GBK_ZHONGWEN, ...utf8('：3.2g')])
    expect(decodePlainText(bytes)).toContain('中文')
  })

  it('GBK 编码的 CSV 表头行可正常解码（csv 走同一链路的原因）', () => {
    const bytes = new Uint8Array([...GBK_ZHONGWEN, ...utf8(',3.2g,12h')])
    expect(decodePlainText(bytes)).toBe('中文,3.2g,12h')
  })

  it('空字节返回空串', () => {
    expect(decodePlainText(new Uint8Array([]))).toBe('')
  })
})

describe('splitPlainTextPages', () => {
  it('短文只产出 1 页，标题为「文件名 - 第1段」', () => {
    const pages = splitPlainTextPages('说明.txt', '第一行\n第二行')
    expect(pages).toHaveLength(1)
    expect(pages[0].pageNum).toBe(1)
    expect(pages[0].title).toBe('说明.txt - 第1段')
    expect(pages[0].paragraphs[0]).toBe('第一行\n第二行')
  })

  it('长文按行边界切成多页，每页不超过阈值，且内容不丢行', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `第${i + 1}行：注液量 3.2g，静置 12h`)
    const pages = splitPlainTextPages('工艺.txt', lines.join('\n'), 500)
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages) {
      expect(p.paragraphs[0].length).toBeLessThanOrEqual(500)
    }
    // 拼接后所有原始行都在（顺序保持、无丢行、无重复）
    const merged = pages.map(p => p.paragraphs[0]).join('\n')
    for (const line of lines) expect(merged).toContain(line)
    expect(pages.map(p => p.pageNum)).toEqual(pages.map((_, i) => i + 1))
  })

  it('超长单行按字符硬切，不会整篇只剩一页', () => {
    const one = 'x'.repeat(2500)
    const pages = splitPlainTextPages('长行.txt', one, 1000)
    expect(pages).toHaveLength(3)
    expect(pages.map(p => p.paragraphs[0].length)).toEqual([1000, 1000, 500])
    expect(pages.map(p => p.paragraphs[0]).join('')).toBe(one)
  })

  it('CRLF / CR 换行统一归一为 LF，不残留 \\r', () => {
    const pages = splitPlainTextPages('win.txt', 'a\r\nb\rc')
    expect(pages).toHaveLength(1)
    expect(pages[0].paragraphs[0]).toBe('a\nb\nc')
    expect(pages[0].paragraphs[0]).not.toContain('\r')
  })

  it('全文空白（空文件/仅空行）产出 0 页，由调用方报「内容为空」', () => {
    expect(splitPlainTextPages('空.txt', '   \n\n\t\n')).toHaveLength(0)
    expect(splitPlainTextPages('空.txt', '')).toHaveLength(0)
  })

  it('自然段边界优先收口：攒够半页后的空行处断页', () => {
    const block = 'A'.repeat(300) // 半页 = 250
    const text = `${block}\n\n${block}`
    const pages = splitPlainTextPages('段.txt', text, 500)
    expect(pages).toHaveLength(2)
    expect(pages[0].paragraphs[0]).toBe(block)
    expect(pages[1].paragraphs[0]).toBe(block)
  })

  it('Markdown 原文逐字保留（不解析、不剥离标记）', () => {
    const md = ['# 注液工艺', '', '- 注液量 3.2g', '- 静置 12h', '', '| 参数 | 值 |', '| --- | --- |'].join('\n')
    const pages = splitPlainTextPages('工艺说明.md', md)
    expect(pages).toHaveLength(1)
    expect(pages[0].title).toBe('工艺说明.md - 第1段')
    expect(pages[0].paragraphs[0]).toBe(md)
  })

  it('CSV 按行分页：不把一行（一条记录）从中间劈开', () => {
    const rows = ['泵号,注液量,静置时长', ...Array.from({ length: 80 }, (_, i) => `P${i + 1},3.${i % 10}g,12h`)]
    const pages = splitPlainTextPages('导出.csv', rows.join('\n'), 120)
    expect(pages.length).toBeGreaterThan(1)
    const allLines = pages.flatMap(p => p.paragraphs[0].split('\n'))
    // 行数与顺序完整保留，且每行都是完整的整行（没有半行残片）
    expect(allLines).toEqual(rows)
    expect(allLines.every(l => rows.includes(l))).toBe(true)
    expect(pages.map(p => p.title)).toEqual(pages.map((_, i) => `导出.csv - 第${i + 1}段`))
  })
})
