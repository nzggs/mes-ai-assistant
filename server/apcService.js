/**
 * APC / RTO 领域服务
 * ============================================================================
 * 职责：
 *  1) 读取「过程参数目录」（server/apc.catalog.json，可用 APC_CATALOG_FILE 覆盖）；
 *  2) 即时读取 HANA 中记录的过程数据列值（只读），未配置 HANA 时回退到内置仿真源，
 *     保证功能在任何环境下都能演示与自测；
 *  3) 依据数据变化（均值偏移、波动、趋势）计算优化后的过程参数设定值建议，
 *     并给出量化的置信度、约束说明与中文理由。
 *
 * 优化逻辑（可解释的稳态优化，对齐 APC/RTO 的「约束 + 目标」思路）：
 *   - 测量均值 μ 与 RTO 理想操作点 T 的偏差 e = T - μ
 *   - 依据过程增益 K（d测量/d设定值，默认 1）反推所需设定值修正量 Δ = e / K
 *   - 依次施加：可变范围 [min,max] 裁剪 → 单次调整幅度限幅（maxStepPct）
 *   - 汇总 σ、Cpk、趋势斜率，给出置信度与预警等级
 *
 * 安全边界：本模块只会执行 catalog 中定义的 SQL 模板，且模板占位符仅接受
 * 「整数」与「目录内白名单参数编码」，不接受任何客户端传入的裸 SQL。
 */
import fs from 'fs'
import { isHanaConfigured, queryReadOnly, getHanaStatus, pickColumn } from './hanaClient.js'
import * as apcConfig from './apcConfig.js'
import { CODE_RE, normalizeQueries, normalizeParams, queryTemplateWarnings } from './apcCatalog.js'
import { quoteIdent, renderSqlTemplate, assertIdent } from './sqlGuard.js'

// ===== 通用工具 =====

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

export function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return value
  const f = Math.pow(10, Math.max(0, Math.min(6, decimals || 0)))
  return Math.round(value * f) / f
}

function clamp(v, lo, hi) {
  if (Number.isFinite(lo) && v < lo) return lo
  if (Number.isFinite(hi) && v > hi) return hi
  return v
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function hashCode(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 稳定伪随机（-1..1）：同一 seed+ts 永远得到同一值，保证刷新之间曲线连续 */
function noiseAt(seed, ts) {
  const h = (Math.imul(seed ^ (ts >>> 16), 2654435761) >>> 0)
  return (h / 4294967296) * 2 - 1
}

export function basicStats(values) {
  const n = values.length
  if (n === 0) return { n: 0, mean: NaN, std: NaN, min: NaN, max: NaN }
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    sum += v
    if (v < min) min = v
    if (v > max) max = v
  }
  const mean = sum / n
  let variance = 0
  if (n > 1) {
    let acc = 0
    for (const v of values) acc += (v - mean) * (v - mean)
    variance = acc / (n - 1)
  }
  return { n, mean, std: Math.sqrt(variance), min, max }
}

/**
 * 最小二乘斜率（单位：每点）。x 用采样序号以避免时间戳量级带来的数值误差。
 */
export function linearSlope(values) {
  const n = values.length
  if (n < 3) return 0
  const meanX = (n - 1) / 2
  let meanY = 0
  for (const v of values) meanY += v
  meanY /= n
  let num_ = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = i - meanX
    num_ += dx * (values[i] - meanY)
    den += dx * dx
  }
  return den === 0 ? 0 : num_ / den
}

// ===== 参数目录 =====
// 目录来源有两处，由 apcConfig 统一合并与校验：
//   ① 种子文件 server/apc.catalog.json（可用 APC_CATALOG_FILE 指定，指定后页面保存不生效）
//   ② 管理员在「APC和RTO → 数据源配置 → 参数配置」保存的覆盖（数据卷 apc.config.json）

let catalogError = ''

/** 当前生效的目录来源路径（锁定在环境变量指定文件时指向该文件，否则指向数据卷配置） */
function catalogFile() {
  return apcConfig.isCatalogFileLocked() ? apcConfig.seedFilePath() : apcConfig.configFilePath()
}

/** 读取参数目录（带缓存；force=true 强制重载，供测试与热更新使用） */
export function loadCatalog(force = false) {
  catalogError = ''
  try {
    return apcConfig.getEffectiveCatalog(force)
  } catch (err) {
    catalogError = String((err && err.message) || err)
    throw new Error(`加载 APC 参数目录失败：${catalogError}`)
  }
}

