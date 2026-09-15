// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  compileParamSpec, specFieldIsExpr, specReferencedColumns,
  resolveCompiledSpec, resolveParamSpec, evaluatePoints,
  optimizeParam, buildTemplateVars,
} from './apcService.js'

// ===== 规格表达式（取数结果列名变量）=====
// 背景：现场型号多、交错生产，规格不固定。把规格放到取数 SQL 的结果列里随行取回、
// 用「列名 ± 数字」这类表达式微调，才不用逐型号维护一份数字配置。

const P = {
  code: 'K',
  name: '测试参数',
  process: '测试',
  unit: 'U',
  decimals: 2,
  setpoint: 10,
  optimalTarget: 10,
  lsl: 9,
  usl: 11,
  min: 5,
  max: 15,
  maxStepPct: 5,
  deadbandPct: 10,
  objective: 'quality',
  processGain: 1,
}

/** 6 个规格字段全部写成列名表达式的参数 */
const PX = {
  ...P,
  setpoint: 'SP_COL',
  optimalTarget: 'SP_COL',
  lsl: 'LSL_COL',
  usl: 'USL_COL - 1',
  min: 'MIN_COL',
  max: 'MAX_COL',
}

const ROW = { SP_COL: 10, LSL_COL: 9, USL_COL: 11, MIN_COL: 5, MAX_COL: 15 }

function pt(i, v, rawRow) {
  return { t: 1_700_000_000_000 + i * 1000, v, rawRow }
}

function steady(base, n = 40, rawRow) {
  return Array.from({ length: n }, (_, i) => pt(i, base + (i % 3) * 0.005, rawRow))
}

describe('apcService · 规格表达式编译', () => {
  it('数字字段直接留用，表达式字段解析成 AST', () => {
    const c = compileParamSpec(PX)
    expect(c.fields.setpoint.kind).toBe('expr')
    expect(c.fields.setpoint.idents).toEqual(['SP_COL'])
    expect(c.fields.usl.kind).toBe('expr')
    expect(c.fields.usl.idents).toEqual(['USL_COL'])
    expect(c.expressions.usl).toBe('USL_COL - 1')
    expect(c.errors).toEqual([])
  })

  it('纯数字参数全部为 num，无表达式', () => {
    const c = compileParamSpec(P)
    expect(c.fields.lsl).toEqual({ kind: 'num', value: 9 })
    expect(c.expressions).toEqual({})
    expect(specReferencedColumns(c)).toEqual([])
  })

  it('不含列名的表达式（如 (24+26)/2）在编译期就能定值', () => {
    const c = compileParamSpec({ ...P, usl: '(24 + 26) / 2' })
    expect(c.fields.usl).toEqual({ kind: 'num', value: 25 })
    expect(c.expressions).toEqual({})
  })

  it('语法错误的表达式被记录，不抛异常', () => {
    const c = compileParamSpec({ ...P, usl: 'ABS(1)' })
    expect(c.fields.usl.kind).toBe('invalid')
    expect(c.errors.join()).toContain('usl')
  })

  it('specFieldIsExpr 只对表达式字段为真', () => {
    const c = compileParamSpec(PX)
    expect(specFieldIsExpr(c, 'usl')).toBe(true)
    expect(specFieldIsExpr(c, 'lsl')).toBe(true)
    const c2 = compileParamSpec(P)
    expect(specFieldIsExpr(c2, 'usl')).toBe(false)
  })

  it('specReferencedColumns 聚合去重（按字段顺序）', () => {
    expect(specReferencedColumns(compileParamSpec(PX))).toEqual([
      'SP_COL', 'LSL_COL', 'USL_COL', 'MIN_COL', 'MAX_COL',
    ])
  })
})

