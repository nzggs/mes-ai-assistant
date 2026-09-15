// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  parseExpr, evalExpr, exprIdentifiers, exprDepth,
  isPlainNumber, toPlainNumber,
  SPEC_EXPR_MAX_LEN, SPEC_EXPR_MAX_IDENTS, SPEC_EXPR_MAX_IDENT_LEN, SPEC_EXPR_MAX_DEPTH,
} from './specExpr.js'

const evalSrc = (src, row = {}) =>
  evalExpr(parseExpr(src).ast, (name) => {
    const target = String(name).toUpperCase()
    for (const k of Object.keys(row)) if (k.toUpperCase() === target) return row[k]
    return undefined
  })

describe('specExpr · 解析合法表达式', () => {
  it('纯数字字面量', () => {
    const r = parseExpr('25')
    expect(r.ok).toBe(true)
    expect(r.idents).toEqual([])
    expect(evalExpr(r.ast, () => undefined).value).toBe(25)
  })

  it('小数与 .5 写法', () => {
    expect(evalExpr(parseExpr('24.5').ast, () => undefined).value).toBe(24.5)
    expect(evalExpr(parseExpr('.5').ast, () => undefined).value).toBe(0.5)
  })

  it('科学计数法', () => {
    expect(evalExpr(parseExpr('1.5e-3').ast, () => undefined).value).toBeCloseTo(0.0015, 10)
  })

  it('单个列名', () => {
    const r = parseExpr('USL_COL')
    expect(r.ok).toBe(true)
    expect(r.idents).toEqual(['USL_COL'])
  })

  it('列名 - 1（用户提的典型用法）', () => {
    expect(evalSrc('USL_COL - 1', { USL_COL: 26 }).value).toBe(25)
  })

  it('四则运算与优先级：2 + 3 * 4 = 14', () => {
    expect(evalSrc('2 + 3 * 4').value).toBe(14)
  })

  it('括号改变优先级：(2 + 3) * 4 = 20', () => {
    expect(evalSrc('(2 + 3) * 4').value).toBe(20)
  })

  it('(LSL + USL) / 2 取中值', () => {
    expect(evalSrc('(LSL_C + USL_C) / 2', { LSL_C: 24, USL_C: 26 }).value).toBe(25)
  })

  it('一元正负：-5 与 -(-5)', () => {
    expect(evalSrc('-5').value).toBe(-5)
    expect(evalSrc('-(-5)').value).toBe(5)
  })

  it('一元符号叠加：--1 = 1，+-1 = -1', () => {
    expect(evalSrc('--1').value).toBe(1)
    expect(evalSrc('+-1').value).toBe(-1)
  })

  it('结果可为负（规格允许负值）', () => {
    expect(evalSrc('A - 10', { A: 3 }).value).toBe(-7)
  })

  it('大小写不敏感的列名解析（resolve 自己负责匹配）', () => {
    expect(evalSrc('usl_col - 1', { USL_COL: 26 }).value).toBe(25)
  })
})

describe('specExpr · 拒绝一切非四则运算的写法', () => {
  const bad = [
    ['函数调用', 'ABS(1)'],
    ['函数调用（带列名）', 'ROUND(A, 2)'],
    ['属性访问', 'A.B'],
    ['原型链尝试', 'A.__proto__'],
    ['constructor 调用', 'constructor(1)'],
    ['逗号', 'A, B'],
    ['分号', 'A; B'],
    ['多语句注入', '1; DROP TABLE T'],
    ['字符串字面量（单引号）', "'abc'"],
    ['字符串字面量（双引号）', '"abc"'],
    ['模板字符串', '`abc`'],
    ['赋值', 'A = 1'],
    ['下标/数组', 'A[0]'],
    ['花括号', '{1}'],
    ['幂运算 ^', '2 ^ 3'],
    ['取模 %', '2 % 3'],
    ['比较运算 >', 'A > 1'],
    ['逻辑与 &', 'A & 1'],
    ['三元 ?', 'A ? 1 : 2'],
    ['十六进制', '0x10'],
    ['多余内容（两个操作数相邻）', '1 2'],
    ['多余内容（列名相邻）', 'A B'],
    ['括号未闭合', '(1 + 2'],
    ['右括号多余', '1 + 2)'],
    ['表达式不完整', '1 +'],
    ['只有运算符', '*'],
    ['空表达式', '   '],
    ['require 注入', "require('fs')"],
    ['process 访问', 'process.exit(1)'],
  ]
  for (const [label, src] of bad) {
    it(`拒绝：${label}（${src}）`, () => {
      const r = parseExpr(src)
      expect(r.ok).toBe(false)
      expect(typeof r.error).toBe('string')
      expect(r.error.length).toBeGreaterThan(0)
    })
  }

  it('拒绝结果非有限（除零），但不抛异常', () => {
    const parsed = parseExpr('1 / 0')
    expect(parsed.ok).toBe(true)
    const ev = evalExpr(parsed.ast, () => undefined)
    expect(ev.ok).toBe(false)
    expect(ev.error).toContain('除以 0')
  })
})