export function getCatalogError() {
  return catalogError
}

export function isApcEnabled() {
  return toBool(process.env.APC_ENABLED, true)
}

/** 当前数据源模式：配置了 HANA 且有取数模板 → hana，否则 simulated */
export function getSourceMode() {
  const cat = loadCatalog()
  const hasTemplate = Boolean(cat.queries && cat.queries.history)
  return isHanaConfigured() && hasTemplate ? 'hana' : 'simulated'
}

export function listParams() {
  return loadCatalog().params
}

export function findParam(code) {
  const target = String(code || '').trim()
  return loadCatalog().params.find((p) => p.code === target) || null
}

// ===== SQL 模板拼装（占位符仅接受整数与白名单标识符）=====
// 模板由管理员在页面上手工维护，但代入值永远是「服务端生成的整数 / 白名单编码 / 已校验列名」，
// 客户端无法借模板注入任意文本。

function buildCodeFilter(column, codes) {
  if (!Array.isArray(codes) || codes.length === 0) return ''
  const items = codes.map((c) => {
    if (!CODE_RE.test(String(c))) throw new Error(`参数编码非法：${c}`)
    return `'${String(c)}'`
  })
  return ` AND ${quoteIdent(column)} IN (${items.join(', ')})`
}

/**
 * 组装模板变量。窄表（long）用 {{codeFilter}} 过滤参数编码；
 * 宽表（wide）用 {{columns}} 展开各参数的数据列名。
 * @param {object} catalog 目录（含 queries）
 * @param {{minutes:number, limit:number, codes?:string[], params?:object[]}} options
 */
export function buildTemplateVars(catalog, { minutes, limit, codes, params }) {
  const q = catalog.queries || {}
  const cols = q.columns || {}
  const targetParams = Array.isArray(params) && params.length > 0
    ? params
    : (catalog.params || []).filter(p => !Array.isArray(codes) || codes.length === 0 || codes.includes(p.code))

  const vars = {
    minutes: String(Math.max(1, Math.round(minutes))),
    limit: String(Math.max(1, Math.round(limit))),
    schema: String(catalog.schema || ''),
    codeFilter: '',
    columns: '',
  }

  if (q.mode === 'wide') {
    // 宽表必须逐个参数指定数据列名：宁可这里直接报错，也不要拿编码猜列名去打库（会悄悄取错数据）
    const missing = targetParams.filter(p => !p.column).map(p => p.code)
    if (missing.length > 0) {
      throw new Error(`宽表取数模式下以下参数未配置数据列名：${missing.join('、')}`)
    }
    vars.columns = targetParams
      .map(p => quoteIdent(assertIdent(p.column, `参数 ${p.code} 的数据列名`)))
      .join(', ')
  } else {
    vars.codeFilter = buildCodeFilter(cols.code || 'PARAM_CODE', codes)
  }
  return vars
}

export function buildHistorySql(cat, { minutes, limit, codes, params }) {
  if (!cat.queries || !cat.queries.history) throw new Error('参数目录未配置 HANA 取数模板')
  return renderSqlTemplate(cat.queries.history, buildTemplateVars(cat, { minutes, limit, codes, params }))
}

/**
 * 试运行管理员手工填写的取数 SQL：真实执行一次**只读**查询，返回列名与前 N 行，
 * 供页面确认「参数编码列 / 时间戳列 / 数值列」映射是否正确。不落盘、不影响现有配置。
 * 草稿同样要过只读护栏与模板校验——试运行不能成为绕过安全边界的口子。
 *
 * @param {{queries?:object, params?:object[], minutes?:number, maxRows?:number}} input
 */
