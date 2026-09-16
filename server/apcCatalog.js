/**
 * APC / RTO 监测项、取数 SQL 模板与参数目录的校验（纯函数，零 IO、零外部依赖）
 * ============================================================================
 * 数据层次：监测项目 → 监测项（items[]） → 输出结果 CV（只能 1 个）
 *                                          → 参与参数 MV（N 个，多对 1 调优）
 *
 * 一个监测项自带一条取数 SQL，一次查询把 CV 与全部 MV 取回（同一行的不同列），
 * 因此取数模式**只有宽表（wide）**；窄表（long：一行一个参数值、靠编码分组）
 * 已物理移除——它既无法满足「同一行」的要求，也让每个参数的列名无法复用。
 *
 * 校验重点：
 *  - 编码唯一且符合 ^[A-Za-z0-9_]{1,64}$（编码会参与 SQL 白名单拼接，必须严格）；
 *  - CV 规格 lsl < usl；MV 可调范围 min < max；
 *  - CV 与每个 MV 都必须配数据列名（宽表模式下这是取值的唯一依据）；
 *  - MV 影响系数 k = ∂CV/∂MV：缺省为 0（运行期会被排除出求解集，**不阻断保存**，
 *    因为现场往往要先跑起来才谈得上标定）；
 *  - 取数 SQL 必须通过只读护栏，占位符必须在白名单内。
 */
import { assertReadOnlySql, extractTemplateVars, assertIdent } from './sqlGuard.js'
import { parseExpr, isPlainNumber } from './specExpr.js'

export const CODE_RE = /^[A-Za-z0-9_]{1,64}$/
export const OBJECTIVES = ['quality', 'energy', 'yield', 'stability']
/** 取数模式：仅宽表。窄表已移除，历史配置会在 normalizeQueries 里被明确拒绝 */
export const QUERY_MODES = ['wide']
/**
 * 模板可用占位符（白名单，出现其它占位符即报错，避免拼出坏 SQL）。
 * `codeFilter` 是窄表时代的遗留占位符：已不再生成任何内容（恒为空串），
 * 保留在名单里只为让历史模板不至于在读取时炸掉，新模板不要使用。
 */
export const TEMPLATE_VARS = ['minutes', 'limit', 'codeFilter', 'columns', 'schema']
/** 已废弃的占位符：仍被接受（渲染为空），但保存时会给出提示 */
export const DEPRECATED_TEMPLATE_VARS = ['codeFilter']
/** 监测项 id：与参数编码同规格，便于安全地放进 URL 与配置键 */
export const ITEM_ID_RE = /^[A-Za-z0-9_]{1,64}$/
export const WEIGHT_MIN = 0.01
export const WEIGHT_MAX = 100

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

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

/**
 * 规格字段（设定值 / 理想操作点 / LSL / USL / 可调下限 / 可调上限）取值：
 *  - 数字、或「纯数字字符串」→ 归一为 number；
 *  - 含列名的四则运算表达式（如 `USL_COL - 1`）→ **只做语法校验，原样保留字符串**，
 *    等运行期拿到数据行后再求值（现场型号多、规格随行变化，写死数字不可维护）。
 * 解析器不允许函数调用/属性访问/字符串，因此这里保留字符串不会带来注入风险。
 */
function specValue(v, label, code) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw configError(`参数 ${code} 的${label}非法（需为有限数字或列名表达式）`)
    return v
  }
  if (isEmpty(v)) throw configError(`参数 ${code} 缺少${label}`)
  const s = String(v).trim()
  if (isPlainNumber(s)) return Number(s)
  const parsed = parseExpr(s)
  if (!parsed.ok) throw configError(`参数 ${code} 的${label}表达式无效：${parsed.error}`)
  if (parsed.idents.length === 0) {
    throw configError(`参数 ${code} 的${label}必须是数字或含列名的表达式（如 USL_COL - 1）`)
  }
  return s
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
  const warnings = []
  if (!used.includes('minutes')) warnings.push('模板未使用 {{minutes}}，统计窗口选择将不起作用（SQL 内的固定时间范围会被直接执行）')
  if (!used.includes('limit')) warnings.push('模板未使用 {{limit}}；行数上限仍由服务端强制追加，但建议显式写出以贴合现场索引')
  if (!used.includes('columns')) warnings.push('模板未使用 {{columns}}，SQL 需自行写出时间戳列、输出结果列与全部参与参数列')
  for (const v of DEPRECATED_TEMPLATE_VARS) {
    if (used.includes(v)) {
      warnings.push(`{{${v}}} 是窄表时代的遗留占位符，已不再展开任何内容（恒为空串），建议从模板中删除`)
    }
  }
  return warnings
}

