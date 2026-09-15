import { describe, it, expect } from 'vitest'
import { extractMesSql, trimAfterMesSqlBlock, extractMesSource } from './mesQuery'

/** 拼一个「前置说明 + mes-sql 代码块」的回答 */
const answer = (block: string) => `好的，我来查一下。\n来源：Z_LOGIC_202609101240.xml\n\`\`\`mes-sql\n${block}\n\`\`\`\n`

describe('extractMesSql', () => {
  it('提取第一个 mes-sql 代码块里的 SQL', () => {
    expect(extractMesSql(answer(`SELECT A, B FROM T WHERE SN = 'X1' LIMIT 10`)))
      .toBe(`SELECT A, B FROM T WHERE SN = 'X1' LIMIT 10`)
  })

  it('代码块内先写了「来源：xxx」说明行时，从 SQL 起始行截取（否则会被只读护栏整条拒绝）', () => {
    const sql = extractMesSql(answer([
      '来源：Z_LOGIC_202609101240.xml - query.ce2.rp.item.jingyeliangbuliangfenxi1',
      'SELECT SN, JINGYELIANG',
      'FROM Z_OP08_SFC_PARAM',
      `WHERE SN = 'X1'`,
    ].join('\n')))
    expect(sql).toBe(`SELECT SN, JINGYELIANG\nFROM Z_OP08_SFC_PARAM\nWHERE SN = 'X1'`)
    // 交给护栏前必须是以 SELECT / WITH 开头，否则必然 400
    expect(sql && /^(select|with)\b/i.test(sql)).toBe(true)
  })

  it('SQL 以 WITH 开头时原样保留', () => {
    expect(extractMesSql(answer('WITH T AS (SELECT 1 AS A FROM DUMMY)\nSELECT A FROM T')))
      .toMatch(/^WITH T AS/)
  })

  it('块内没有可识别的 SQL 起始行时原样返回，交由护栏给出明确报错', () => {
    expect(extractMesSql(answer('这段不是 SQL，只是说明'))).toBe('这段不是 SQL，只是说明')
  })

  it('没有代码块 / 空代码块时返回 null', () => {
    expect(extractMesSql('这个问题无需查库，直接给分析建议。')).toBeNull()
    expect(extractMesSql('```mes-sql\n\n```')).toBeNull()
  })
})

describe('trimAfterMesSqlBlock', () => {
  it('截掉代码块之后的输出（模型复述或编造的查询结果）', () => {
    const text = '查找一下。\n```mes-sql\nSELECT 1 FROM DUMMY\n```\n\n## 查询结果\n| A |\n|---|\n| 1 |'
    expect(trimAfterMesSqlBlock(text)).toBe('查找一下。\n```mes-sql\nSELECT 1 FROM DUMMY\n```')
  })

  it('没有代码块时原样返回', () => {
    expect(trimAfterMesSqlBlock('只有正文')).toBe('只有正文')
  })

  it('代码块未闭合时截到代码块之前', () => {
    expect(trimAfterMesSqlBlock('前言\n```mes-sql\nSELECT 1')).toBe('前言\n')
  })
})

describe('extractMesSource', () => {
  it('从代码块之外的正文里取出来源标注', () => {
    const text = answer('SELECT 1 FROM DUMMY')
    const outside = text.replace(/```mes-sql[\s\S]*?```/, '')
    expect(extractMesSource(outside)).toBe('Z_LOGIC_202609101240.xml')
  })

  it('没有来源标注时返回 null', () => {
    expect(extractMesSource('直接给出 SQL，未标注来源')).toBeNull()
  })
})