export async function previewQuery({ queries, params, minutes, maxRows } = {}) {
  const cat = loadCatalog()
  // 先做纯文本校验（只读护栏 / 占位符 / 列名 / 参数结构）——这些不需要连库，
  // 因此在「还没配好数据库」时也能先帮使用者把 SQL 本身的问题挑出来，
  // 而不是一律回「未配置连接」把真正的原因盖掉。
  const draftQueries = normalizeQueries(queries == null ? cat.queries : queries)
  if (!draftQueries) {
    const err = new Error('缺少取数 SQL 模板')
    err.status = 400
    throw err
  }

  const draftParams = Array.isArray(params) && params.length > 0
    ? normalizeParams(params, { mode: draftQueries.mode })
    : cat.params

  if (!isHanaConfigured()) {
    const err = new Error('尚未配置只读数据库连接，无法试运行 SQL；请先在「数据库登录」窗口填写连接信息并保存')
    err.status = 400
    throw err
  }

  const mins = Math.max(1, Math.round(num(minutes, cat.defaultWindowMinutes)))
  const cap = Math.max(1, Math.min(200, Math.round(num(maxRows, 50))))
  const catalogForRender = { ...cat, queries: draftQueries }
  const vars = buildTemplateVars(catalogForRender, {
    minutes: mins,
    limit: cap,
    codes: draftParams.map(p => p.code),
    params: draftParams,
  })
  const sqlText = renderSqlTemplate(draftQueries.history, vars)

  const started = Date.now()
  const { rows, truncated } = await queryReadOnly(sqlText, { maxRows: cap })
  return {
    ok: true,
    mode: draftQueries.mode,
    sql: sqlText,
    vars,
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rows: rows.slice(0, cap).map(sanitizeRow),
    rowCount: rows.length,
    truncated,
    elapsedMs: Date.now() - started,
    warnings: queryTemplateWarnings(draftQueries.history, { mode: draftQueries.mode }),
  }
}

/** 把驱动返回的行做 JSON 友好化（Date/Buffer/BigInt） */
function sanitizeRow(row) {
  const out = {}
  for (const [k, v] of Object.entries(row || {})) out[k] = sanitizeCell(v)
  return out
}

function sanitizeCell(v) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return Number(v)
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return `<binary ${v.length}B>`
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return v
}

// ===== 仿真数据源（未配置 HANA 时使用）=====

function simSigma(param) {
  const scale = num(param.sim && param.sim.sigmaScale, 3)
  return (param.usl - param.lsl) / (scale > 0 ? scale : 3)
}

/**
 * 仿真值 = RTO 理想操作点 + 参数固有偏移(offsetSigma·S) + 平滑漂移 + 少量噪声。
 * 全部是时间戳的确定性函数，因此「连续刷新看到连续变化」，符合真实趋势的表现。
 * 其中 S = simSigma（规格带宽 / sigmaScale），偏移项模拟现场工况对理想点的稳态偏离。
 */
export function simulateValueAt(param, ts) {
  const S = simSigma(param)
  const seed = hashCode(param.code)
  const t = ts / 1000
  const smooth = (Math.sin(t / 900 + (seed % 31)) + Math.sin(t / 2600 + (seed % 17))) / 2
  const jitter = noiseAt(seed, Math.floor(ts / 1000))
  const offset = num(param.sim && param.sim.offsetSigma, 0)
  return param.optimalTarget + (offset + smooth * 0.35 + jitter * 0.15) * S
}

function simulateSeries(param, { minutes, sampleIntervalSec, now }) {
  const windowMs = minutes * 60 * 1000
  const natural = Math.round(windowMs / (sampleIntervalSec * 1000))
  const count = Math.max(6, Math.min(900, natural || 6))
  // 采样点严格铺满所选窗口，保证前端时间轴与统计口径与窗口一致
  const stepMs = count > 1 ? windowMs / (count - 1) : windowMs
  const out = []
  for (let i = 0; i < count; i++) {
    const ts = Math.round(now - windowMs + i * stepMs)
    out.push({ t: ts, v: simulateValueAt(param, ts) })
  }
  return out
}

// ===== 取数（对外唯一入口）=====

function parseTimestamp(rawTs) {
  if (rawTs instanceof Date) return rawTs.getTime()
  if (typeof rawTs === 'number') return rawTs
  if (typeof rawTs === 'string') {
    const parsed = Date.parse(rawTs)
    if (Number.isFinite(parsed)) return parsed
  }
  return NaN
}