describe('specExpr · 上限', () => {
  it(`源码超过 ${SPEC_EXPR_MAX_LEN} 字符被拒`, () => {
    const r = parseExpr('1'.repeat(SPEC_EXPR_MAX_LEN + 1))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('过长')
  })

  it(`引用列名超过 ${SPEC_EXPR_MAX_IDENTS} 个被拒`, () => {
    const src = Array.from({ length: SPEC_EXPR_MAX_IDENTS + 1 }, (_, i) => `COL_${i}`).join(' + ')
    const r = parseExpr(src)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('过多')
  })

  it(`单个列名超过 ${SPEC_EXPR_MAX_IDENT_LEN} 字符被拒`, () => {
    const r = parseExpr('A'.repeat(SPEC_EXPR_MAX_IDENT_LEN + 1))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('过长')
  })

  it(`嵌套深度超过 ${SPEC_EXPR_MAX_DEPTH} 层被拒（长链加法）`, () => {
    const src = Array.from({ length: SPEC_EXPR_MAX_DEPTH + 8 }, () => '1').join(' + ')
    const r = parseExpr(src)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('嵌套过深')
  })

  it('恰好 32 层嵌套的括号可以被接受', () => {
    const depth = 30
    const src = '('.repeat(depth) + '1' + ')'.repeat(depth)
    const r = parseExpr(src)
    expect(r.ok).toBe(true)
    expect(exprDepth(r.ast)).toBeLessThanOrEqual(SPEC_EXPR_MAX_DEPTH)
  })
})

describe('specExpr · 求值失败可诊断', () => {
  it('列名在当前行不存在 → 明确报出列名', () => {
    const ev = evalSrc('MISSING_COL + 1', { A: 1 })
    expect(ev.ok).toBe(false)
    expect(ev.error).toContain('MISSING_COL')
  })

  it('列值为 null → 视为无值', () => {
    const ev = evalSrc('A + 1', { A: null })
    expect(ev.ok).toBe(false)
    expect(ev.error).toContain('没有值')
  })

  it('列值不是数字 → 明确报出', () => {
    const ev = evalSrc('A + 1', { A: 'abc' })
    expect(ev.ok).toBe(false)
    expect(ev.error).toContain('不是有效数字')
  })

  it('列值是数字字符串 → 可参与运算', () => {
    expect(evalSrc('A - 1', { A: '26' }).value).toBe(25)
  })
})

describe('specExpr · exprIdentifiers / exprDepth', () => {
  it('列名去重且保留出现顺序', () => {
    const r = parseExpr('B + A * B - (A + C)')
    expect(exprIdentifiers(r.ast)).toEqual(['B', 'A', 'C'])
  })

  it('纯数字表达式没有列名', () => {
    expect(exprIdentifiers(parseExpr('(1 + 2) * 3').ast)).toEqual([])
  })

  it('exprDepth：字面量为 1，一元与二元逐层加一', () => {
    expect(exprDepth(parseExpr('1').ast)).toBe(1)
    expect(exprDepth(parseExpr('A').ast)).toBe(1)
    expect(exprDepth(parseExpr('-A').ast)).toBe(2)
    expect(exprDepth(parseExpr('A + B').ast)).toBe(2)
    expect(exprDepth(parseExpr('A + B * C').ast)).toBe(3)
  })
})

describe('specExpr · isPlainNumber / toPlainNumber', () => {
  it('识别纯数字（数字与数字字符串）', () => {
    expect(isPlainNumber(25)).toBe(true)
    expect(isPlainNumber('25')).toBe(true)
    expect(isPlainNumber(' 24.5 ')).toBe(true)
    expect(isPlainNumber('-3')).toBe(true)
    expect(isPlainNumber('1e3')).toBe(true)
  })

  it('非纯数字一律为 false（表达式、空值、非数字）', () => {
    expect(isPlainNumber('USL - 1')).toBe(false)
    expect(isPlainNumber('')).toBe(false)
    expect(isPlainNumber(null)).toBe(false)
    expect(isPlainNumber(undefined)).toBe(false)
    expect(isPlainNumber(NaN)).toBe(false)
    expect(isPlainNumber(Infinity)).toBe(false)
    expect(isPlainNumber('abc')).toBe(false)
    expect(isPlainNumber({})).toBe(false)
  })

  it('toPlainNumber 返回数值或 null', () => {
    expect(toPlainNumber('25')).toBe(25)
    expect(toPlainNumber('USL - 1')).toBe(null)
  })
})
