// @vitest-environment node
//
// 多对 1 调优求解器的测试。
// 最重要的两条：
//   ① N = 1 时必须**逐字退化**为改造前的单回路公式 —— 这是老项目迁移后行为不变的依据；
//   ② 任何边界（k 全 0 / 规格求不出 / 参数全被顶死）都必须给出明确降级，**绝不返回 NaN**。
import { describe, it, expect } from 'vitest'
import { optimizeParam, optimizeItem } from './apcService.js'

/** 稳态数据点：n 个完全相同的值（σ = 0，状态判定为 normal） */
const steady = (v, n = 40, rawRow) => Array.from({ length: n }, (_, i) => {
  const p = { t: 1700000000000 + i * 60000, v }
  if (rawRow) Object.defineProperty(p, 'rawRow', { value: rawRow, enumerable: false })
  return p
})

const spec = (lsl, usl, target) => ({ lsl, usl, target })

function makeItem({ k = 2, params = null, tuning = {}, output = {} } = {}) {
  const item = {
    id: 'it_test',
    name: '自调优项',
    query: { mode: 'wide', history: 'SELECT {{columns}} FROM T', columns: { ts: 'TS' } },
    output: {
      code: 'MV', name: 'MV', unit: 'u', decimals: 2, column: 'MV',
      objective: 'quality', spec: spec(9, 11, 10), ...output,
    },
    params: params || [{
      code: 'MV', name: 'MV', unit: 'u', decimals: 2, column: 'MV',
      min: 0, max: 20, setpoint: 5, maxStepPct: 100, weight: 1, enabled: true,
      k: { mode: 'manual', value: k },
    }],
    tuning: { deadbandPct: 0, maxRounds: 2, residualTolerancePct: 5, ...tuning },
  }
  return item
}

const seriesOf = (item, cvPoints, paramPoints) => ({
  output: { points: cvPoints, column: item.output.column },
  params: item.params.map((p, i) => ({
    param: p,
    points: (paramPoints && paramPoints[i]) || cvPoints,
  })),
})

describe('optimizeItem · N = 1 退化为改造前的单回路公式', () => {
  const PARAM = {
    code: 'MV', name: 'MV', unit: 'u', decimals: 2,
    setpoint: 5, optimalTarget: 10, lsl: 9, usl: 11, min: 0, max: 20,
    maxStepPct: 100, deadbandPct: 0, objective: 'quality', processGain: 2,
  }

  it('实测偏低时，建议的调整量与旧 optimizeParam 逐字一致', () => {
    const pts = steady(9.4)
    const legacy = optimizeParam(PARAM, pts, { sparkPoints: 60 })
    const item = makeItem()
    const multi = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    expect(legacy.recommendation.delta).toBeCloseTo(0.3, 6)
    expect(multi.moves[0].delta).toBeCloseTo(legacy.recommendation.delta, 6)
    expect(multi.moves[0].suggested).toBeCloseTo(legacy.recommendation.suggested, 6)
    expect(multi.moves[0].current).toBeCloseTo(legacy.recommendation.current, 6)
  })

  it('实测偏高时方向一致（下调）', () => {
    const pts = steady(10.6)
    const legacy = optimizeParam(PARAM, pts, { sparkPoints: 60 })
    const item = makeItem()
    const multi = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    expect(legacy.recommendation.delta).toBeLessThan(0)
    expect(multi.moves[0].delta).toBeCloseTo(legacy.recommendation.delta, 6)
  })

  it('工作点缺省时退回窗口实测均值（不误用 CV 的值）', () => {
    const pts = steady(9.4)
    const item = makeItem()
    item.params[0].setpoint = null
    const multi = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })
    expect(multi.moves[0].suggested).toBeCloseTo(9.7, 6)
  })
})

describe('optimizeItem · 多对 1 的份额分配', () => {
  const twoParams = () => ([
    { code: 'A', name: 'A', unit: 'u', decimals: 2, column: 'A', min: 0, max: 20, setpoint: 5, maxStepPct: 100, weight: 1, enabled: true, k: { mode: 'manual', value: 2 } },
    { code: 'B', name: 'B', unit: 'u', decimals: 2, column: 'B', min: 0, max: 10, setpoint: 10, maxStepPct: 100, weight: 1, enabled: true, k: { mode: 'manual', value: 1 } },
  ])

  it('杠杆大的参数承担更多，且 Σ kᵢ·ΔMVᵢ 恰好补上 ΔCV', () => {
    const item = makeItem({ params: twoParams() })
    const pts = steady(9.4) // ΔCV = +0.6
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    const a = r.moves.find(m => m.code === 'A')
    const b = r.moves.find(m => m.code === 'B')
    // 杠杆份额 (k²s²/w)：A = 2²·20² = 1600，B = 1²·10² = 100
    expect(a.delta).toBeGreaterThan(b.delta)
    expect(a.share).toBeGreaterThan(b.share)

    const produced = r.moves.reduce((acc, m) => acc + m.k * m.delta, 0)
    expect(produced).toBeCloseTo(0.6, 2)
    expect(r.recommendation.residualPct).toBeLessThanOrEqual(5)
  })

  it('方向相反的影响系数：负 k 的参数朝反方向调整', () => {
    const item = makeItem({
      params: [
        { code: 'A', name: 'A', unit: 'u', decimals: 2, column: 'A', min: 0, max: 20, setpoint: 5, maxStepPct: 100, weight: 1, enabled: true, k: { mode: 'manual', value: 2 } },
        { code: 'C', name: 'C', unit: 'u', decimals: 2, column: 'C', min: 0, max: 20, setpoint: 5, maxStepPct: 100, weight: 1, enabled: true, k: { mode: 'manual', value: -1 } },
      ],
    })
    const pts = steady(9.4)
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })
    const a = r.moves.find(m => m.code === 'A')
    const c = r.moves.find(m => m.code === 'C')
    expect(a.delta).toBeGreaterThan(0)
    expect(c.delta).toBeLessThan(0)
    const produced = r.moves.reduce((acc, m) => acc + m.k * m.delta, 0)
    expect(produced).toBeCloseTo(0.6, 2)
  })

  it('停用 / 未标定（k = 0）的参数不参与求解，并说明原因', () => {
    const params = twoParams()
    params[1].enabled = false
    const item = makeItem({ params })
    const pts = steady(9.4)
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    const b = r.moves.find(m => m.code === 'B')
    expect(b.participating).toBe(false)
    expect(b.delta).toBe(0)
    expect(b.excludedReason).toMatch(/停用/)
    expect(r.recommendation.reason).toMatch(/未参与本次求解/)
  })
})