/** 窄表：一行一个参数值，按「参数编码列」分组 */
function normalizeSeries(rows, codeColumn, tsColumn, valueColumn) {
  const map = new Map()
  for (const row of rows) {
    const code = String(pickColumn(row, codeColumn) == null ? '' : pickColumn(row, codeColumn)).trim()
    if (!code) continue
    const value = Number(pickColumn(row, valueColumn))
    if (!Number.isFinite(value)) continue
    let t = parseTimestamp(pickColumn(row, tsColumn))
    if (!Number.isFinite(t)) t = Date.now()
    if (!map.has(code)) map.set(code, [])
    map.get(code).push({ t, v: value })
  }
  for (const arr of map.values()) arr.sort((a, b) => a.t - b.t)
  return map
}

/** 宽表：一行一个时间戳，每个参数各占一列（列名取参数定义里的 column） */
function normalizeWideSeries(rows, tsColumn, params) {
  const map = new Map()
  for (const p of params) map.set(p.code, [])
  for (const row of rows) {
    let t = parseTimestamp(pickColumn(row, tsColumn))
    if (!Number.isFinite(t)) t = Date.now()
    for (const p of params) {
      const value = Number(pickColumn(row, p.column || p.code))
      if (!Number.isFinite(value)) continue
      map.get(p.code).push({ t, v: value })
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.t - b.t)
  return map
}

/**
 * 拉取窗口内的历史数据列值。
 * @param {{minutes?:number, codes?:string[], maxRows?:number}} options
 * @returns {Promise<{mode:string, series:Map<string,{t:number,v:number}[]>, meta:object}>}
 */
export async function fetchProcessSeries(options = {}) {
  const cat = loadCatalog()
  const now = Date.now()
  const minutes = Math.max(1, Math.round(num(options.minutes, cat.defaultWindowMinutes)))
  const requested = Array.isArray(options.codes) && options.codes.length > 0
    ? options.codes.map((c) => String(c))
    : cat.params.map((p) => p.code)
  // 只允许目录内已定义的编码，杜绝任意编码进入 SQL
  const codes = requested.filter((c) => CODE_RE.test(c) && cat.params.some((p) => p.code === c))

  const mode = getSourceMode()

  if (mode === 'simulated') {
    const series = new Map()
    for (const p of cat.params) {
      if (!codes.includes(p.code)) continue
      series.set(p.code, simulateSeries(p, { minutes, sampleIntervalSec: cat.sampleIntervalSec, now }))
    }
    return {
      mode,
      series,
      queryMode: (cat.queries && cat.queries.mode) || null,
      meta: {
        windowMinutes: minutes,
        sampleIntervalSec: cat.sampleIntervalSec,
        rowCount: Array.from(series.values()).reduce((a, b) => a + b.length, 0),
        truncated: false,
      },
    }
  }

  const maxRows = Math.max(50, Math.round(num(options.maxRows, Number(process.env.HANA_MAX_ROWS || 2000))))
  const selectedParams = cat.params.filter(p => codes.includes(p.code))
  const sql = buildHistorySql(cat, { minutes, limit: maxRows, codes, params: selectedParams })
  const { rows, truncated } = await queryReadOnly(sql, { maxRows })
  const cols = (cat.queries && cat.queries.columns) || {}
  const series = cat.queries && cat.queries.mode === 'wide'
    ? normalizeWideSeries(rows, cols.ts || 'TS', selectedParams)
    : normalizeSeries(rows, cols.code || 'PARAM_CODE', cols.ts || 'TS', cols.value || 'VALUE')
  return {
    mode,
    series,
    queryMode: (cat.queries && cat.queries.mode) || 'long',
    meta: {
      windowMinutes: minutes,
      sampleIntervalSec: cat.sampleIntervalSec,
      rowCount: rows.length,
      truncated,
    },
  }
}

// ===== 状态与趋势判定 =====

export function statusOf(param, stats) {
  const { n, mean, std } = stats
  if (!n || !Number.isFinite(mean)) return 'unknown'
  if (mean <= param.lsl || mean >= param.usl) return 'danger'
  if (!(std > 0)) return 'normal'
  const cpk = Math.min(param.usl - mean, mean - param.lsl) / (3 * std)
  if (cpk < 0.67) return 'danger'
  if (cpk < 1.33) return 'warning'
  return 'normal'
}

export function trendOf(slope, std) {
  if (!Number.isFinite(slope) || slope === 0) return 'stable'
  const threshold = Math.abs(std) * 0.05
  if (Math.abs(slope) < threshold || threshold === 0) return 'stable'
  return slope > 0 ? 'up' : 'down'
}

export function computeCpk(param, mean, std) {
  if (!Number.isFinite(mean) || !(std > 0)) return null
  return Math.min(param.usl - mean, mean - param.lsl) / (3 * std)
}

/** 压缩曲线用于前端展示（最多 maxPoints 个点） */
function downsample(points, maxPoints = 60) {
  if (points.length <= maxPoints) return points
  const step = points.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.min(points.length - 1, Math.floor(i * step))])
  }
  out.push(points[points.length - 1])
  return out
}