describe('apcService · 规格按行求值', () => {
  it('按数据行求出全部 6 项数值', () => {
    const r = resolveParamSpec(PX, ROW)
    expect(r.ok).toBe(true)
    expect(r.spec).toEqual({ setpoint: 10, optimalTarget: 10, lsl: 9, usl: 10, min: 5, max: 15 }) // USL_COL - 1 = 10
  })

  it('表达式引用 USL_COL - 1（用户提的典型用法）', () => {
    const r = resolveCompiledSpec(compileParamSpec({ ...P, usl: 'USL_COL - 1' }), { USL_COL: 26 })
    expect(r.ok).toBe(true)
    expect(r.spec.usl).toBe(25)
  })

  it('列名大小写不敏感（HANA 默认返回大写列名）', () => {
    const r = resolveCompiledSpec(compileParamSpec({ ...P, usl: 'usl_col - 1' }), { USL_COL: 26 })
    expect(r.ok).toBe(true)
    expect(r.spec.usl).toBe(25)
  })

  it('引用的列不在数据行里 → ok=false 且错误里带列名（不是静默 NaN）', () => {
    const r = resolveCompiledSpec(compileParamSpec(PX), { SP_COL: 10, MIN_COL: 5, MAX_COL: 15 })
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toContain('LSL_COL')
  })

  it('没有数据行时明确报「没有可用的数据行」', () => {
    const r = resolveCompiledSpec(compileParamSpec(PX), undefined)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toContain('没有可用的数据行')
  })

  it('列值为 null 视为无值（不被 Number(null)=0 静默吞掉）', () => {
    const r = resolveCompiledSpec(compileParamSpec({ ...P, usl: 'USL_COL + 1' }), { USL_COL: null })
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toContain('没有值')
  })
})

describe('apcService · 点级超规格判定', () => {
  it('计数基于全量点，不因降采样失真', () => {
    const pts = Array.from({ length: 300 }, (_, i) => pt(i, 10))
    pts[5].v = 12
    pts[100].v = 12.5
    pts[250].v = 8.5
    const dev = evaluatePoints(compileParamSpec(P), pts)
    expect(dev.n).toBe(300)
    expect(dev.outOfSpec).toBe(3)
    expect(dev.outHigh).toBe(2)
    expect(dev.outLow).toBe(1)
    expect(dev.worst.v).toBe(12.5)
    expect(dev.worst.direction).toBe('high')
  })

  it('optimizeParam 的偏离摘要同样不受曲线降采样影响', () => {
    const pts = Array.from({ length: 300 }, (_, i) => pt(i, 10))
    pts[7].v = 13
    const r = optimizeParam(P, pts, { sparkPoints: 60 })
    expect(r.series.length).toBeLessThanOrEqual(61)
    expect(r.pointDeviation.outOfSpec).toBe(1)
    expect(r.pointDeviation.worst.v).toBe(13)
  })

  it('随行变化的规格按各自数据行判定', () => {
    // 前 20 行规格窄 [9,11]，后 20 行规格宽 [9,15]；v=13 只应在前段算超限
    const pts = Array.from({ length: 40 }, (_, i) =>
      pt(i, 13, { SP_COL: 10, LSL_COL: 9, USL_COL: i < 20 ? 11 : 15, MIN_COL: 5, MAX_COL: 25 }))
    const dev = evaluatePoints(compileParamSpec({ ...PX, usl: 'USL_COL' }), pts)
    expect(dev.outOfSpec).toBe(20)
    expect(dev.outHigh).toBe(20)
  })

  it('规格确定不了时方向为 unknown，不误判为合格', () => {
    const dev = evaluatePoints(compileParamSpec(PX), [pt(0, 10, { SP_COL: 10 })])
    expect(dev.outOfSpec).toBe(0)
    expect(dev.points[0].direction).toBe('unknown')
  })
})

