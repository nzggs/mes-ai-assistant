/**
 * APC / RTO 参数目录与取数 SQL 模板的校验（纯函数，零 IO、零外部依赖）
 * ============================================================================
 * 参数目录既来自种子文件（server/apc.catalog.json，可用 APC_CATALOG_FILE 覆盖），
 * 也允许管理员在页面上手工编辑后保存到数据卷配置里。两种来源都必须过同一套校验，
 * 才能保证下游（取数、统计、优化建议）拿到的永远是结构合法的定义。
 *
 * 校验重点：
 *  - 参数编码唯一且符合 ^[A-Za-z0-9_]{1,64}$（编码会参与 SQL 白名单拼接，必须严格）；
 *  - 规格上下限 lsl < usl、可调范围 min < max、setpoint 有限；
 *  - 取数 SQL 必须通过只读护栏，占位符必须在白名单内；
 *  - 宽表模式要求每个参数都配了数据列名。
 */
import { assertReadOnlySql, extractTemplateVars, assertIdent } from './sqlGuard.js'

export const CODE_RE = /^[A-Za-z0-9_]{1,64}$/
export const OBJECTIVES = ['quality', 'energy', 'yield', 'stability']
export const QUERY_MODES = ['long', 'wide']
/** 模板可用占位符（白名单，出现其它占位符即报错，避免拼出坏 SQL） */
export const TEMPLATE_VARS = ['minutes', 'limit', 'codeFilter', 'columns', 'schema']

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function configError(message) {
  const err = new Error(message)
  err.code = 'EAPCCONFIG'
  err.status = 400
  return err
}

/** 参数编码：会参与 SQL 白名单拼接，必须严格校验（防注入） */
export function assertCode(code) {
  const s = String(code == null ? '' : code).trim()
  if (!CODE_RE.test(s)) {
    throw configError(`参数编码非法（仅允许字母/数字/下划线，最长 64 字符）：${s || '(空)'}`)
  }
  return s
}

// ===== 取数 SQL 模板 =====

/**
 * 校验取数 SQL 模板。
 * @param {string} sql 模板文本（可含 {{minutes}} / {{limit}} / {{codeFilter}} / {{columns}} / {{schema}}）
 * @param {{mode?:string, label?:string}} [opts]
 * @returns {string} 校验通过的 SQL 原文（去首尾空白）
 */
export function validateQueryTemplate(sql, opts = {}) {
  const label = opts.label || '取数 SQL 模板'
  const text = String(sql == null ? '' : sql).trim()
  if (!text) throw configError(`${label}不能为空`)

  const mode = QUERY_MODES.includes(opts.mode) ? opts.mode : 'long'

  // 只读护栏先行：任何来源的 SQL 都必须先过这一关，且先报「语句本身有问题」比报
  // 「占位符缺失」更贴近使用者的实际错误（例如把 DML 粘进来）。
  assertReadOnlySql(text)

  // 占位符必须在白名单内（报错信息对使用者更直接）
  const used = extractTemplateVars(text)
  const unknown = used.filter(v => !TEMPLATE_VARS.includes(v))
  if (unknown.length > 0) {
    throw configError(
      `${label}使用了不支持的占位符：${unknown.map(v => `{{${v}}}`).join('、')}；` +
      `可用占位符：${TEMPLATE_VARS.map(v => `{{${v}}}`).join('、')}`
    )
  }
  if (used.length === 0) {
    throw configError(`${label}未使用任何占位符，无法按统计窗口取数（至少需要 {{minutes}}）`)
  }

  // 模式相关的必要占位符只以 warnings 形式提示（见 queryTemplateWarnings），不阻断保存
  return text
}