// ===== 优化建议引擎 =====

const OBJECTIVE_LABEL = {
  quality: '质量',
  energy: '能耗',
  yield: '收率',
  stability: '平稳性',
}

/**
 * 针对单个参数生成设定值优化建议（纯函数，便于单测）。
 * @param {object} param 目录中的参数定义
 * @param {Array<{t:number,v:number}>} series 窗口内历史数据列值
 * @param {{sparkPoints?:number}} [opts]
 */
export function optimizeParam(param, series, opts = {}) {
  const points = Array.isArray(series) ? series : []
  const values = points.map((p) => p.v).filter((v) => Number.isFinite(v))
  const stats = basicStats(values)
  const sigmaSpec = simSigma(param)
  const latest = values.length > 0 ? values[values.length - 1] : NaN
  const slope = linearSlope(values)
  const cpk = computeCpk(param, stats.mean, stats.std)
  const status = statusOf(param, stats)
  const trend = trendOf(slope, stats.std)
  const decimals = param.decimals

  const base = {
    code: param.code,
    name: param.name,
    process: param.process,
    unit: param.unit,
    decimals,
    objective: param.objective,
    objectiveLabel: OBJECTIVE_LABEL[param.objective] || '综合',
    setpoint: param.setpoint,
    optimalTarget: param.optimalTarget,
    min: param.min,
    max: param.max,
    lsl: param.lsl,
    usl: param.usl,
    maxStepPct: param.maxStepPct,
    latest: Number.isFinite(latest) ? roundTo(latest, decimals) : null,
    mean: Number.isFinite(stats.mean) ? roundTo(stats.mean, decimals) : null,
    std: Number.isFinite(stats.std) ? roundTo(stats.std, Math.min(4, decimals + 2)) : null,
    min_: Number.isFinite(stats.min) ? roundTo(stats.min, decimals) : null,
    max_: Number.isFinite(stats.max) ? roundTo(stats.max, decimals) : null,
    sampleCount: stats.n,
    cpk: cpk == null ? null : roundTo(cpk, 2),
    slope: roundTo(slope, Math.min(4, decimals + 3)),
    trend,
    status,
    series: downsample(points, opts.sparkPoints || 60).map((p) => ({
      t: p.t,
      v: roundTo(p.v, decimals),
    })),
  }

  // ---- 数据不足：给出「继续观察」建议，不做激进调整 ----
  const MIN_SAMPLES = 8
  if (stats.n < MIN_SAMPLES) {
    return {
      ...base,
      recommendation: {
        current: param.setpoint,
        suggested: param.setpoint,
        delta: 0,
        deltaPct: 0,
        confidence: 30,
        urgency: 'none',
        hold: true,
        clampedBy: null,
        reason: `窗口内仅 ${stats.n} 个有效数据点（需 ≥ ${MIN_SAMPLES} 个），样本不足无法可靠估计过程状态，建议保持当前设定值并继续采集数据。`,
        expected: null,
      },
    }
  }

  // ---- 优化计算 ----
  const gain = param.processGain || 1
  // 测量均值与理想操作点的偏差（正=测得偏高，需要把设定值下调）
  const error = param.optimalTarget - stats.mean
  const wanted = param.setpoint + error / gain

  const bounded = clamp(wanted, param.min, param.max)
  const clampedBy = bounded !== wanted ? (wanted > param.max ? 'max' : 'min') : null

  const maxStep = Math.abs(param.setpoint) * (param.maxStepPct / 100)
  const wantedDelta = bounded - param.setpoint
  const delta = clamp(wantedDelta, -maxStep, maxStep)
  const limitedBy = Math.abs(delta) < Math.abs(wantedDelta) - 1e-12 ? 'step' : null

  const quantum = Math.pow(10, -decimals)
  const width = param.usl - param.lsl
  // 工艺死区：偏差在死区内且过程能力正常时不做调整——RTO 的调整收益低于扰动成本，
  // 「不动」本身就是最优决策。默认死区为规格带宽的 10%，可按参数覆盖。
  const deadband = width * (num(param.deadbandPct, 10) / 100)
  const inDeadband = status === 'normal' && Math.abs(error) <= deadband
  const keep = inDeadband || Math.abs(delta) < quantum / 2
  const suggested = keep ? param.setpoint : roundTo(param.setpoint + delta, decimals)
  const finalDelta = roundTo(suggested - param.setpoint, decimals)

  // 调整后预测：均值平移 delta*gain，σ 视为不变
  const predictedMean = stats.mean + finalDelta * gain
  const predictedCpk = computeCpk(param, predictedMean, stats.std)
  const predictedBoost = predictedCpk != null && cpk != null ? predictedCpk - cpk : null

  // ---- 置信度 ----
  let confidence = 55
  confidence += Math.min(25, (stats.n / 60) * 25)              // 样本量
  if (cpk == null || cpk < 1.0) confidence -= 12               // 过程能力差 → 估计不稳
  const noiseRatio = sigmaSpec > 0 ? stats.std / sigmaSpec : 0
  if (noiseRatio > 0.6) confidence -= 10                       // 波动过大
  else if (noiseRatio < 0.25) confidence += 8                  // 数据平稳
  if (status === 'danger') confidence -= 5
  if (Math.abs(finalDelta) > maxStep * 0.6) confidence += 5     // 偏差显著，方向明确
  if (keep) confidence = Math.min(confidence, 60)               // 保持建议不宜给高置信
  confidence = Math.max(30, Math.min(95, Math.round(confidence)))

  // ---- 紧急度 ----
  const ratio = maxStep > 0 ? Math.abs(finalDelta) / maxStep : 0
  let urgency = 'none'
  if (!keep) urgency = ratio >= 0.9 ? 'high' : ratio >= 0.4 ? 'medium' : 'low'
  if (status === 'danger' && urgency === 'low') urgency = 'medium'

  // ---- 中文理由 ----
  const parts = []
  const absErr = Math.abs(error)
  parts.push(
    `近 ${base.sampleCount} 个采样点均值 ${base.mean}${param.unit}，` +
    `${error >= 0 ? '低于' : '高于'} RTO 理想操作点 ${param.optimalTarget}${param.unit}` +
    `（偏差 ${roundTo(absErr, decimals)}${param.unit}，占规格带宽 ${width > 0 ? roundTo((absErr / width) * 100, 1) : '—'}%）`
  )
  parts.push(
    `波动 σ=${base.std}，过程能力 Cpk=${cpk == null ? '—' : roundTo(cpk, 2)}（${statusLabel(status)}）`
  )
  if (!keep) {
    parts.push(
      `按过程增益 ${gain} 将设定值由 ${param.setpoint}${param.unit} 调整至 ${suggested}${param.unit}` +
      `（${finalDelta > 0 ? '上调' : '下调'} ${Math.abs(finalDelta)}${param.unit}，` +
      `${param.setpoint !== 0 ? roundTo((Math.abs(finalDelta) / Math.abs(param.setpoint)) * 100, 2) : '—'}%）`
    )
    if (limitedBy === 'step') {
      parts.push(`该修正量已触及单次调整上限 ±${param.maxStepPct}%（本次为分步逼近，建议下个周期继续推进）`)
    }
    if (clampedBy) {
      parts.push(`目标值已受可调${clampedBy === 'max' ? '上限' : '下限'} ${clampedBy === 'max' ? param.max : param.min}${param.unit} 约束`)
    }
    if (predictedCpk != null) {
      parts.push(`预计调整后均值回落至 ${roundTo(predictedMean, decimals)}${param.unit}，Cpk 约 ${roundTo(predictedCpk, 2)}`)
    }
  } else {
    parts.push(
      inDeadband
        ? `偏差 ${roundTo(absErr, decimals)}${param.unit} 处于工艺死区内（±${roundTo(deadband, decimals)}${param.unit}，为规格带宽的 ${num(param.deadbandPct, 10)}%）且过程能力正常，调整收益低于扰动成本，建议保持当前设定值`
        : '设定值与理想操作点已基本一致，且修正量小于一个最小调节步长，建议保持'
    )
  }
  if (trend !== 'stable') {
    parts.push(`窗口内呈${trend === 'up' ? '上行' : '下行'}趋势（斜率 ${base.slope}/点），建议同步关注上游来料与工况变化`)
  }

  const reason = parts.join('；') + '。'

  // 风险提示：约束可能同时生效（如既顶到可调上限、又触及单次限幅），逐条说明避免信息丢失
  const riskNotes = []
  if (status === 'danger') riskNotes.push('当前过程能力不足，存在批量超规格风险，建议优先处理')
  if (clampedBy === 'max') riskNotes.push('受可调范围上限约束，无法完全消除偏差，需评估工艺窗口或上游条件')
  if (clampedBy === 'min') riskNotes.push('受可调范围下限约束，无法完全消除偏差，需评估工艺窗口或上游条件')
  if (limitedBy === 'step') riskNotes.push('偏差较大，一次调满可能引起工艺波动，已改为分步调整')
  let risk = riskNotes.length > 0 ? `${riskNotes.join('；')}。` : ''
  if (!risk && predictedBoost != null && predictedBoost <= 0) {
    risk = '按当前数据推算调整后过程能力无改善，建议先排查测量与执行机构。'
  }

  return {
    ...base,
    recommendation: {
      current: param.setpoint,
      suggested,
      delta: finalDelta,
      deltaPct: param.setpoint !== 0 ? roundTo((finalDelta / Math.abs(param.setpoint)) * 100, 2) : null,
      confidence,
      urgency,
      hold: keep,
      clampedBy: clampedBy || limitedBy,
      predictedMean: roundTo(predictedMean, decimals),
      predictedCpk: predictedCpk == null ? null : roundTo(predictedCpk, 2),
      reason,
      risk,
    },
  }
}

