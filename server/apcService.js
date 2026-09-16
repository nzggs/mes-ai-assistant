/**
 * APC / RTO 领域服务
 * ============================================================================
 * 职责：
 *  1) 读取「过程参数目录」（监测项目各自一套：SQL 模板 + 参数定义）；
 *  2) 即时读取 HANA 中记录的过程数据列值（只读）。**系统不内置任何仿真/演示数据源**：
 *     未创建监测项目、项目未配 SQL 模板、或绑定的数据库未配置连接时，一律视为
 *     「未配置数据源」并返回空结果 + 明确原因，由页面展示空态引导；
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
import { isDataSourceConfigured, queryReadOnly, getHanaStatus, pickColumn, pingHana } from './hanaClient.js'
import * as apcConfig from './apcConfig.js'
import { CODE_RE, normalizeQueries, normalizeParams, normalizeItem, queryTemplateWarnings, WEIGHT_MIN } from './apcCatalog.js'
import { quoteIdent, renderSqlTemplate, assertIdent, assertReadOnlySql, applyRowLimit } from './sqlGuard.js'
import { parseExpr, evalExpr } from './specExpr.js'

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

/** 读取参数目录（带缓存；force=true 强制重载；projectId 缺省取第一个监测项目） */
export function loadCatalog(force = false, projectId) {
  catalogError = ''
  try {
    return apcConfig.getCatalogForProject(projectId, force)
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

/**
 * 项目就绪判定：必须有监测项目 + 该项目自己配了取数 SQL 模板 + 绑定的数据库已配置连接。
 * 三者缺一即视为「未配置数据源」——系统不再有内置仿真数据源兜底，未就绪时页面显示空态引导，
 * 绝不展示任何伪造/推测的数据。
 * @returns {{ready:boolean, reason:'no-project'|'no-template'|'no-connection'|'', projectId:string, slot:string, projectName:string}}
 */
export function getSourceReadiness(projectId) {
  const pid = apcConfig.resolveProjectId(projectId)
  const project = pid ? apcConfig.getProject(pid) : null
  const base = {
    projectId: pid || '',
    projectName: (project && project.name) || '',
    slot: (project && project.dbSlot) || 'db1',
  }
  if (!project) return { ...base, ready: false, reason: 'no-project' }
  if (!(project.queries && project.queries.history)) return { ...base, ready: false, reason: 'no-template' }
  if (!isDataSourceConfigured(base.slot)) return { ...base, ready: false, reason: 'no-connection' }
  return { ...base, ready: true, reason: '' }
}

/** 当前数据源模式：项目就绪 → hana；否则 unconfigured */
export function getSourceMode(projectId) {
  return getSourceReadiness(projectId).ready ? 'hana' : 'unconfigured'
}

export function listParams(projectId) {
  return loadCatalog(false, projectId).params
}

export function findParam(code, projectId) {
  const target = String(code || '').trim()
  return loadCatalog(false, projectId).params.find((p) => p.code === target) || null
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
    const colNames = targetParams.map(p => assertIdent(p.column, `参数 ${p.code} 的数据列名`))
    // 时间戳列必须出现在结果集里。宽表是「一行一个时间戳」，若 SELECT 列表里没有时间列，
    // normalizeWideSeries 取不到它就会回落到 Date.now()，整窗口的点会共享同一个时间戳，
    // 折线图随即塌成一条竖直/水平直线（现场故障）。此处统一并入，避免每个模板各写一遍。
    if (cols.ts) {
      const tsCol = assertIdent(cols.ts, '时间戳列')
      if (!colNames.some(c => c.toUpperCase() === tsCol.toUpperCase())) colNames.unshift(tsCol)
    }
    // 规格表达式引用的列（如 `USL_COL - 1` 里的 USL_COL）也要一起 SELECT 出来，
    // 否则运行期必然求值失败。并入后无需在每个模板里手工维护一份列清单；
    // 若名字不是真实表列，数据库会直接报错，由「试算」原样透出便于定位。
    for (const p of targetParams) {
      for (const ident of specReferencedColumns(compileParamSpec(p))) {
        const name = assertIdent(ident, `参数 ${p.code} 规格表达式引用的列名`)
        if (!colNames.some(c => c.toUpperCase() === name.toUpperCase())) colNames.push(name)
      }
    }
    vars.columns = colNames.map(quoteIdent).join(', ')
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
export async function previewQuery({ queries, params, minutes, maxRows, slot } = {}) {
  const cat = loadCatalog()
  const slotId = slot === 'db2' ? 'db2' : 'db1'
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

  if (!isDataSourceConfigured(slotId)) {
    const err = new Error(`数据库系统（${slotId === 'db2' ? '2' : '1'}）尚未配置连接，无法试运行 SQL；请先在侧边栏「数据库管理」填写连接信息并保存`)
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
  const { rows, truncated } = await queryReadOnly(sqlText, { maxRows: cap, slotId })
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const warnings = queryTemplateWarnings(draftQueries.history, { mode: draftQueries.mode })
  // 试算也顺手把「时间戳列没取回来」挑出来：这是页面上曲线塌成一条直线的直接原因，
  // 但只看 SQL 文本是看不出来的（列在 ORDER BY 里出现并不代表它被 SELECT 出来）。
  const tsColumn = (draftQueries.columns && draftQueries.columns.ts) || 'TS'
  if (rows.length > 0 && !columns.some(c => c.toUpperCase() === String(tsColumn).toUpperCase())) {
    warnings.push(`时间戳列 ${tsColumn} 未出现在查询结果列中（当前返回：${columns.join('、')}），趋势图将无法按时间展开。`)
  }
  // 规格表达式引用的列是否真的在结果列里：不在就必然求值失败，提前说清楚，不用等到页面上看到「未知」再猜
  const specColumns = buildSpecColumnReport(draftParams, columns)
  for (const rep of specColumns) {
    const missing = rep.columns.filter(c => !c.present).map(c => c.name)
    if (missing.length > 0) {
      warnings.push(
        `参数 ${rep.code} 的规格表达式引用了未出现在结果列中的「${missing.join('、')}」，该参数的规格将无法判定（宽表模式已自动并入；窄表模式请自行写进 SELECT）。`
      )
    }
  }
  return {
    ok: true,
    mode: draftQueries.mode,
    sql: sqlText,
    vars,
    columns,
    specColumns,
    rows: rows.slice(0, cap).map(sanitizeRow),
    rowCount: rows.length,
    truncated,
    elapsedMs: Date.now() - started,
    warnings,
  }
}

/**
 * 按监测项试运行取数 SQL（草稿态）：真实执行一次**只读**查询，返回列名、前 N 行，
 * 以及对「页面要用的每一列是否真的取回来了」的逐项核对。不落盘、不影响现有配置。
 * 草稿同样要过只读护栏与模板校验——试运行不能成为绕过安全边界的口子。
 */
export async function previewItemQuery({ project, item, minutes, maxRows, slot } = {}) {
  const projectId = apcConfig.resolveProjectId(project)
  const cat = loadCatalog(false, projectId)
  const slotId = slot === 'db2' ? 'db2' : 'db1'
  // 纯文本校验先行：即使还没配好数据库连接，也能先把 SQL 本身的问题挑出来，
  // 而不是一律回「未配置连接」把真正的原因盖掉。
  const draft = normalizeItem(item, 0)

  if (!isDataSourceConfigured(slotId)) {
    const err = new Error(
      `数据库系统（${slotId === 'db2' ? '2' : '1'}）尚未配置连接，无法试运行 SQL；` +
      '请先在侧边栏「数据库管理」填写连接信息并保存'
    )
    err.status = 400
    throw err
  }

  const mins = Math.max(1, Math.round(num(minutes, cat.defaultWindowMinutes)))
  const cap = Math.max(1, Math.min(200, Math.round(num(maxRows, 50))))
  const vars = buildItemTemplateVars(cat, draft, { minutes: mins, limit: cap })
  const sqlText = renderSqlTemplate(draft.query.history, vars)

  const started = Date.now()
  const { rows, truncated } = await queryReadOnly(sqlText, { maxRows: cap, slotId })
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const has = (name) => columns.some(c => c.toUpperCase() === String(name).toUpperCase())
  const warnings = queryTemplateWarnings(draft.query.history, { mode: 'wide' })

  const tsColumn = String((draft.query.columns && draft.query.columns.ts) || 'TS')
  if (rows.length > 0 && !has(tsColumn)) {
    warnings.push(`时间戳列 ${tsColumn} 未出现在查询结果列中（当前返回：${columns.join('、')}），趋势图将无法按时间展开。`)
  }
  // 逐列核对：页面要用的每一列（输出结果 + 全部参与参数）是否真的取回来了。
  // 这类问题只看 SQL 文本看不出来——列写在 ORDER BY 里并不等于被 SELECT 出来。
  const columnCheck = [
    { role: 'output', code: draft.output.code, column: draft.output.column },
    ...draft.params.map(p => ({ role: 'param', code: p.code, column: p.column })),
  ].map(e => ({ ...e, present: rows.length === 0 ? null : has(e.column) }))
  for (const e of columnCheck) {
    if (e.present === false) {
      warnings.push(
        `${e.role === 'output' ? '输出结果' : '参与参数'} ${e.code} 的列「${e.column}」未出现在查询结果中，该项将取不到数据。`
      )
    }
  }

  return {
    ok: true,
    mode: 'wide',
    sql: sqlText,
    vars,
    columns,
    columnCheck,
    rows: rows.slice(0, cap).map(sanitizeRow),
    rowCount: rows.length,
    truncated,
    elapsedMs: Date.now() - started,
    warnings,
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

/** 规格带宽对应的过程波动基准（常规 ±3σ 口径）：用于置信度里判断实测波动是否偏大 */
function specSigma(param) {
  const width = num(param.usl, 0) - num(param.lsl, 0)
  return width > 0 ? width / 3 : 0
}

// ===== 规格表达式（列名变量）=====
//
// 现场型号多、交错生产，规格并不固定。与其逐型号维护一份数字配置，不如把规格直接
// 放进取数 SQL 的结果列随行取回，再允许用「列名 ± 数字」这类表达式微调
// （例如 `USL_COL - 1`、`(LSL_COL + USL_COL) / 2`）。
// 表达式由 server/specExpr.js 解析：只认数字/列名/四则/括号，无函数调用、不用 eval。
//
// 判定口径：
//   - 窗口级（Cpk、状态、优化建议）用**最新一行**的规格；
//   - 点级（超规格计数、最坏点、阶梯规格带）逐点用各自数据行的规格，
//     且**基于全量数据点**统计——降采样只影响展示形状，不能影响计数。

const SPEC_FIELDS = ['setpoint', 'optimalTarget', 'lsl', 'usl', 'min', 'max']

/**
 * 编译参数定义里的 6 个规格字段：数字直接留用，表达式解析成 AST（只解析一次，
 * 逐点求值时复用，避免每个采样点重复解析）。
 * @returns {{fields:object, expressions:object, errors:string[]}}
 */
export function compileParamSpec(param) {
  const fields = {}
  const expressions = {}
  const errors = []
  for (const f of SPEC_FIELDS) {
    const raw = param ? param[f] : undefined
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      fields[f] = { kind: 'num', value: raw }
      continue
    }
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      fields[f] = { kind: 'missing' }
      errors.push(`${f} 未配置`)
      continue
    }
    const src = String(raw).trim()
    const parsed = parseExpr(src)
    if (!parsed.ok) {
      fields[f] = { kind: 'invalid', error: parsed.error }
      errors.push(`${f} 表达式无效：${parsed.error}`)
      continue
    }
    // 不含列名的表达式（"25" / "(24+26)/2"）不需要数据行，编译期即可定值
    if (parsed.idents.length === 0) {
      const ev = evalExpr(parsed.ast, () => undefined)
      if (ev.ok) {
        fields[f] = { kind: 'num', value: ev.value }
      } else {
        fields[f] = { kind: 'invalid', error: ev.error }
        errors.push(`${f} 表达式无效：${ev.error}`)
      }
      continue
    }
    fields[f] = { kind: 'expr', src, ast: parsed.ast, idents: parsed.idents }
    expressions[f] = src
  }
  return { fields, expressions, errors }
}

/** 该规格字段是否需要按数据行求值（即写成了含列名的表达式） */
export function specFieldIsExpr(compiled, field) {
  const f = compiled && compiled.fields ? compiled.fields[field] : null
  return Boolean(f && f.kind === 'expr')
}

/** 规格表达式引用到的全部列名（去重）。用于宽表自动并入 {{columns}} 与试算提示 */
export function specReferencedColumns(compiled) {
  const out = []
  for (const f of SPEC_FIELDS) {
    const fd = compiled && compiled.fields ? compiled.fields[f] : null
    if (!fd || fd.kind !== 'expr') continue
    for (const id of fd.idents) if (!out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 按某一个数据行求值，得到「这一行」的规格数值。
 * 任何一项取不到就整体 ok=false 并给出可读原因（调用方据此降级为「未知」，而不是硬算）。
 */
export function resolveCompiledSpec(compiled, row) {
  const spec = {}
  const errors = []
  for (const f of SPEC_FIELDS) {
    const fd = compiled && compiled.fields ? compiled.fields[f] : null
    if (!fd || fd.kind === 'missing') { errors.push(`${f} 未配置`); continue }
    if (fd.kind === 'invalid') { errors.push(`${f} 表达式无效：${fd.error}`); continue }
    if (fd.kind === 'num') { spec[f] = fd.value; continue }
    if (!row) {
      errors.push(`${f} 需要读取列 ${fd.idents.join('、')}，但当前没有可用的数据行`)
      continue
    }
    const ev = evalExpr(fd.ast, (name) => pickColumn(row, name))
    if (!ev.ok) { errors.push(`${f} 求值失败：${ev.error}`); continue }
    spec[f] = ev.value
  }
  return { ok: errors.length === 0, spec, errors, expressions: compiled ? compiled.expressions : {} }
}

/** 便捷入口：编译 + 按行求值（一次性，不含逐点复用） */
export function resolveParamSpec(param, row) {
  return resolveCompiledSpec(compileParamSpec(param), row)
}

/**
 * 点级超规格判定。**必须传入全量数据点**：计数与最坏点不能因降采样而失真。
 * 每个点用自己所在数据行的规格判定，因此「随行变化的规格」也能正确统计。
 */
export function evaluatePoints(compiled, points) {
  const list = Array.isArray(points) ? points : []
  // 没有表达式时规格恒定：解析一次即可，避免为每个点重复走一遍 6 个字段
  // （概览页有 200 个参数 × 上千个点，逐点重算是白费）。
  const hasExpr = SPEC_FIELDS.some((f) => specFieldIsExpr(compiled, f))
  const constant = hasExpr ? null : resolveCompiledSpec(compiled, undefined)
  const out = []
  let outOfSpec = 0
  let outLow = 0
  let outHigh = 0
  let worst = null
  for (const pt of list) {
    const spec = constant || resolveCompiledSpec(compiled, pt ? pt.rawRow : undefined)
    const lsl = spec.ok ? spec.spec.lsl : NaN
    const usl = spec.ok ? spec.spec.usl : NaN
    const v = pt ? pt.v : NaN
    let direction = 'unknown'
    let deviation = 0
    if (spec.ok && Number.isFinite(v)) {
      if (Number.isFinite(usl) && v > usl) {
        direction = 'high'
        deviation = v - usl
        outOfSpec++
        outHigh++
      } else if (Number.isFinite(lsl) && v < lsl) {
        direction = 'low'
        deviation = lsl - v
        outOfSpec++
        outLow++
      } else {
        direction = 'in'
      }
      if ((direction === 'high' || direction === 'low') && (worst === null || deviation > worst.deviation)) {
        worst = { t: pt.t, v, deviation, direction, lsl, usl }
      }
    }
    out.push({
      t: pt ? pt.t : NaN,
      v,
      lsl: Number.isFinite(lsl) ? lsl : null,
      usl: Number.isFinite(usl) ? usl : null,
      direction,
      deviation,
    })
  }
  return { n: out.length, outOfSpec, outLow, outHigh, worst, points: out }
}

/**
 * 展示用曲线点。规格写成列名表达式时按点带上各自解析出的 lsl/usl（阶梯规格带）；
 * 规格是固定数字时不下发逐点数值（前端直接用顶层 lsl/usl 画横线，省流量）。
 */
function buildSeries(pointSpecs, decimals, compiled, maxPoints) {
  const vary = specFieldIsExpr(compiled, 'lsl') || specFieldIsExpr(compiled, 'usl')
  return downsample(pointSpecs, maxPoints).map((p) => {
    const out = { t: p.t, v: roundTo(p.v, decimals) }
    if (vary) {
      if (Number.isFinite(p.lsl)) out.lsl = roundTo(p.lsl, decimals)
      if (Number.isFinite(p.usl)) out.usl = roundTo(p.usl, decimals)
      if (p.direction === 'low' || p.direction === 'high') out.direction = p.direction
    }
    return out
  })
}

/** 试算用：每个参数的规格表达式引用了哪些列、这些列是否真的出现在结果列里 */
function buildSpecColumnReport(params, columns) {
  const upper = (columns || []).map((c) => String(c).toUpperCase())
  const out = []
  for (const p of params) {
    const compiled = compileParamSpec(p)
    const cols = specReferencedColumns(compiled)
    if (cols.length === 0) continue
    out.push({
      code: p.code,
      expressions: compiled.expressions,
      columns: cols.map((c) => ({ name: c, present: upper.includes(c.toUpperCase()) })),
    })
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

/**
 * 把产生该点的原始数据行挂在点上，供规格表达式按行求值。
 * 定义为**不可枚举**属性：任何 JSON 序列化（接口响应、日志）都会自动忽略它，
 * 原始行数据不可能随曲线点泄漏到前端。
 */
function attachRow(point, row) {
  Object.defineProperty(point, 'rawRow', {
    value: row,
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return point
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
    map.get(code).push(attachRow({ t, v: value }, row))
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
      map.get(p.code).push(attachRow({ t, v: value }, row))
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
  const projectId = apcConfig.resolveProjectId(options.project)
  const cat = loadCatalog(false, projectId)
  const minutes = Math.max(1, Math.round(num(options.minutes, cat.defaultWindowMinutes)))
  const requested = Array.isArray(options.codes) && options.codes.length > 0
    ? options.codes.map((c) => String(c))
    : cat.params.map((p) => p.code)
  // 只允许目录内已定义的编码，杜绝任意编码进入 SQL
  const codes = requested.filter((c) => CODE_RE.test(c) && cat.params.some((p) => p.code === c))

  const readiness = getSourceReadiness(projectId)
  const mode = readiness.ready ? 'hana' : 'unconfigured'

  // 未就绪（无项目 / 未配 SQL 模板 / 数据库未配置连接）：不取数、更不造数，
  // 返回空序列 + 明确原因，由页面渲染空态引导。
  if (!readiness.ready) {
    return {
      mode,
      series: new Map(),
      queryMode: null,
      meta: {
        windowMinutes: minutes,
        sampleIntervalSec: cat.sampleIntervalSec,
        rowCount: 0,
        truncated: false,
        reason: readiness.reason,
        queryMode: null,
        warnings: [],
      },
    }
  }

  const maxRows = Math.max(50, Math.round(num(options.maxRows, Number(process.env.HANA_MAX_ROWS || 2000))))
  const selectedParams = cat.params.filter(p => codes.includes(p.code))

  // 按参数各自绑定的数据库槽位分组取数：dbSlot 缺省视为 db1。
  // 每个槽位独立一条连接 + 串行队列，两个系统的查询互不阻塞。
  // 某参数绑定的槽位未配置连接时，该参数本次无数据（绝不伪造）。
  const bySlot = new Map()
  for (const p of selectedParams) {
    const slotId = p.dbSlot === 'db2' ? 'db2' : 'db1'
    if (!bySlot.has(slotId)) bySlot.set(slotId, [])
    bySlot.get(slotId).push(p)
  }

  const cols = (cat.queries && cat.queries.columns) || {}
  const queryMode = (cat.queries && cat.queries.mode) || 'long'
  const series = new Map()
  let totalRows = 0
  let truncated = false
  const skippedSlots = []
  const usedSlots = []
  // 时间戳列没被取回来 → 折线图只能按序号铺点。记下具体列名，交给页面提示，避免再次静默塌成直线。
  const tsColumnMissing = new Set()

  for (const [slotId, slotParams] of bySlot) {
    if (!isDataSourceConfigured(slotId)) {
      // 该槽位未配置连接：这些参数本次返回空序列（不生成任何替代数据）
      skippedSlots.push(slotId)
      for (const p of slotParams) series.set(p.code, [])
      continue
    }
    usedSlots.push(slotId)
    const slotCodes = slotParams.map(p => p.code)
    const sql = buildHistorySql(cat, { minutes, limit: maxRows, codes: slotCodes, params: slotParams })
    const { rows, truncated: t } = await queryReadOnly(sql, { maxRows, slotId })
    totalRows += rows.length
    truncated = truncated || t
    const tsColumn = cols.ts || 'TS'
    if (rows.length > 0 && pickColumn(rows[0], tsColumn) === undefined) tsColumnMissing.add(tsColumn)
    const part = queryMode === 'wide'
      ? normalizeWideSeries(rows, tsColumn, slotParams)
      : normalizeSeries(rows, cols.code || 'PARAM_CODE', tsColumn, cols.value || 'VALUE')
    for (const [code, points] of part) series.set(code, points)
  }

  const warnings = []
  for (const col of tsColumnMissing) {
    warnings.push(`时间戳列 ${col} 未出现在取数结果中，趋势图将无法按时间展开（已回退为按采样点序号显示）。请在取数 SQL 的 SELECT 列表中加入该列。`)
  }

  return {
    mode,
    series,
    queryMode,
    warnings,
    meta: {
      windowMinutes: minutes,
      sampleIntervalSec: cat.sampleIntervalSec,
      rowCount: totalRows,
      truncated,
      usedSlots,
      skippedSlots,
      queryMode,
      warnings,
    },
  }
}

// ===== 按监测项取数（多对 1 调优的数据入口）=====

/**
 * CV 的规格编译源：把 output.spec 的 3 个字段补齐成 compileParamSpec 认识的 6 个。
 * - min/max 对 CV 没有意义（CV 不是被调量，不会去「调」它），补成 lsl/usl 只为通过编译；
 * - target 未配置时取规格中心 `(lsl + usl) / 2`——用**表达式字符串**拼接，
 *   这样 lsl/usl 本身是列名表达式时也能在运行期正确求值。
 */
function cvSpecSource(output) {
  const spec = (output && output.spec) || {}
  const lsl = spec.lsl
  const usl = spec.usl
  const hasTarget = !(spec.target === null || spec.target === undefined || String(spec.target).trim() === '')
  const asText = (v) => (typeof v === 'number' ? String(v) : `(${String(v)})`)
  const target = hasTarget ? spec.target : `(${asText(lsl)} + ${asText(usl)}) / 2`
  return { ...output, setpoint: target, optimalTarget: target, lsl, usl, min: lsl, max: usl }
}

/** 从宽表结果里抽某一列组成时间序列（一行一个点；原始行挂在点上但不可枚举） */
function extractColumnPoints(rows, tsColumn, column) {
  const out = []
  for (const row of rows) {
    const value = Number(pickColumn(row, column))
    if (!Number.isFinite(value)) continue
    let t = parseTimestamp(pickColumn(row, tsColumn))
    if (!Number.isFinite(t)) t = Date.now()
    out.push(attachRow({ t, v: value }, row))
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/**
 * 监测项就绪判定：项目存在 → 该监测项有取数 SQL → 项目绑定的数据库已配连接。
 * 三者缺一即「未就绪」，返回空结果 + 明确原因，**绝不伪造数据**。
 * @returns {{ready:boolean, reason:string, projectId:string, projectName:string, slot:string, itemId:string, itemName:string}}
 */
export function getItemReadiness(projectId, itemId) {
  const pid = apcConfig.resolveProjectId(projectId)
  const project = pid ? apcConfig.getProject(pid) : null
  const base = {
    projectId: pid || '',
    projectName: (project && project.name) || '',
    slot: (project && project.dbSlot) || 'db1',
    itemId: '',
    itemName: '',
  }
  if (!project) return { ...base, ready: false, reason: 'no-project' }
  const items = Array.isArray(project.items) ? project.items : []
  if (items.length === 0) return { ...base, ready: false, reason: 'no-item' }
  const wanted = String(itemId == null ? '' : itemId).trim()
  const item = (wanted && items.find(it => it && it.id === wanted)) || items[0]
  const withItem = { ...base, itemId: item.id, itemName: item.name }
  if (!(item.query && item.query.history)) return { ...withItem, ready: false, reason: 'no-template' }
  if (!isDataSourceConfigured(base.slot)) return { ...withItem, ready: false, reason: 'no-connection' }
  return { ...withItem, ready: true, reason: '' }
}

/**
 * 组装监测项的模板变量。
 * {{columns}} 必须同时展开：时间戳列 + 输出结果列 + 全部参与参数列 + 规格表达式引用列。
 * 少展开任何一列，运行期都会以「取不到值」的形式静默降级，所以这里宁可多展开也不要漏。
 */
export function buildItemTemplateVars(catalog, item, { minutes, limit }) {
  const cols = (item.query && item.query.columns) || {}
  const colNames = []
  const push = (name, label) => {
    const n = assertIdent(name, label)
    if (!colNames.some(c => c.toUpperCase() === n.toUpperCase())) colNames.push(n)
  }
  if (cols.ts) push(cols.ts, '时间戳列')
  push(item.output.column, `输出结果 ${item.output.code} 的数据列名`)
  for (const p of item.params || []) push(p.column, `参数 ${p.code} 的数据列名`)
  for (const ident of specReferencedColumns(compileParamSpec(cvSpecSource(item.output)))) {
    push(ident, `输出结果 ${item.output.code} 规格表达式引用的列名`)
  }
  return {
    minutes: String(Math.max(1, Math.round(minutes))),
    limit: String(Math.max(1, Math.round(limit))),
    schema: String((catalog && catalog.schema) || ''),
    codeFilter: '',
    columns: colNames.map(quoteIdent).join(', '),
  }
}

/** 按监测项渲染取数 SQL */
export function buildItemHistorySql(catalog, item, { minutes, limit }) {
  if (!item.query || !item.query.history) throw new Error(`监测项「${item.name}」未配置取数 SQL 模板`)
  return renderSqlTemplate(item.query.history, buildItemTemplateVars(catalog, item, { minutes, limit }))
}

/**
 * 拉取某个监测项窗口内的数据：**一条 SQL** 取回输出结果 CV 与全部参与参数 MV
 * （同一行的不同列——这正是宽表成为唯一取数模式的原因）。
 * @returns {Promise<{ready:boolean, reason:string, mode:string, output:object, params:object[], meta:object}>}
 */
export async function fetchItemSeries({ project, item, minutes, maxRows } = {}) {
  const projectId = apcConfig.resolveProjectId(project)
  const cat = loadCatalog(false, projectId)
  const readiness = getItemReadiness(projectId, item && item.id)
  const mins = Math.max(1, Math.round(num(minutes, cat.defaultWindowMinutes)))
  const slotId = readiness.slot === 'db2' ? 'db2' : 'db1'
  const resolvedItem = item || (() => {
    const p = apcConfig.getProject(projectId)
    const list = (p && p.items) || []
    return list.find(it => it.id === readiness.itemId) || list[0] || null
  })()

  if (!readiness.ready || !resolvedItem) {
    return {
      ready: false,
      reason: readiness.reason,
      mode: 'unconfigured',
      readiness,
      item: resolvedItem,
      output: { points: [], column: '' },
      params: [],
      queryMode: 'wide',
      meta: {
        windowMinutes: mins,
        sampleIntervalSec: cat.sampleIntervalSec,
        rowCount: 0,
        truncated: false,
        reason: readiness.reason,
        queryMode: 'wide',
        warnings: [],
      },
    }
  }

  const cap = Math.max(50, Math.round(num(maxRows, Number(process.env.HANA_MAX_ROWS || 2000))))
  const sql = buildItemHistorySql(cat, resolvedItem, { minutes: mins, limit: cap })
  const { rows, truncated } = await queryReadOnly(sql, { maxRows: cap, slotId })

  const tsColumn = (resolvedItem.query.columns && resolvedItem.query.columns.ts) || 'TS'
  const warnings = []
  if (rows.length > 0 && pickColumn(rows[0], tsColumn) === undefined) {
    warnings.push(
      `时间戳列 ${tsColumn} 未出现在取数结果中，趋势图将无法按时间展开（已回退为按采样点序号显示）。` +
      '请在取数 SQL 的 SELECT 列表中加入该列。'
    )
  }
  // 规格表达式引用的列是否真的取回来了：不取回必然求值失败，提前说清楚，
  // 好过让使用者对着页面上的「未知」猜原因。
  const specMissing = specReferencedColumns(compileParamSpec(cvSpecSource(resolvedItem.output)))
    .filter(name => rows.length > 0 && pickColumn(rows[0], name) === undefined)
  if (specMissing.length > 0) {
    warnings.push(
      `输出结果 ${resolvedItem.output.code} 的规格表达式引用了未出现在结果列中的「${specMissing.join('、')}」，规格将无法判定。`
    )
  }

  return {
    ready: true,
    reason: '',
    mode: 'hana',
    readiness,
    item: resolvedItem,
    output: {
      points: extractColumnPoints(rows, tsColumn, resolvedItem.output.column),
      column: resolvedItem.output.column,
    },
    params: (resolvedItem.params || []).map((p) => ({
      param: p,
      points: extractColumnPoints(rows, tsColumn, p.column),
    })),
    queryMode: 'wide',
    meta: {
      windowMinutes: mins,
      sampleIntervalSec: cat.sampleIntervalSec,
      rowCount: rows.length,
      truncated,
      usedSlots: [slotId],
      queryMode: 'wide',
      warnings,
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
  const latest = values.length > 0 ? values[values.length - 1] : NaN
  const slope = linearSlope(values)
  const decimals = param.decimals

  // 规格可以写成「取数结果列名表达式」（如 USL_COL - 1）：编译一次后按数据行求值。
  // 窗口级判定统一用**最新一行**的规格；点级判定逐点用各自所在行（evaluatePoints）。
  const compiled = compileParamSpec(param)
  const lastRow = points.length > 0 ? points[points.length - 1].rawRow : undefined
  const specRow = opts.specRow !== undefined ? opts.specRow : lastRow
  const spec = resolveCompiledSpec(compiled, specRow)
  const pointDev = evaluatePoints(compiled, points)
  const sparkPoints = opts.sparkPoints || 60

  const specResolved = {
    ok: spec.ok,
    errors: spec.errors,
    expressions: compiled.expressions,
    columns: specReferencedColumns(compiled),
  }
  const pointDeviation = {
    n: pointDev.n,
    outOfSpec: pointDev.outOfSpec,
    outLow: pointDev.outLow,
    outHigh: pointDev.outHigh,
    worst: pointDev.worst
      ? {
        t: pointDev.worst.t,
        v: roundTo(pointDev.worst.v, decimals),
        lsl: roundTo(pointDev.worst.lsl, decimals),
        usl: roundTo(pointDev.worst.usl, decimals),
        deviation: roundTo(pointDev.worst.deviation, decimals),
        direction: pointDev.worst.direction,
      }
      : null,
  }
  const common = {
    code: param.code,
    name: param.name,
    process: param.process,
    unit: param.unit,
    decimals,
    objective: param.objective,
    objectiveLabel: OBJECTIVE_LABEL[param.objective] || '综合',
    maxStepPct: param.maxStepPct,
    latest: Number.isFinite(latest) ? roundTo(latest, decimals) : null,
    mean: Number.isFinite(stats.mean) ? roundTo(stats.mean, decimals) : null,
    std: Number.isFinite(stats.std) ? roundTo(stats.std, Math.min(4, decimals + 2)) : null,
    min_: Number.isFinite(stats.min) ? roundTo(stats.min, decimals) : null,
    max_: Number.isFinite(stats.max) ? roundTo(stats.max, decimals) : null,
    sampleCount: stats.n,
    slope: roundTo(slope, Math.min(4, decimals + 3)),
    trend: trendOf(slope, stats.std),
    specResolved,
    pointDeviation,
    series: buildSeries(pointDev.points, decimals, compiled, sparkPoints),
  }

  // ---- 规格确定不了（表达式引用的列没取回来 / 写法有误）----
  // 不做任何判定，明确降级为「未知」。绝不拿 NaN 硬算出「正常」「保持」这类会误导现场的结论。
  if (!spec.ok) {
    return {
      ...common,
      setpoint: null,
      optimalTarget: null,
      min: null,
      max: null,
      lsl: null,
      usl: null,
      cpk: null,
      status: 'unknown',
      recommendation: {
        current: null,
        suggested: null,
        delta: 0,
        deltaPct: null,
        confidence: 0,
        urgency: 'none',
        hold: true,
        clampedBy: null,
        predictedMean: null,
        predictedCpk: null,
        reason:
          `规格未能确定，本次不做优化判定：${spec.errors.join('；')}。` +
          '请在「APC 和 RTO → 数据源配置 → 参数配置」检查规格表达式引用的列名是否已出现在取数 SQL 的结果列中。',
        risk: '',
      },
    }
  }

  // 规格已确定：把解析出的数值覆盖到参数定义上，后续沿用原有优化逻辑
  param = { ...param, ...spec.spec }

  const sigmaSpec = specSigma(param)
  const cpk = computeCpk(param, stats.mean, stats.std)
  const status = statusOf(param, stats)
  const trend = common.trend

  const base = {
    ...common,
    setpoint: param.setpoint,
    optimalTarget: param.optimalTarget,
    min: param.min,
    max: param.max,
    lsl: param.lsl,
    usl: param.usl,
    cpk: cpk == null ? null : roundTo(cpk, 2),
    status,
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

// ===== 多对 1 加权求解 =====
//
// 给定输出结果 CV 的偏差 ΔCV = 理想点 − 实测均值，求各参与参数 MV 的调整量 ΔMVᵢ：
//     min  Σ wᵢ · (ΔMVᵢ / sᵢ)²           ← 归一化后的「最小调整」
//     s.t. Σ kᵢ · ΔMVᵢ = ΔCV             ← 必须把偏差补回来
// 其中 sᵢ = 量程 (max − min)，用于让「1 g」与「1 %」可比；wᵢ 是调整阻力（越大越不愿动）。
//
// 拉格朗日闭式解：
//     ΔMVᵢ = (kᵢ·sᵢ²/wᵢ) · ΔCV / Σⱼ (kⱼ²·sⱼ²/wⱼ)
//
// N = 1 时退化为 ΔMV = ΔCV / k —— 与改造前的单回路公式逐字一致，这就是老项目
// 迁移后行为不变的数学依据。语义上：kᵢsᵢ²/wᵢ 大的参数（影响大、量程宽、不愿动指数低）
// 承担更多份额。

const K_EPS = 1e-12

/** 参数未能参与本次求解的原因（要能直接展示给现场看） */
function excludeReason(c) {
  if (!c.enabled) return '已停用'
  if (!c.hasData) return '本次未取到有效数据'
  if (!Number.isFinite(c.k) || Math.abs(c.k) < K_EPS) return '影响系数 k 未标定（为 0）'
  return ''
}

/**
 * 单监测项的多对 1 优化建议（纯函数：只吃数据，不碰 IO，可单测）。
 * @param {object} item    监测项（含 output / params / tuning）
 * @param {object} series  fetchItemSeries 的结果（output.points + params[].points）
 */
export function optimizeItem(item, series, opts = {}) {
  const output = item.output
  const tuning = item.tuning || {}
  const decimals = num(output.decimals, 3)
  const cvPoints = (series && series.output && series.output.points) || []
  const cvValues = cvPoints.map(p => p.v).filter(v => Number.isFinite(v))
  const stats = basicStats(cvValues)
  const latest = cvValues.length > 0 ? cvValues[cvValues.length - 1] : NaN
  const slope = linearSlope(cvValues)
  const sparkPoints = opts.sparkPoints || 60

  const compiled = compileParamSpec(cvSpecSource(output))
  const lastRow = cvPoints.length > 0 ? cvPoints[cvPoints.length - 1].rawRow : undefined
  const spec = resolveCompiledSpec(compiled, lastRow)
  const pointDev = evaluatePoints(compiled, cvPoints)

  const specResolved = {
    ok: spec.ok,
    errors: spec.errors,
    expressions: compiled.expressions,
    columns: specReferencedColumns(compiled),
  }
  const pointDeviation = {
    n: pointDev.n,
    outOfSpec: pointDev.outOfSpec,
    outLow: pointDev.outLow,
    outHigh: pointDev.outHigh,
    worst: pointDev.worst
      ? {
        t: pointDev.worst.t,
        v: roundTo(pointDev.worst.v, decimals),
        lsl: roundTo(pointDev.worst.lsl, decimals),
        usl: roundTo(pointDev.worst.usl, decimals),
        deviation: roundTo(pointDev.worst.deviation, decimals),
        direction: pointDev.worst.direction,
      }
      : null,
  }

  const common = {
    code: output.code,
    name: output.name,
    unit: output.unit,
    decimals,
    objective: output.objective,
    objectiveLabel: OBJECTIVE_LABEL[output.objective] || '综合',
    latest: Number.isFinite(latest) ? roundTo(latest, decimals) : null,
    mean: Number.isFinite(stats.mean) ? roundTo(stats.mean, decimals) : null,
    std: Number.isFinite(stats.std) ? roundTo(stats.std, Math.min(4, decimals + 2)) : null,
    min_: Number.isFinite(stats.min) ? roundTo(stats.min, decimals) : null,
    max_: Number.isFinite(stats.max) ? roundTo(stats.max, decimals) : null,
    sampleCount: stats.n,
    slope: roundTo(slope, Math.min(4, decimals + 3)),
    trend: trendOf(slope, stats.std),
    specResolved,
    pointDeviation,
    series: buildSeries(pointDev.points, decimals, compiled, sparkPoints),
    tuning: {
      deadbandPct: num(tuning.deadbandPct, 10),
      maxRounds: num(tuning.maxRounds, 2),
      residualTolerancePct: num(tuning.residualTolerancePct, 5),
    },
  }

  // ---- 规格确定不了（表达式引用的列没取回来 / 写法有误）----
  // 不做任何判定，明确降级为「未知」。绝不拿 NaN 硬算出「正常」「保持」这类会误导现场的结论。
  if (!spec.ok) {
    return {
      ...common,
      target: null, lsl: null, usl: null, cpk: null, status: 'unknown',
      moves: [],
      recommendation: {
        cv: { current: null, target: null, delta: null },
        moves: [],
        predictedCV: null, residual: null, residualPct: null,
        confidence: 0, urgency: 'none', hold: true, rounds: 0, clampedBy: null,
        reason:
          `输出结果的规格未能确定，本次不做优化判定：${spec.errors.join('；')}。` +
          '请在「APC 和 RTO → 数据源配置 → 监测项」检查规格表达式引用的列名是否已出现在取数 SQL 的结果列中。',
        risk: '',
      },
    }
  }

  const lsl = spec.spec.lsl
  const usl = spec.spec.usl
  const target = Number.isFinite(spec.spec.optimalTarget) ? spec.spec.optimalTarget : (lsl + usl) / 2
  const width = usl - lsl
  const resolvedOut = { ...output, lsl, usl }
  const cpk = computeCpk(resolvedOut, stats.mean, stats.std)
  const status = statusOf(resolvedOut, stats)
  const base = {
    ...common,
    target: roundTo(target, decimals),
    lsl: roundTo(lsl, decimals),
    usl: roundTo(usl, decimals),
    cpk: cpk == null ? null : roundTo(cpk, 2),
    status,
  }

  // ---- 参与参数的现状与杠杆份额 ----
  const seriesParams = (series && series.params) || []
  const candidates = seriesParams.map((sp) => {
    const p = sp.param
    const values = (sp.points || []).map(pt => pt.v).filter(v => Number.isFinite(v))
    const mean = values.length > 0 ? basicStats(values).mean : NaN
    const span = Math.abs(num(p.max, 0) - num(p.min, 0))
    const w = Math.max(WEIGHT_MIN, num(p.weight, 1))
    const k = p.k ? num(p.k.value, 0) : 0
    // 工作点：优先用配置的「当前设定值」——现场真正能拧的就是它；
    // 未配置时退回该参数窗口内的实测均值。老配置迁移来的项都带设定值，
    // 因此建议值与改造前一致；新建的多对 1 监测项通常把取数列当设定值用，直接取均值即可。
    // 注意 Number(null) === 0：留空必须被识别为「未配置」，否则会被当作设定值 0
    const rawSetpoint = p.setpoint
    const configured = (rawSetpoint === null || rawSetpoint === undefined || rawSetpoint === '')
      ? null
      : (Number.isFinite(num(rawSetpoint, NaN)) ? num(rawSetpoint, NaN) : null)
    return {
      param: p,
      values,
      current: configured !== null ? configured : mean,
      currentSource: configured !== null ? 'setpoint' : 'mean',
      span, w, k,
      leverage: (k * k * span * span) / w,
      enabled: p.enabled !== false,
      hasData: Number.isFinite(mean) && span > 0,
    }
  })
  const isActive = c => c.enabled && c.hasData && Number.isFinite(c.k) && Math.abs(c.k) >= K_EPS
  const active = candidates.filter(isActive)
  const excluded = candidates.filter(c => !isActive(c))
  const sumLev = active.reduce((a, c) => a + c.leverage, 0)

  // 正 = 实测偏低，需要把 CV 抬上去
  const deltaCV = target - stats.mean

  const maxRounds = Math.max(0, Math.min(5, Math.round(num(tuning.maxRounds, 2))))
  const totals = new Map(candidates.map(c => [c.param.code, 0]))
  const limitsHit = new Map()

  // ---- 数据不足：只观察，不给激进建议 ----
  const MIN_SAMPLES = 8
  if (stats.n < MIN_SAMPLES) {
    return {
      ...base,
      moves: [],
      recommendation: {
        cv: {
          current: Number.isFinite(stats.mean) ? roundTo(stats.mean, decimals) : null,
          target: roundTo(target, decimals),
          delta: Number.isFinite(stats.mean) ? roundTo(deltaCV, decimals) : null,
        },
        moves: [],
        predictedCV: Number.isFinite(stats.mean) ? roundTo(stats.mean, decimals) : null,
        residual: null, residualPct: null,
        confidence: 30, urgency: 'none', hold: true, rounds: 0, clampedBy: null,
        reason: `窗口内仅 ${stats.n} 个有效数据点（需 ≥ ${MIN_SAMPLES} 个），样本不足无法可靠估计过程状态，建议保持现状并继续采集数据。`,
        risk: '',
      },
    }
  }

  // ---- 死区 / 无可用参数 ----
  const deadbandPct = num(tuning.deadbandPct, 10)
  const deadband = width * (deadbandPct / 100)
  const inDeadband = status === 'normal' && Math.abs(deltaCV) <= deadband
  const noActive = active.length === 0 || !(sumLev > K_EPS)

  if (inDeadband || noActive) {
    const why = inDeadband
      ? `偏差 ${roundTo(Math.abs(deltaCV), decimals)}${output.unit} 处于工艺死区内（±${roundTo(deadband, decimals)}${output.unit}，为规格带宽的 ${deadbandPct}%）且过程能力正常，调整收益低于扰动成本，建议保持。`
      : active.length === 0
        ? `没有可参与求解的参数：${excluded.map(c => `${c.param.name}（${excludeReason(c)}）`).join('、') || '尚未配置参与参数'}。请先在监测项里添加参与参数并填写影响系数 k。`
        : '各参数的影响系数均为 0，无法建立「参数变化 → 输出变化」的关系，建议先完成 k 的标定。'
    return {
      ...base,
      moves: candidates.map((c) => ({
        code: c.param.code, name: c.param.name, unit: c.param.unit,
        decimals: num(c.param.decimals, 3),
        current: Number.isFinite(c.current) ? roundTo(c.current, num(c.param.decimals, 3)) : null,
        suggested: Number.isFinite(c.current) ? roundTo(c.current, num(c.param.decimals, 3)) : null,
        delta: 0, deltaPct: 0,
        min: c.param.min, max: c.param.max, span: roundTo(c.span, 3),
        weight: c.w, k: c.k, kMode: c.param.k ? c.param.k.mode : 'manual',
        leverage: roundTo(c.leverage, 6),
        share: 0, clampedBy: null,
        participating: isActive(c),
        excludedReason: isActive(c) ? '' : excludeReason(c),
      })),
      recommendation: {
        cv: {
          current: roundTo(stats.mean, decimals),
          target: roundTo(target, decimals),
          delta: roundTo(deltaCV, decimals),
        },
        moves: [],
        predictedCV: roundTo(stats.mean, decimals),
        residual: roundTo(deltaCV, decimals),
        residualPct: 100,
        confidence: noActive ? 30 : 45,
        urgency: 'none',
        hold: true,
        rounds: 0,
        clampedBy: null,
        reason: `${why}输出结果均值 ${common.mean}${output.unit}，Cpk=${cpk == null ? '—' : roundTo(cpk, 2)}（${statusLabel(status)}）。`,
        risk: status === 'danger' ? '当前过程能力不足，建议先排查工艺而非只调参数。' : '',
      },
    }
  }

  // ---- 迭代求解：加权分摊 → 施加约束 → 把未消除的部分再分摊给未顶限的参数 ----
  let remaining = deltaCV
  let rounds = 0
  for (let r = 0; r <= maxRounds; r++) {
    if (Math.abs(remaining) <= Math.max(K_EPS, Math.abs(deltaCV) * 1e-4)) break
    const pool = active.filter(c => !limitsHit.has(c.param.code))
    if (pool.length === 0) break
    const poolLev = pool.reduce((a, c) => a + c.leverage, 0)
    if (!(poolLev > K_EPS)) break

    let produced = 0
    for (const c of pool) {
      const p = c.param
      const already = totals.get(p.code) || 0
      const from = c.current + already
      const raw = ((c.k * c.span * c.span) / c.w) * remaining / poolLev

      // ③ 量程裁剪（相对「本轮起点」）
      const lo = num(p.min, -Infinity) - from
      const hi = num(p.max, Infinity) - from
      let d = Math.max(lo, Math.min(hi, raw))
      let clamped = null
      if (Math.abs(d - raw) > 1e-12) clamped = raw > hi ? 'max' : 'min'

      // ④ 单次幅度限幅：基准取当前值；当前值≈0 时退回量程，
      //    否则 |0| × 百分比 = 0 会让参数永远动不了。
      const stepBase = Math.abs(from) > 1e-9 ? Math.abs(from) : c.span
      const stepCap = stepBase * (num(p.maxStepPct, 3) / 100)
      if (Math.abs(d) > stepCap) {
        d = Math.sign(d) * stepCap
        clamped = clamped || 'step'
      }

      // ⑤ 量化到该参数的最小调节步长
      const dec = num(p.decimals, 3)
      const q = Math.pow(10, -dec)
      d = Math.round(d / q) * q
      if (Math.abs(d) < q / 2) d = 0

      totals.set(p.code, already + d)
      produced += c.k * d
      if (clamped && Math.abs(d) > 1e-12) limitsHit.set(p.code, clamped)
    }

    // 本轮一点都没推动（参数全被顶死）→ 立即停止，避免空转
    if (Math.abs(produced) <= Math.max(1e-12, Math.abs(remaining) * 1e-6)) break
    remaining -= produced
    rounds = r + 1
  }

  const applied = active.reduce((a, c) => a + c.k * (totals.get(c.param.code) || 0), 0)
  const predictedCV = stats.mean + applied
  const residual = remaining
  const residualPct = Math.abs(deltaCV) > K_EPS ? (Math.abs(residual) / Math.abs(deltaCV)) * 100 : 0
  const residualTol = num(tuning.residualTolerancePct, 5)

  const moves = candidates.map((c) => {
    const p = c.param
    const d = num(p.decimals, 3)
    const delta = totals.get(p.code) || 0
    const has = Number.isFinite(c.current)
    return {
      code: p.code, name: p.name, unit: p.unit, decimals: d,
      current: has ? roundTo(c.current, d) : null,
      suggested: has ? roundTo(c.current + delta, d) : null,
      delta: roundTo(delta, d),
      deltaPct: has && Math.abs(c.current) > 1e-9 ? roundTo((delta / Math.abs(c.current)) * 100, 2) : null,
      min: p.min, max: p.max,
      span: roundTo(c.span, d),
      weight: c.w, k: c.k, kMode: p.k ? p.k.mode : 'manual',
      leverage: roundTo(c.leverage, 6),
      share: Math.abs(deltaCV) > K_EPS ? roundTo(Math.abs(c.k * delta) / Math.abs(deltaCV), 3) : 0,
      clampedBy: limitsHit.get(p.code) || null,
      participating: isActive(c),
      excludedReason: isActive(c) ? '' : excludeReason(c),
    }
  })

  const movers = moves.filter(m => m.delta !== 0)
  const keep = movers.length === 0

  // ---- 置信度：样本量、过程能力、标定来源、约束松紧 ----
  let confidence = 50
  confidence += Math.min(20, (stats.n / 60) * 20)
  if (cpk == null || cpk < 1.0) confidence -= 12
  const sigmaSpec = specSigma(resolvedOut)
  const noiseRatio = sigmaSpec > 0 ? stats.std / sigmaSpec : 0
  if (noiseRatio > 0.6) confidence -= 10
  else if (noiseRatio < 0.25) confidence += 8
  const calibratedCount = active.filter(c => c.param.k && c.param.k.mode === 'calibrated').length
  if (active.length > 0) confidence += Math.round((calibratedCount / active.length) * 12)
  else confidence -= 10
  if (limitsHit.size > 0) confidence -= 6
  if (residualPct > residualTol) confidence -= 5
  confidence = Math.max(30, Math.min(95, Math.round(confidence)))

  // ---- 紧急度：按 CV 偏差占规格带宽的比例 ----
  const relDev = width > 0 ? Math.abs(deltaCV) / width : 0
  let urgency = 'none'
  if (!keep) urgency = (status === 'danger' || relDev >= 0.3) ? 'high' : relDev >= 0.1 ? 'medium' : 'low'

  // ---- 中文理由 ----
  const parts = []
  parts.push(
    `近 ${base.sampleCount} 个采样点，输出结果「${output.name}」均值 ${base.mean}${output.unit}，` +
    `相对 RTO 理想点 ${base.target}${output.unit} ${deltaCV >= 0 ? '偏低' : '偏高'} ` +
    `${roundTo(Math.abs(deltaCV), decimals)}${output.unit}` +
    `（占规格带宽 ${width > 0 ? roundTo((Math.abs(deltaCV) / width) * 100, 1) : '—'}%）`
  )
  parts.push(`波动 σ=${base.std}，过程能力 Cpk=${cpk == null ? '—' : roundTo(cpk, 2)}（${statusLabel(status)}）`)
  if (keep) {
    parts.push('各参数按加权最小调整解出的修正量均小于其最小调节步长，建议保持现状')
  } else {
    parts.push(
      `按影响系数把偏差分摊给 ${movers.length} 个参数：` +
      movers.map(m => `${m.name} ${m.current}→${m.suggested}${m.unit}` +
        `（${m.delta > 0 ? '上调' : '下调'} ${Math.abs(m.delta)}${m.unit}，承担 ${Math.round(m.share * 100)}%）`).join('；')
    )
    if (rounds > 1) parts.push(`其中 ${rounds - 1} 轮用于把触及约束的部分重新分摊给未顶限的参数`)
    parts.push(`预计调整后均值回落到 ${roundTo(predictedCV, decimals)}${output.unit}`)
  }
  if (excluded.length > 0) {
    parts.push(`未参与本次求解：${excluded.map(c => `${c.param.name}（${excludeReason(c)}）`).join('、')}`)
  }
  const reason = parts.join('；') + '。'

  // ---- 风险提示：约束可能同时生效，逐条说明避免信息丢失 ----
  const riskNotes = []
  if (status === 'danger') riskNotes.push('当前过程能力不足，存在批量超规格风险，建议优先处理')
  for (const [code, why] of limitsHit) {
    const m = moves.find(x => x.code === code)
    const label = m ? m.name : code
    const what = why === 'max' ? '可调上限' : why === 'min' ? '可调下限' : '单次调整幅度上限'
    riskNotes.push(`${label} 受${what}约束，未能足额调整`)
  }
  if (residualPct > residualTol) {
    riskNotes.push(
      `受约束限制，预计仍有 ${roundTo(Math.abs(residual), decimals)}${output.unit}` +
      `（约 ${roundTo(residualPct, 1)}%）偏差无法消除，需评估工艺窗口或上游条件`
    )
  }
  const risk = riskNotes.length > 0 ? `${riskNotes.join('；')}。` : ''

  return {
    ...base,
    moves,
    recommendation: {
      cv: {
        current: roundTo(stats.mean, decimals),
        target: roundTo(target, decimals),
        delta: roundTo(deltaCV, decimals),
      },
      moves: movers,
      predictedCV: roundTo(predictedCV, decimals),
      residual: roundTo(residual, decimals),
      residualPct: roundTo(residualPct, 1),
      confidence,
      urgency,
      hold: keep,
      rounds,
      clampedBy: limitsHit.size > 0 ? [...new Set(limitsHit.values())].join(',') : null,
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

/**
 * 监测项概览：1 个输出结果 CV 的当前值 / 统计量 / 趋势 / 状态 / 建议，
 * 以及 N 个参与参数各自的工作点与建议调整量。
 * 未配置数据源时返回空态（output 为 null）+ 原因，页面据此渲染引导。
 */
export async function getOverview({ minutes, project, item } = {}) {
  const projectId = apcConfig.resolveProjectId(project)
  const cat = loadCatalog(false, projectId)
  const ttl = cacheTtl()
  const key = `overview:${projectId}:${item || 'default'}:${minutes || 'default'}`
  const loader = async () => {
    const started = Date.now()
    const readiness = getItemReadiness(projectId, item)
    const proj = apcConfig.getProject(projectId)
    const items = (proj && proj.items) || []
    const target = items.find(it => it.id === readiness.itemId) || null
    const base = {
      project: projectId,
      projectName: (proj && proj.name) || '',
      item: target ? { id: target.id, name: target.name, description: target.description || '' } : null,
      // 供前端渲染监测项选择器：只给 id 与名称，不把整份配置塞进运行接口
      items: items.map(it => ({ id: it.id, name: it.name })),
      windowMinutes: Math.max(1, Math.round(num(minutes, cat.defaultWindowMinutes))),
      sampleIntervalSec: cat.sampleIntervalSec,
      generatedAt: new Date().toISOString(),
      warnings: [],
    }

    if (!readiness.ready || !target) {
      return {
        ...base,
        mode: 'unconfigured',
        ready: false,
        reason: readiness.reason,
        readiness,
        station: '',
        elapsedMs: Date.now() - started,
        rowCount: 0,
        truncated: false,
        source: describeSource('unconfigured', { reason: readiness.reason }),
        output: null,
      }
    }

    const data = await fetchItemSeries({ project: projectId, item: target, minutes })
    return {
      ...base,
      mode: 'hana',
      ready: true,
      reason: '',
      readiness,
      station: cat.station,
      elapsedMs: Date.now() - started,
      windowMinutes: data.meta.windowMinutes,
      sampleIntervalSec: data.meta.sampleIntervalSec,
      rowCount: data.meta.rowCount,
      truncated: data.meta.truncated,
      source: describeSource('hana', data.meta),
      warnings: data.meta.warnings || [],
      output: optimizeItem(target, data, { sparkPoints: 60 }),
    }
  }
  if (ttl <= 0) return loader()
  return withCache(key, ttl, loader)
}

/** 优化建议：复用概览（同一份数据、同一份缓存），只把建议相关字段提到顶层 */
export async function getOptimization({ minutes, project, item } = {}) {
  const overview = await getOverview({ minutes, project, item })
  const out = overview.output
  return {
    project: overview.project,
    projectName: overview.projectName,
    item: overview.item,
    items: overview.items,
    station: overview.station,
    mode: overview.mode,
    ready: overview.ready,
    reason: overview.reason,
    generatedAt: overview.generatedAt,
    windowMinutes: overview.windowMinutes,
    source: overview.source,
    warnings: overview.warnings,
    output: out,
    recommendation: out ? out.recommendation : null,
    moves: out ? out.moves : [],
  }
}

/** 单条曲线（输出结果 CV 或任一参与参数），供详情面板 */
export async function getHistory({ code, minutes, project, item } = {}) {
  const projectId = apcConfig.resolveProjectId(project)
  const cat = loadCatalog(false, projectId)
  const readiness = getItemReadiness(projectId, item)
  const ttl = cacheTtl()
  const key = `history:${projectId}:${readiness.itemId}:${code || ''}:${minutes || 'default'}`
  const loader = async () => {
    const proj = apcConfig.getProject(projectId)
    const target = ((proj && proj.items) || []).find(it => it.id === readiness.itemId) || null
    if (!readiness.ready || !target) {
      return {
        ready: false,
        mode: 'unconfigured',
        reason: readiness.reason,
        item: target ? { id: target.id, name: target.name } : null,
        windowMinutes: Math.max(1, Math.round(num(minutes, cat.defaultWindowMinutes))),
        param: null,
        points: [],
        stats: null,
      }
    }

    const data = await fetchItemSeries({ project: projectId, item: target, minutes })
    const wanted = String(code || '').trim()
    const isCv = !wanted || wanted === target.output.code
    const member = isCv ? null : (target.params || []).find(p => p.code === wanted)
    if (!isCv && !member) {
      const err = new Error(`监测项「${target.name}」下未找到输出结果或参与参数：${wanted}`)
      err.status = 404
      throw err
    }

    const points = isCv
      ? data.output.points
      : (data.params.find(sp => sp.param.code === wanted) || { points: [] }).points
    const decimals = num(isCv ? target.output.decimals : member.decimals, 3)
    const values = points.map(p => p.v).filter(v => Number.isFinite(v))
    const stats = basicStats(values)
    const slope = linearSlope(values)

    // 规格只对输出结果有意义（参与参数没有规格带）
    const compiled = isCv ? compileParamSpec(cvSpecSource(target.output)) : null
    const lastRow = points.length > 0 ? points[points.length - 1].rawRow : undefined
    const spec = compiled ? resolveCompiledSpec(compiled, lastRow) : { ok: false, spec: {}, errors: [] }
    const pointDev = compiled ? evaluatePoints(compiled, points) : { points: [], n: 0, outOfSpec: 0, outLow: 0, outHigh: 0, worst: null }
    const resolved = spec.ok ? { ...target.output, lsl: spec.spec.lsl, usl: spec.spec.usl } : target.output
    const varySpec = compiled ? (specFieldIsExpr(compiled, 'lsl') || specFieldIsExpr(compiled, 'usl')) : false

    return {
      ready: true,
      mode: 'hana',
      reason: '',
      item: { id: target.id, name: target.name },
      windowMinutes: data.meta.windowMinutes,
      source: describeSource('hana', data.meta),
      warnings: data.meta.warnings || [],
      isOutput: isCv,
      param: {
        code: isCv ? target.output.code : member.code,
        name: isCv ? target.output.name : member.name,
        unit: isCv ? target.output.unit : member.unit,
        decimals,
        target: isCv && spec.ok
          ? roundTo(Number.isFinite(spec.spec.optimalTarget) ? spec.spec.optimalTarget : (spec.spec.lsl + spec.spec.usl) / 2, decimals)
          : null,
        lsl: isCv && spec.ok ? roundTo(spec.spec.lsl, decimals) : null,
        usl: isCv && spec.ok ? roundTo(spec.spec.usl, decimals) : null,
        min: isCv ? null : member.min,
        max: isCv ? null : member.max,
      },
      specResolved: {
        ok: spec.ok,
        errors: spec.errors,
        expressions: compiled ? compiled.expressions : {},
        columns: compiled ? specReferencedColumns(compiled) : [],
      },
      pointDeviation: {
        n: pointDev.n,
        outOfSpec: pointDev.outOfSpec,
        outLow: pointDev.outLow,
        outHigh: pointDev.outHigh,
        worst: pointDev.worst
          ? {
            t: pointDev.worst.t,
            v: roundTo(pointDev.worst.v, decimals),
            lsl: roundTo(pointDev.worst.lsl, decimals),
            usl: roundTo(pointDev.worst.usl, decimals),
            deviation: roundTo(pointDev.worst.deviation, decimals),
            direction: pointDev.worst.direction,
          }
          : null,
      },
      stats: {
        n: stats.n,
        mean: Number.isFinite(stats.mean) ? roundTo(stats.mean, decimals) : null,
        std: Number.isFinite(stats.std) ? roundTo(stats.std, Math.min(4, decimals + 2)) : null,
        min: Number.isFinite(stats.min) ? roundTo(stats.min, decimals) : null,
        max: Number.isFinite(stats.max) ? roundTo(stats.max, decimals) : null,
        cpk: isCv && spec.ok ? (() => {
          const c = computeCpk(resolved, stats.mean, stats.std)
          return c == null ? null : roundTo(c, 2)
        })() : null,
        trend: trendOf(slope, stats.std),
        status: isCv && spec.ok ? statusOf(resolved, stats) : 'unknown',
      },
      points: (compiled ? pointDev.points : points).map((p) => {
        const out = { t: p.t, v: roundTo(p.v, decimals) }
        if (varySpec) {
          if (Number.isFinite(p.lsl)) out.lsl = roundTo(p.lsl, decimals)
          if (Number.isFinite(p.usl)) out.usl = roundTo(p.usl, decimals)
          if (p.direction === 'low' || p.direction === 'high') out.direction = p.direction
        }
        return out
      }),
    }
  }
  if (ttl <= 0) return loader()
  return withCache(key, ttl, loader)
}

/** 未就绪时按具体原因给出下一步动作（页面空态引导文案） */
const SOURCE_REASON_NOTE = {
  'no-project': '尚未创建监测项目。请点击「新建项目」，选择数据库系统，并配置取数 SQL 模板与过程参数。',
  'no-item': '当前项目尚未添加监测项。请点击「新建监测项」，为它配置取数 SQL、输出结果与参与参数。',
  'no-template': '当前监测项尚未配置取数 SQL 模板。请在监测项的「取数 SQL」页填写语句并保存。',
  'no-connection': '当前项目绑定的数据库系统尚未配置连接信息。请在侧边栏「数据库管理」页填写连接参数。',
}

function describeSource(mode, meta) {
  if (mode === 'hana') {
    const wide = meta && meta.queryMode === 'wide'
    const skipped = Array.isArray(meta && meta.skippedSlots) ? meta.skippedSlots : []
    const skippedNote = skipped.length > 0
      ? `（数据库系统 ${skipped.map((s) => s.replace('db', '')).join('、')} 未配置连接，绑定这些系统的参数本次无数据）`
      : ''
    return {
      label: 'SAP HANA（只读 · 按参数绑定数据库系统）',
      note:
        '实时读取 HANA 中记录的过程数据列值；每个参数项各自绑定使用数据库系统 1 或 2，仅执行 SELECT，' +
        '单次读取行数与执行时间均受服务端限制。' +
        `当前取数模式：${wide ? '宽表（一行一个时间戳，各参数各占一列）' : '窄表（一行一个参数值，按编码列分组）'}。${skippedNote}`,
      warnings: Array.isArray(meta && meta.warnings) ? meta.warnings : [],
      ready: true,
      reason: '',
    }
  }
  const reason = (meta && meta.reason) || 'no-project'
  return {
    label: '未配置数据源',
    note: SOURCE_REASON_NOTE[reason] || SOURCE_REASON_NOTE['no-project'],
    warnings: [],
    ready: false,
    reason,
  }
}

// ===== 连接可达性探测 =====
//
// getHanaStatus() 只是内存快照：connected 只在「本进程真正建立过连接」之后才为真。
// 于是没被任何项目使用的库（例如只配了连接却没有任何参数的 db2）会永远显示「待连接」，
// 与实际可达性不符。状态接口在返回前对「已配置但未连接」的槽位探一次，
// 让灯色反映真实可达性；带 TTL 缓存，避免每次轮询都去打库。
const probeCache = new Map()

/**
 * 探测已配置但未连接的槽位（并发、失败不抛出）。
 * @param {{force?:boolean}} [opts] force=true 时跳过 TTL 缓存
 */
export async function probeConfiguredSlots({ force = false } = {}) {
  const ttl = Math.max(0, num(process.env.APC_PROBE_TTL_MS, 30000))
  const pending = getHanaStatus().slots.filter((s) => s.configured && !s.connected)
  await Promise.all(pending.map(async (s) => {
    const hit = probeCache.get(s.id)
    if (!force && ttl > 0 && hit && Date.now() - hit.at < ttl) {
      await hit.promise.catch(() => undefined)
      return
    }
    const promise = pingHana(s.id)
    probeCache.set(s.id, { at: Date.now(), promise })
    // 探测失败只落在槽位状态里（页面据此显示），不能让整个状态接口失败
    await promise.catch(() => undefined)
  }))
}

/**
 * 清掉探测缓存（连接刚被测通 / 配置刚变更时调用，让下一次状态查询立刻重新探测，
 * 而不是等 TTL 到期）。
 */
export function clearProbeCache(slotId) {
  if (slotId) probeCache.delete(slotId)
  else probeCache.clear()
}

export function getApcStatus() {
  let cat = null
  let catalogError = ''
  try {
    cat = loadCatalog()
  } catch (err) {
    catalogError = String((err && err.message) || err)
  }
  const projects = apcConfig.listProjects().map(apcConfig.summarizeProject).filter(Boolean)
  return {
    enabled: isApcEnabled(),
    mode: cat ? getSourceMode() : 'unavailable',
    ready: cat ? getSourceReadiness().ready : false,
    reason: cat ? getSourceReadiness().reason : 'no-project',
    station: cat ? cat.station : '',
    paramCount: cat ? cat.params.length : 0,
    queryMode: cat && cat.queries ? cat.queries.mode : null,
    projects,
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

// ===== 问答（聊天）中的 MES 数据直查 =====
//
// 用户在问答栏选择「数据库1 / 数据库2」后，模型可以输出一个 ```mes-sql 代码块（推荐 SQL），
// 前端把它提交到 /api/mes/query，由服务端按「数据库管理」里的硬性要求执行：
//   ① 只允许单条 SELECT / WITH（assertReadOnlySql，拦截一切 DML/DDL/多语句）
//   ② 行数硬上限（chatRows 可在「数据库管理」配置，且不超过槽位 maxRows）
//   ③ 连接超时 / 语句超时均取槽位配置，超时即销毁会话
//   ④ 未配置的槽位直接拒绝（不回退仿真——聊天要的是真实数据，仿真会误导）
// 问答环节与监测项目的 SQL 模板无关：SQL 由模型从知识库上下文中检索/改写得到。

/** 聊天场景行数上限的兜底默认值（实际生效值在 apcConfig.getEffectiveLimits().chatRows） */
const MES_CHAT_MAX_ROWS = 100

/** 供前端构建 MES 直查指引与下拉菜单的非敏感信息（不含任何凭据） */
export function getMesGuide() {
  const databases = apcConfig.getDatabases()
  const slots = apcConfig.getDatabaseIds().map((id) => ({
    id,
    name: databases[id].name || id,
    configured: isDataSourceConfigured(id),
  }))
  const limits = apcConfig.getEffectiveLimits()
  return {
    slots,
    limits: {
      maxRows: 2000,
      chatRows: limits.chatRows,
    },
    // 注意：问答环节与监测项目的 SQL 模板无关——SQL 从知识库检索获得（由模型结合
    // 知识库上下文改写），这里只下发可用槽位与硬性限制。
  }
}

/**
 * 在问答环节执行模型推荐的只读 SQL（服务端硬护栏）。
 * @param {{slot?:string, sql?:string}} input
 * @returns {Promise<{ok:boolean, slot:string, slotName:string, columns:string[], rows:object[],
 *   rowCount:number, truncated:boolean, elapsedMs:number, sql:string}>}
 */
export async function queryMesSql(input = {}) {
  const slotId = input.slot === 'db2' ? 'db2' : (input.slot === 'db1' ? 'db1' : '')
  if (!slotId) {
    const err = new Error('缺少目标数据库系统（应为 db1 或 db2）')
    err.status = 400
    throw err
  }
  const databases = apcConfig.getDatabases()
  const slotName = databases[slotId].name || slotId

  const rawSql = String(input.sql || '')
  if (!rawSql.trim()) {
    const err = new Error('缺少要执行的 SQL')
    err.status = 400
    throw err
  }
  // 模板占位符必须由模型代入具体值后才能提交，不允许把 {{...}} 直接打给数据库
  if (/\{\{\s*\w+\s*\}\}/.test(rawSql)) {
    const err = new Error('SQL 仍包含未代入的模板占位符 {{...}}，请先代入具体值（分钟数 / 行数 / 参数编码）')
    err.status = 400
    throw err
  }

  if (!isDataSourceConfigured(slotId)) {
    const err = new Error(`数据库系统「${slotName}」尚未配置连接，无法查询；请先在侧边栏「数据库管理」完成配置`)
    err.status = 400
    throw err
  }

  const cfg = apcConfig.getEffectiveHanaConfig(slotId)
  // 硬性要求 ①：只读护栏（剥注释/屏蔽字面量/单条 SELECT/WITH/整词拦截 DML+DDL）
  const safeSql = assertReadOnlySql(rawSql)
  // 硬性要求 ②：行数硬上限（取「数据库管理」配置的 chatRows 与槽位 maxRows 的较小值）
  const chatRows = apcConfig.getEffectiveLimits().chatRows
  const chatCap = Math.max(1, Math.min(chatRows, Math.round(cfg.maxRows) || chatRows))
  const finalSql = applyRowLimit(safeSql, chatCap, cfg.useLimit)

  const started = Date.now()
  try {
    // 硬性要求 ③：连接/语句超时均走槽位配置（queryReadOnly 内部超时即销毁会话）
    const { rows, truncated, sql } = await queryReadOnly(finalSql, {
      slotId,
      maxRows: chatCap,
      timeoutMs: cfg.statementTimeoutMs,
    })
    const sanitized = rows.map(sanitizeRow)
    return {
      ok: true,
      slot: slotId,
      slotName,
      columns: sanitized.length > 0 ? Object.keys(sanitized[0]) : [],
      rows: sanitized,
      rowCount: sanitized.length,
      truncated,
      elapsedMs: Date.now() - started,
      sql,
    }
  } catch (err) {
    // 连接失败 / 超时的报错统一加上槽位名，便于用户区分是哪个系统的问题
    const msg = String((err && err.message) || err)
    const wrapped = new Error(`数据库系统「${slotName}」查询失败：${msg}`)
    wrapped.status = err && err.status ? err.status : 502
    throw wrapped
  }
}