/**
 * 校验并规范化某个监测项的取数配置。
 * 宽表：一行一个时间戳，输出结果 CV 与各参与参数 MV 各占一列，由 {{columns}} 展开。
 * 窄表（long）已物理移除——历史配置在这里被**明确拒绝**，而不是静默按宽表解释：
 * 静默解释会照着错误的列名取数（取到别的参数量），比直接报错危险得多。
 */
export function normalizeQueries(raw) {
  if (raw == null) return null
  if (typeof raw !== 'object') throw configError('取数配置格式非法（应为对象）')
  if (String(raw.mode == null ? '' : raw.mode).trim() === 'long') {
    throw configError(
      '窄表（long）取数模式已移除，请改用宽表模式：一行一个时间戳，' +
      '输出结果与每个参与参数各占一列，SQL 里用 {{columns}} 展开。'
    )
  }
  const mode = 'wide'
  const history = validateQueryTemplate(raw.history, { mode, label: '取数 SQL 模板' })
  const cols = raw.columns && typeof raw.columns === 'object' ? raw.columns : {}
  const columns = {}
  for (const key of ['code', 'ts', 'value']) {
    const v = String(cols[key] == null ? '' : cols[key]).trim()
    if (v) columns[key] = assertIdent(v, `取数列名（${key}）`)
  }
  if (!columns.ts) throw configError('必须配置「时间戳列」（宽表按该列展开时间轴）')
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

  const setpoint = specValue(p.setpoint, '当前设定值 setpoint', code)
  const optimalTarget = isEmpty(p.optimalTarget)
    ? setpoint
    : specValue(p.optimalTarget, 'RTO 理想操作点 optimalTarget', code)
  const lsl = specValue(p.lsl, '规格下限 lsl', code)
  const usl = specValue(p.usl, '规格上限 usl', code)
  const min = specValue(p.min, '可调下限 min', code)
  const max = specValue(p.max, '可调上限 max', code)

  // lsl < usl / min < max 只在两侧都是纯数字时静态校验；只要有一侧是列名表达式，
  // 取值要到运行期才知道，交由 resolveCompiledSpec / evaluatePoints 按真实数据行判定。
  if (isPlainNumber(lsl) && isPlainNumber(usl) && !(Number(lsl) < Number(usl))) {
    throw configError(`参数 ${code} 的规格上下限非法（需 lsl < usl）`)
  }
  if (isPlainNumber(min) && isPlainNumber(max) && !(Number(min) < Number(max))) {
    throw configError(`参数 ${code} 的可调范围非法（需 min < max）`)
  }

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
  }
}

/**
 * 校验参数数组（编码唯一 + 逐项校验）。
 * **允许空数组**：监测项完全由管理员在页面上自行增删，不预置任何项目，
 * 因此「一个都还没配」是合法状态（页面会显示空态引导），只在格式不是数组时报错。
 *
 * 注意：这里**不再校验**「宽表模式必须配数据列名」——列名强制已前移到
 * `normalizeItemParam`（新结构下每个参与参数与输出结果都必须有 column）。
 * 本函数现在只为 legacy `params`（惰性迁移的原料）服务，宽松读入即可。
 */
export function normalizeParams(params, opts = {}) {
  if (!Array.isArray(params)) {
    throw configError('参数目录缺少 params 数组（应为数组，可为空数组）')
  }
  if (params.length > 200) throw configError('过程参数过多（上限 200 个）')
  const seen = new Set()
  return params.map((p, i) => {
    const norm = normalizeParam(p, i, opts)
    if (seen.has(norm.code)) throw configError(`参数目录存在重复 code：${norm.code}`)
    seen.add(norm.code)
    return norm
  })
}