function statusLabel(status) {
  if (status === 'normal') return '正常'
  if (status === 'warning') return '预警'
  if (status === 'danger') return '异常'
  return '未知'
}

// ===== 缓存（避免前端轮询频繁打到数据库）=====

const cache = new Map()
function withCache(key, ttlMs, loader) {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < ttlMs) return hit.promise
  const promise = loader().catch((err) => {
    cache.delete(key)
    throw err
  })
  cache.set(key, { at: now, promise })
  return promise
}

export function clearApcCache() {
  cache.clear()
}

function cacheTtl() {
  return Math.max(0, num(process.env.APC_CACHE_TTL_MS, 5000))
}

// ===== 对外聚合接口 =====

/** 参数概览：当前值、统计量、趋势、状态（含压缩曲线） */
export async function getOverview({ minutes } = {}) {
  const cat = loadCatalog()
  const ttl = cacheTtl()
  const key = `overview:${minutes || 'default'}`
  const loader = async () => {
    const started = Date.now()
    const { mode, series, meta } = await fetchProcessSeries({ minutes })
    const params = cat.params.map((p) => optimizeParam(p, series.get(p.code) || [], { sparkPoints: 60 }))
    return {
      station: cat.station,
      mode,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      windowMinutes: meta.windowMinutes,
      sampleIntervalSec: meta.sampleIntervalSec,
      rowCount: meta.rowCount,
      truncated: meta.truncated,
      source: describeSource(mode, meta),
      params,
    }
  }
  if (ttl <= 0) return loader()
  return withCache(key, ttl, loader)
}