describe('apcService · optimizeParam 集成表达式规格', () => {
  it('表达式规格解析成数值后再做判定', () => {
    const r = optimizeParam(PX, steady(9.5, 40, ROW))
    expect(r.specResolved.ok).toBe(true)
    expect(r.specResolved.expressions.usl).toBe('USL_COL - 1')
    expect(r.lsl).toBe(9)
    expect(r.usl).toBe(10) // USL_COL(11) - 1
    expect(r.setpoint).toBe(10)
    expect(r.status).not.toBe('unknown')
  })

  it('窗口级规格取**最新一行**', () => {
    const pts = Array.from({ length: 40 }, (_, i) =>
      pt(i, 10, { SP_COL: 10, LSL_COL: 9, USL_COL: i < 20 ? 11 : 20, MIN_COL: 5, MAX_COL: 25 }))
    const r = optimizeParam({ ...PX, usl: 'USL_COL' }, pts)
    expect(r.usl).toBe(20)
  })

  it('规格取不到时降级为 unknown + 保持，并说清原因（绝不硬算「正常」）', () => {
    const r = optimizeParam(PX, steady(10, 40, { SP_COL: 10 }))
    expect(r.status).toBe('unknown')
    expect(r.recommendation.hold).toBe(true)
    expect(r.recommendation.confidence).toBe(0)
    expect(r.pointDeviation.outOfSpec).toBe(0)
    expect(r.recommendation.reason).toContain('LSL_COL')
    expect(r.lsl).toBe(null)
  })

  it('表达式规格 → 曲线点带逐点 lsl/usl（阶梯规格带）', () => {
    const pts = Array.from({ length: 40 }, (_, i) =>
      pt(i, 10, { SP_COL: 10, LSL_COL: 9, USL_COL: i < 20 ? 11 : 20, MIN_COL: 5, MAX_COL: 25 }))
    const r = optimizeParam({ ...PX, usl: 'USL_COL' }, pts, { sparkPoints: 60 })
    expect(r.series.some(p => p.usl === 11)).toBe(true)
    expect(r.series.some(p => p.usl === 20)).toBe(true)
  })

  it('固定数字规格 → 曲线点不重复下发 lsl/usl（省流量）', () => {
    const r = optimizeParam(P, steady(10, 40).map(p => ({ t: p.t, v: p.v })), { sparkPoints: 60 })
    expect(r.series.every(p => p.usl === undefined && p.lsl === undefined)).toBe(true)
    expect(r.usl).toBe(11)
  })

  it('超限点会被标出方向，便于前端高亮', () => {
    // 基线 9.5 稳稳落在 [LSL_COL=9, USL_COL-1=10] 内，只让第 4 个点爆表
    const pts = steady(9.5, 40, ROW)
    pts[3].v = 99
    const r = optimizeParam(PX, pts, { sparkPoints: 60 })
    expect(r.pointDeviation.outHigh).toBe(1)
    expect(r.series.some(p => p.direction === 'high')).toBe(true)
  })

  it('rawRow 不会随接口数据泄漏（不可枚举）', () => {
    const r = optimizeParam(PX, steady(10, 40, ROW), { sparkPoints: 60 })
    expect(JSON.stringify(r.series)).not.toContain('SP_COL')
    expect(JSON.stringify(r)).not.toContain('LSL_COL":9')
  })
})

describe('apcService · 宽表自动并入规格表达式引用的列', () => {
  const wideCatalog = (params) => ({
    schema: '',
    queries: { mode: 'wide', history: 'SELECT {{columns}} FROM T', columns: { ts: 'A008' } },
    params,
  })

  it('表达式引用的列被自动加入 {{columns}}', () => {
    const vars = buildTemplateVars(
      wideCatalog([{ code: 'JYL', column: 'A004', lsl: 'LSL_C', usl: 'USL_C - 1' }]),
      { minutes: 120, limit: 2000, codes: ['JYL'] }
    )
    const list = vars.columns.split(',').map((s) => s.trim())
    expect(list[0]).toBe('"A008"')
    expect(list).toContain('"A004"')
    expect(list).toContain('"LSL_C"')
    expect(list).toContain('"USL_C"')
  })

  it('与参数列 / 时间列同名时不重复展开', () => {
    const vars = buildTemplateVars(
      wideCatalog([{ code: 'K', column: 'A004', usl: 'A004', lsl: 'A008' }]),
      { minutes: 60, limit: 100, codes: ['K'] }
    )
    const list = vars.columns.split(',').map((s) => s.trim())
    expect(list).toEqual(['"A008"', '"A004"'])
  })

  it('未选中的参数不参与并入（按 codes 过滤）', () => {
    const vars = buildTemplateVars(
      wideCatalog([
        { code: 'K1', column: 'A004', usl: 'USL_1' },
        { code: 'K2', column: 'A005', usl: 'USL_2' },
      ]),
      { minutes: 60, limit: 100, codes: ['K1'] }
    )
    expect(vars.columns).toContain('"USL_1"')
    expect(vars.columns).not.toContain('"USL_2"')
  })

  it('窄表模式不并入（模板需自行写出列，只给编码过滤片段）', () => {
    const vars = buildTemplateVars(
      {
        schema: '',
        queries: { mode: 'long', history: 'SELECT * FROM T WHERE 1=1 {{codeFilter}}', columns: { code: 'C', ts: 'TS', value: 'V' } },
        params: [{ code: 'K1', usl: 'USL_C' }],
      },
      { minutes: 60, limit: 100, codes: ['K1'] }
    )
    expect(vars.columns).toBe('')
    expect(vars.codeFilter).toContain('K1')
  })

  it('固定数字规格不影响 {{columns}}（回归）', () => {
    const vars = buildTemplateVars(
      wideCatalog([{ code: 'JYL', column: 'A004', usl: 25.5 }]),
      { minutes: 120, limit: 2000, codes: ['JYL'] }
    )
    expect(vars.columns).toBe('"A008", "A004"')
  })
})