// ===== 监测项（多对 1 调优的基本单位）=====
// 一个监测项 = 一条取数 SQL + 1 个输出结果 CV + N 个参与参数 MV。
// CV 与全部 MV 取自查询结果**同一行的不同列**，这就是宽表成为唯一模式的原因。

/** 生成监测项 id（与参数编码同规格，可安全用于 URL 与配置键） */
export function genItemId() {
  return `it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 监测项 id：传入合法则沿用，否则新生成（前端新建时通常不带 id） */
function normalizeItemId(v) {
  const s = String(v == null ? '' : v).trim()
  return ITEM_ID_RE.test(s) ? s : genItemId()
}

/** 布尔真值（兼容前端传 'true' / 1 / '1' / 'on'） */
function truthy(v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

/**
 * 影响系数 k = ∂CV/∂MVᵢ。
 * 缺省为 0 ＝「尚未标定」：运行期该参数会被排除出求解集并明确提示，
 * 但**不阻断保存**——现场通常要先跑起来拿到数据，才谈得上标定。
 * 手工填写与自动标定共用同一字段，`mode` 只记录来源，`calibrated` 留档供回溯。
 */
function normalizeGain(raw, code) {
  const src = raw && typeof raw === 'object' ? raw : { value: raw }
  const mode = src.mode === 'calibrated' ? 'calibrated' : 'manual'
  const value = isEmpty(src.value) ? 0 : num(src.value, NaN)
  if (!Number.isFinite(value)) throw configError(`参数 ${code} 的影响系数 k 非法（需为有限数字）`)
  if (Math.abs(value) > 1e6) {
    throw configError(`参数 ${code} 的影响系数 k 过大（|k| > 1e6），请核对量纲与单位后再填`)
  }
  const out = { mode, value }
  const cal = src.calibrated
  if (cal && typeof cal === 'object') {
    // 标定留档：只保留数值型字段，避免任意结构被写进配置文件
    out.calibrated = {
      value: num(cal.value, value),
      r2: num(cal.r2, 0),
      n: Math.max(0, Math.round(num(cal.n, 0))),
      at: String(cal.at == null ? '' : cal.at).trim().slice(0, 32),
      method: String(cal.method == null ? '' : cal.method).slice(0, 32),
    }
  }
  return out
}

/**
 * 输出结果 CV —— 多对 1 调优里唯一的被控量。
 * 规格（lsl/usl/target）沿用「数字或取数结果列名表达式」的既有能力（specExpr，绝不用 eval），
 * 因此同一个监测项可按型号逐行取到不同规格。
 * 兼容两种写法：嵌套 `spec:{lsl,usl,target}` 与扁平 `lsl/usl/optimalTarget`。
 */
export function normalizeOutput(raw) {
  if (!raw || typeof raw !== 'object') throw configError('缺少输出结果（CV）配置')
  const code = String(raw.code == null ? '' : raw.code).trim()
  if (!CODE_RE.test(code)) {
    throw configError(`输出结果 code 非法（仅允许字母/数字/下划线）：${code || '(空)'}`)
  }
  const column = String(raw.column == null ? '' : raw.column).trim()
  if (!column) throw configError(`输出结果 ${code} 必须配置数据列名（取数 SQL 结果中的列）`)

  const specSrc = raw.spec && typeof raw.spec === 'object' ? raw.spec : raw
  const lsl = specValue(specSrc.lsl, '规格下限 lsl', code)
  const usl = specValue(specSrc.usl, '规格上限 usl', code)
  const targetRaw = specSrc.target !== undefined ? specSrc.target : specSrc.optimalTarget
  const target = isEmpty(targetRaw) ? null : specValue(targetRaw, 'RTO 理想操作点 target', code)
  if (isPlainNumber(lsl) && isPlainNumber(usl) && !(Number(lsl) < Number(usl))) {
    throw configError(`输出结果 ${code} 的规格上下限非法（需 lsl < usl）`)
  }

  return {
    code,
    name: String(raw.name == null || raw.name === '' ? code : raw.name),
    unit: String(raw.unit == null ? '' : raw.unit),
    decimals: Math.max(0, Math.min(6, Math.round(num(raw.decimals, 3)))),
    column: assertIdent(column, `输出结果 ${code} 的数据列名`),
    objective: OBJECTIVES.includes(raw.objective) ? raw.objective : 'quality',
    spec: { lsl, usl, target },
  }
}

/** 参与参数 MV：与 CV 同一行、各自一列；量程与单位由界面手动配置 */
export function normalizeItemParam(p, index) {
  const where = `参与参数第 ${index + 1} 项`
  if (!p || typeof p !== 'object') throw configError(`${where}格式非法（应为对象）`)
  const code = String(p.code == null ? '' : p.code).trim()
  if (!CODE_RE.test(code)) {
    throw configError(`${where} code 非法（仅允许字母/数字/下划线）：${code || '(空)'}`)
  }
  const column = String(p.column == null ? '' : p.column).trim()
  if (!column) throw configError(`参数 ${code} 必须配置数据列名（取数 SQL 结果中的列）`)

  const min = specValue(p.min, '可调下限 min', code)
  const max = specValue(p.max, '可调上限 max', code)
  if (isPlainNumber(min) && isPlainNumber(max) && !(Number(min) < Number(max))) {
    throw configError(`参数 ${code} 的可调范围非法（需 min < max）`)
  }

  return {
    code,
    name: String(p.name == null || p.name === '' ? code : p.name),
    process: String(p.process == null || p.process === '' ? '其他' : p.process),
    unit: String(p.unit == null ? '' : p.unit),
    decimals: Math.max(0, Math.min(6, Math.round(num(p.decimals, 3)))),
    column: assertIdent(column, `参数 ${code} 的数据列名`),
    min,
    max,
    // 当前设定值（可选）：现场真正能拧的往往是参数的**设定值**，而取数列可能是实测值。
    // 填了它，建议就以它为基准（例如「5 → 5.3」）；不填则退回该参数窗口内的实测均值。
    // 从老配置迁移过来的监测项会带上它，从而与改造前的建议值保持一致。
    // 注意 Number(null) === 0：必须先用 isEmpty 挡掉空值，否则「留空」会被当成设定值 0
    setpoint: (isEmpty(p.setpoint) || !Number.isFinite(num(p.setpoint, NaN))) ? null : num(p.setpoint, NaN),
    maxStepPct: Math.max(0.1, num(p.maxStepPct, 3)),
    // 调整阻力 w：越大越不愿意动（易损件、影响其它指标、能耗敏感）。
    // 量纲归一到量程由求解器负责，这里的 w 是纯偏好系数。
    weight: Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, num(p.weight, 1))),
    enabled: p.enabled === undefined ? true : truthy(p.enabled),
    k: normalizeGain(p.k === undefined ? p.gain : p.k, code),
  }
}

/** 校验参与参数数组（编码唯一；允许空数组，此时该监测项只能观察、不能调优） */
export function normalizeItemParams(params) {
  if (params == null) return []
  if (!Array.isArray(params)) throw configError('参与参数应为数组')
  if (params.length > 50) throw configError('单个监测项的参与参数过多（上限 50 个）')
  const seen = new Set()
  return params.map((p, i) => {
    const norm = normalizeItemParam(p, i)
    if (seen.has(norm.code)) throw configError(`参与参数存在重复 code：${norm.code}`)
    seen.add(norm.code)
    return norm
  })
}

/**
 * 调优策略。
 * `deadbandPct` **不可删**：偏差落在死区内且过程能力正常时，调整收益低于扰动成本，
 * 「不动」本身就是最优决策——这是 RTO 与「自动追目标」的分界线。
 */
function normalizeTuning(raw) {
  const t = raw && typeof raw === 'object' ? raw : {}
  return {
    deadbandPct: Math.max(0, Math.min(100, num(t.deadbandPct, 10))),
    maxRounds: Math.max(0, Math.min(5, Math.round(num(t.maxRounds, 2)))),
    residualTolerancePct: Math.max(0, Math.min(100, num(t.residualTolerancePct, 5))),
  }
}

/** 校验并规范化单个监测项 */
export function normalizeItem(raw, index = 0) {
  const where = `监测项第 ${index + 1} 项`
  if (!raw || typeof raw !== 'object') throw configError(`${where}格式非法（应为对象）`)
  const name = String(raw.name == null ? '' : raw.name).trim()
  if (!name) throw configError(`${where}的名称不能为空`)

  const query = normalizeQueries(raw.query)
  if (!query || !query.history) throw configError(`${where}「${name}」缺少取数 SQL 模板`)
  const output = normalizeOutput(raw.output)
  const params = normalizeItemParams(raw.params)
  // 刻意**不**禁止 output.code 与某个 MV.code 相同：
  // 老配置里的「自调优」参数天然就是这个形态（设定值与实测值来自同一条曲线、同一列），
  // 迁移后必然重名。code 只用于展示与引用，真正的取值一律用 column，因此重名无害。

  return {
    id: normalizeItemId(raw.id),
    name: name.slice(0, 64),
    description: String(raw.description == null ? '' : raw.description).trim().slice(0, 200),
    query,
    output,
    params,
    tuning: normalizeTuning(raw.tuning),
  }
}

/** 校验监测项数组（id 唯一） */
export function normalizeItems(items) {
  if (items == null) return []
  if (!Array.isArray(items)) throw configError('监测项应为数组')
  if (items.length > 50) throw configError('项目下的监测项过多（上限 50 个）')
  const seen = new Set()
  return items.map((it, i) => {
    const norm = normalizeItem(it, i)
    if (seen.has(norm.id)) throw configError(`监测项 id 重复：${norm.id}`)
    seen.add(norm.id)
    return norm
  })
}

/**
 * 监测项自检提示（不阻断保存）。
 * 这些正是「配完了但算不出建议」的常见原因，提前在保存时讲清楚，
 * 好过运行期让使用者对着一个空建议猜。
 */
export function itemWarnings(item) {
  const out = []
  if (!item || !Array.isArray(item.params) || item.params.length === 0) {
    out.push('尚未添加参与参数，该监测项只能观察输出结果，无法给出调整建议。')
    return out
  }
  const noK = item.params
    .filter(p => !p.k || !Number.isFinite(p.k.value) || p.k.value === 0)
    .map(p => p.code)
  if (noK.length > 0) {
    out.push(
      `以下参数的影响系数 k 为 0（尚未标定），调优时会被排除出求解集：${noK.join('、')}。` +
      '可先用单变量试验估计：k ≈ ΔCV / ΔMV。'
    )
  }
  const disabled = item.params.filter(p => p.enabled === false).map(p => p.code)
  if (disabled.length > 0) out.push(`以下参数已停用，不参与调优：${disabled.join('、')}。`)
  // 自调优：输出结果与某个参与参数是同一个量。从老配置迁移来的项都是这个形态，
  // 行为与改造前一致（退化为单参数回路），值得点明以免误以为「已经是多对 1」。
  if (item.output && item.params.some(p => p.code === item.output.code)) {
    out.push('该监测项的输出结果与某个参与参数是同一个量（自调优），等价于改造前的单参数模式；如需多对 1，请改为独立的输出结果列并追加参与参数。')
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
  // legacy 的 params / queries 继续解析（它们是多对 1 改造之前的老结构，
  // 只作为「惰性迁移」的原料，不再要求每个参数都配列名——宽松读入，严格保存）
  const params = normalizeParams(raw.params, { deadbandPctDefault })
  const queries = raw.queries ? normalizeQueries(raw.queries) : null
  const items = normalizeItems(raw.items)

  return {
    // schema 必须回传：buildTemplateVars 把它代入 {{schema}}。
    // 此前漏返回导致该占位符恒为空串——模板里写 `{{schema}}.T` 会静默变成 `.T`，
    // 报的是数据库语法错，排查方向完全被带偏。
    schema: String(raw.schema == null ? '' : raw.schema).trim().slice(0, 64),
    station: String(raw.station == null || raw.station === '' ? '过程产线' : raw.station),
    sampleIntervalSec: Math.max(10, Math.round(num(raw.sampleIntervalSec, 120))),
    defaultWindowMinutes: Math.max(5, Math.round(num(raw.defaultWindowMinutes, 120))),
    deadbandPctDefault,
    queries,
    params,
    items,
  }
}