/** 优化建议：按紧急度排序，只返回需要动作或需要关注的项 */
export async function getOptimization({ minutes, codes } = {}) {
  const cat = loadCatalog()
  const ttl = cacheTtl()
  const key = `optimize:${minutes || 'default'}:${(codes || []).join(',')}`
  const loader = async () => {
    const { mode, series, meta } = await fetchProcessSeries({ minutes, codes })
    const all = cat.params.map((p) => optimizeParam(p, series.get(p.code) || [], { sparkPoints: 72 }))
    const order = { high: 0, medium: 1, low: 2, none: 3 }
    const items = all
      .filter((it) => Array.isArray(codes) && codes.length > 0 ? codes.includes(it.code) : true)
      .sort((a, b) => {
        const oa = order[a.recommendation.urgency] - order[b.recommendation.urgency]
        if (oa !== 0) return oa
        return (b.recommendation.confidence - a.recommendation.confidence)
      })
    return {
      station: cat.station,
      mode,
      generatedAt: new Date().toISOString(),
      windowMinutes: meta.windowMinutes,
      source: describeSource(mode, meta),
      summary: {
        total: items.length,
        actionable: items.filter((it) => !it.recommendation.hold).length,
        high: items.filter((it) => it.recommendation.urgency === 'high').length,
        medium: items.filter((it) => it.recommendation.urgency === 'medium').length,
        danger: items.filter((it) => it.status === 'danger').length,
        avgConfidence: items.length
          ? Math.round(items.reduce((a, b) => a + b.recommendation.confidence, 0) / items.length)
          : 0,
      },
      items,
    }
  }
  if (ttl <= 0) return loader()
  return withCache(key, ttl, loader)
}