/** 校验后的温馨提示（不阻断保存） */
export function queryTemplateWarnings(sql, opts = {}) {
  const used = extractTemplateVars(sql)
  const mode = QUERY_MODES.includes(opts.mode) ? opts.mode : 'long'
  const warnings = []
  if (!used.includes('minutes')) warnings.push('模板未使用 {{minutes}}，统计窗口选择将不起作用（SQL 内的固定时间范围会被直接执行）')
  if (!used.includes('limit')) warnings.push('模板未使用 {{limit}}；行数上限仍由服务端强制追加，但建议显式写出以贴合现场索引')
  if (mode === 'long' && !used.includes('codeFilter')) warnings.push('窄表模式未使用 {{codeFilter}}，将读取全表参数后再按编码过滤（数据量大时可能偏慢）')
  if (mode === 'wide' && !used.includes('columns')) warnings.push('宽表模式未使用 {{columns}}，SQL 需要自行写出全部参数列名')
  return warnings
}

/**
 * 校验并规范化 queries 段。
 *  - long（窄表）：一行一个参数值，需要 columns.code / columns.ts / columns.value
 *  - wide（宽表）：一行一个时间戳，各参数各占一列，用 {{columns}} 展开
 */
export function normalizeQueries(raw) {
  if (raw == null) return null
  if (typeof raw !== 'object') throw configError('取数配置格式非法（应为对象）')
  const mode = QUERY_MODES.includes(raw.mode) ? raw.mode : 'long'
  const history = validateQueryTemplate(raw.history, { mode, label: '取数 SQL 模板' })
  const cols = raw.columns && typeof raw.columns === 'object' ? raw.columns : {}
  const columns = {}
  for (const key of ['code', 'ts', 'value']) {
    const v = String(cols[key] == null ? '' : cols[key]).trim()
    if (v) columns[key] = assertIdent(v, `取数列名（${key}）`)
  }
  if (mode === 'long') {
    if (!columns.code) throw configError('窄表模式必须配置「参数编码列」')
    if (!columns.ts) throw configError('窄表模式必须配置「时间戳列」')
    if (!columns.value) throw configError('窄表模式必须配置「数值列」')
  } else if (!columns.ts) {
    throw configError('宽表模式必须配置「时间戳列」')
  }
  return { mode, history, columns }
}

// ===== 参数目录 =====

/**
 * 校验并规范化单个参数定义。
 * @param {object} p
 * @param {number} index 序号（0 起，用于报错定位）
 * @param {{deadbandPctDefault?:number, mode?:string}} [opts]
 */
export function normalizeParam(p, index, opts = {}) {
  const where = `参数目录第 ${index + 1} 项`
  if (!p || typeof p !== 'object') throw configError(`${where}格式非法（应为对象）`)

  const code = String(p.code == null ? '' : p.code).trim()
  if (!CODE_RE.test(code)) {
    throw configError(`${where} code 非法（仅允许字母/数字/下划线）：${code || '(空)'}`)
  }

  const lsl = num(p.lsl, NaN)
  const usl = num(p.usl, NaN)
  const min = num(p.min, NaN)
  const max = num(p.max, NaN)
  const setpoint = num(p.setpoint, NaN)
  const optimalTarget = num(p.optimalTarget, setpoint)

  if (!Number.isFinite(lsl) || !Number.isFinite(usl) || lsl >= usl) {
    throw configError(`参数 ${code} 的规格上下限非法（需 lsl < usl）`)
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw configError(`参数 ${code} 的可调范围非法（需 min < max）`)
  }
  if (!Number.isFinite(setpoint)) throw configError(`参数 ${code} 缺少有效 setpoint`)

  const deadbandDefault = num(opts.deadbandPctDefault, 10)

  // 该参数的数据取自哪个数据库系统（db1 / db2）。
  // 不再使用全局「当前使用」开关——每个参数项各自绑定数据源，允许一部分参数取自 db1、另一部分取自 db2。
  const dbSlot = p.dbSlot == null || p.dbSlot === '' ? 'db1' : String(p.dbSlot)
  if (dbSlot !== 'db1' && dbSlot !== 'db2') {
    throw configError(`参数 ${code} 的使用数据库非法（应为 db1 或 db2）：${dbSlot}`)
  }

  return {
    code,
    name: String(p.name == null || p.name === '' ? code : p.name),
    process: String(p.process == null || p.process === '' ? '其他' : p.process),
    unit: String(p.unit == null ? '' : p.unit),
    decimals: Math.max(0, Math.min(6, Math.round(num(p.decimals, 2)))),
    setpoint,
    optimalTarget,
    lsl,
    usl,
    min,
    max,
    maxStepPct: Math.max(0.1, num(p.maxStepPct, 3)),
    deadbandPct: Math.max(0, Math.min(100, num(p.deadbandPct, deadbandDefault))),
    objective: OBJECTIVES.includes(p.objective) ? p.objective : 'quality',
    processGain: num(p.processGain, 1) || 1,
    // 宽表模式下的取值列名；窄表模式留空（由 columns.code 决定分组）
    column: p.column ? assertIdent(p.column, `参数 ${code} 的数据列名`) : '',
    dbSlot,
    sim: p.sim && typeof p.sim === 'object' ? p.sim : {},
  }
}