describe('optimizeItem · 约束链与再分配', () => {
  it('某参数顶到量程上限时，剩余偏差转由未顶限的参数承担', () => {
    const item = makeItem({
      params: [
        // A 杠杆最大（k 大、量程宽），但当前值已经贴着上限，只剩 0.1 的余量
        { code: 'A', name: 'A', unit: 'u', decimals: 2, column: 'A', min: 0, max: 20, setpoint: 19.9, maxStepPct: 100, weight: 1, enabled: true, k: { mode: 'manual', value: 2 } },
        { code: 'B', name: 'B', unit: 'u', decimals: 2, column: 'B', min: 0, max: 20, setpoint: 10, maxStepPct: 100, weight: 1, enabled: true, k: { mode: 'manual', value: 1 } },
      ],
      tuning: { maxRounds: 2 },
    })
    const pts = steady(9.4) // ΔCV = +0.6
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    const a = r.moves.find(m => m.code === 'A')
    const b = r.moves.find(m => m.code === 'B')
    expect(a.clampedBy).toBe('max')
    expect(a.suggested).toBeCloseTo(20, 2)
    // 再分配后 B 补足剩下的量，总残差应小于原先 A 独占的 0.6
    expect(b.delta).toBeGreaterThan(0.3)
    expect(Math.abs(r.recommendation.residual)).toBeLessThan(0.02)
    expect(r.recommendation.rounds).toBeGreaterThanOrEqual(1)
  })

  it('全部参数都被顶死时：如实报告残差，不假装能消除', () => {
    const item = makeItem({
      params: [
        { code: 'A', name: 'A', unit: 'u', decimals: 2, column: 'A', min: 5, max: 5.01, setpoint: 5, maxStepPct: 100, weight: 1, enabled: true, k: { mode: 'manual', value: 2 } },
      ],
      tuning: { maxRounds: 2 },
    })
    const pts = steady(9.4)
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    expect(Number.isFinite(r.recommendation.residual)).toBe(true)
    expect(r.recommendation.residual).toBeGreaterThan(0.4)
    expect(r.recommendation.residualPct).toBeGreaterThan(5)
    expect(r.recommendation.risk).toMatch(/无法消除|未能足额调整/)
  })

  it('单次幅度限幅生效，并标记 clampedBy = step', () => {
    const item = makeItem({
      params: [
        { code: 'A', name: 'A', unit: 'u', decimals: 2, column: 'A', min: 0, max: 20, setpoint: 5, maxStepPct: 1, weight: 1, enabled: true, k: { mode: 'manual', value: 2 } },
      ],
      tuning: { maxRounds: 0 },
    })
    const pts = steady(9.4)
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })
    const a = r.moves[0]
    expect(a.clampedBy).toBe('step')
    expect(Math.abs(a.delta)).toBeLessThanOrEqual(0.05 + 1e-9)
  })
})

describe('optimizeItem · 明确降级，绝不返回 NaN', () => {
  it('所有 k 均未标定（为 0）→ hold，且所有数值字段可序列化', () => {
    const item = makeItem({ k: 0 })
    const pts = steady(9.4)
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    expect(r.recommendation.hold).toBe(true)
    expect(r.recommendation.urgency).toBe('none')
    expect(r.moves[0].delta).toBe(0)
    expect(r.recommendation.reason).toMatch(/影响系数/)
    for (const v of Object.values(r.recommendation)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
    }
    expect(JSON.parse(JSON.stringify(r))).toBeTruthy()
  })

  it('偏差落在死区内 → 不做调整', () => {
    const item = makeItem({ tuning: { deadbandPct: 100 } })
    const pts = steady(9.4) // 偏差 0.6，死区 = 带宽 2 × 100% = 2
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })
    expect(r.recommendation.hold).toBe(true)
    expect(r.moves[0].delta).toBe(0)
    expect(r.recommendation.reason).toMatch(/死区/)
  })

  it('规格表达式引用的列取不到 → status unknown + confidence 0', () => {
    const item = makeItem({ output: { spec: { lsl: 'LSL_COL', usl: 'USL_COL', target: 'TGT_COL' } } })
    const pts = steady(9.4) // 没有 rawRow → 表达式无法求值
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })

    expect(r.status).toBe('unknown')
    expect(r.recommendation.confidence).toBe(0)
    expect(r.recommendation.hold).toBe(true)
    expect(r.moves).toEqual([])
    expect(r.recommendation.reason).toMatch(/规格未能确定/)
  })

  it('数据点不足 → 明确提示继续观察', () => {
    const item = makeItem()
    const pts = steady(9.4, 5)
    const r = optimizeItem(item, seriesOf(item, pts), { sparkPoints: 60 })
    expect(r.recommendation.hold).toBe(true)
    expect(r.recommendation.reason).toMatch(/样本不足/)
  })
})