/** 单个参数的历史曲线（供详情面板） */
export async function getHistory({ code, minutes } = {}) {
  const param = findParam(code)
  if (!param) {
    const err = new Error(`未找到参数：${code}`)
    err.status = 404
    throw err
  }
  const ttl = cacheTtl()
  const key = `history:${param.code}:${minutes || 'default'}`
  const loader = async () => {
    const { mode, series, meta } = await fetchProcessSeries({ minutes, codes: [param.code] })
    const points = series.get(param.code) || []
    const values = points.map((p) => p.v)
    const stats = basicStats(values)
    const cpk = computeCpk(param, stats.mean, stats.std)
    return {
      param: {
        code: param.code,
        name: param.name,
        process: param.process,
        unit: param.unit,
        decimals: param.decimals,
        setpoint: param.setpoint,
        optimalTarget: param.optimalTarget,
        lsl: param.lsl,
        usl: param.usl,
        min: param.min,
        max: param.max,
      },
      mode,
      windowMinutes: meta.windowMinutes,
      source: describeSource(mode, meta),
      stats: {
        n: stats.n,
        mean: Number.isFinite(stats.mean) ? roundTo(stats.mean, param.decimals) : null,
        std: Number.isFinite(stats.std) ? roundTo(stats.std, Math.min(4, param.decimals + 2)) : null,
        min: Number.isFinite(stats.min) ? roundTo(stats.min, param.decimals) : null,
        max: Number.isFinite(stats.max) ? roundTo(stats.max, param.decimals) : null,
        cpk: cpk == null ? null : roundTo(cpk, 2),
        trend: trendOf(linearSlope(values), stats.std),
        status: statusOf(param, stats),
      },
      points: points.map((p) => ({ t: p.t, v: roundTo(p.v, param.decimals) })),
    }
  }
  if (ttl <= 0) return loader()
  return withCache(key, ttl, loader)
}

function describeSource(mode, meta) {
  if (mode === 'hana') {
    const wide = meta && meta.queryMode === 'wide'
    return {
      label: `SAP HANA（只读 · ${wide ? '宽表取数' : '窄表取数'}）`,
      note:
        '实时读取 HANA 中记录的过程数据列值；仅执行 SELECT，单次读取行数与执行时间均受服务端限制。' +
        `当前取数模式：${wide ? '宽表（一行一个时间戳，各参数各占一列）' : '窄表（一行一个参数值，按编码列分组）'}。`,
      simulated: false,
    }
  }
  return {
    label: '内置仿真数据源',
    note:
      '未检测到可用的数据库配置，当前展示内置仿真过程数据（仅用于功能验证与演示）。' +
      '可在「数据源配置 → 数据库登录」窗口中直接填写连接信息并保存，保存后立即生效，无需重启服务。',
    simulated: true,
  }
}

export function getApcStatus() {
  let cat = null
  let catalogError = ''
  try {
    cat = loadCatalog()
  } catch (err) {
    catalogError = String((err && err.message) || err)
  }
  return {
    enabled: isApcEnabled(),
    mode: cat ? getSourceMode() : 'unavailable',
    station: cat ? cat.station : '',
    paramCount: cat ? cat.params.length : 0,
    queryMode: cat && cat.queries ? cat.queries.mode : null,
    catalogFile: catalogFile(),
    catalogOrigin: apcConfig.getCatalogOrigin(),
    catalogFileLocked: apcConfig.isCatalogFileLocked(),
    catalogError,
    configFile: apcConfig.configFilePath(),
    configFileExists: fs.existsSync(apcConfig.configFilePath()),
    configFileError: apcConfig.getConfigFileError(),
    hana: getHanaStatus(),
  }
}