/**
 * 校验参数数组（编码唯一 + 逐项校验 + 宽表模式必须配列名）。
 * **允许空数组**：监测项完全由管理员在页面上自行增删，不预置任何项目，
 * 因此「一个都还没配」是合法状态（页面会显示空态引导），只在格式不是数组时报错。
 */
export function normalizeParams(params, opts = {}) {
  if (!Array.isArray(params)) {
    throw configError('参数目录缺少 params 数组（应为数组，可为空数组）')
  }
  if (params.length > 200) throw configError('过程参数过多（上限 200 个）')
  const seen = new Set()
  const out = params.map((p, i) => {
    const norm = normalizeParam(p, i, opts)
    if (seen.has(norm.code)) throw configError(`参数目录存在重复 code：${norm.code}`)
    seen.add(norm.code)
    return norm
  })
  if (opts.mode === 'wide') {
    const missing = out.filter(p => !p.column).map(p => p.code)
    if (missing.length > 0) {
      throw configError(`宽表模式下每个参数都必须配置数据列名，以下参数缺失：${missing.join('、')}`)
    }
  }
  return out
}

/**
 * 校验并规范化整份参数目录。
 * params 允许为空数组（监测项由管理员自行维护，系统不预置）。
 * @param {object} raw
 * @param {string} [sourceLabel] 用于报错定位（文件路径等）
 */
export function validateCatalog(raw, sourceLabel) {
  const tail = sourceLabel ? `：${sourceLabel}` : ''
  if (!raw || typeof raw !== 'object') throw configError(`参数目录格式非法${tail}`)
  if (!Array.isArray(raw.params)) {
    throw configError(`参数目录缺少 params 数组（应为数组，可为空数组）${tail}`)
  }

  const deadbandPctDefault = Math.max(0, Math.min(100, num(raw.deadbandPctDefault, 10)))
  // 先规范化参数（宽表校验依赖 queries.mode，故此处先不传 mode）
  const params = normalizeParams(raw.params, { deadbandPctDefault })
  const queries = raw.queries ? normalizeQueries(raw.queries) : null
  if (queries && queries.mode === 'wide') {
    const missing = params.filter(p => !p.column).map(p => p.code)
    if (missing.length > 0) {
      throw configError(`宽表模式下每个参数都必须配置数据列名，以下参数缺失：${missing.join('、')}`)
    }
  }

  return {
    station: String(raw.station == null || raw.station === '' ? '过程产线' : raw.station),
    sampleIntervalSec: Math.max(10, Math.round(num(raw.sampleIntervalSec, 120))),
    defaultWindowMinutes: Math.max(5, Math.round(num(raw.defaultWindowMinutes, 120))),
    deadbandPctDefault,
    queries,
    params,
  }
}
