/**
 * APC / RTO 运行期配置（页面可手工配置，落盘到数据卷）
 * ============================================================================
 * 页面上的三个配置窗口（数据库登录 / SQL 查询语句 / 参数配置）都写到这里：
 *
 *   数据卷: ${MES_DATA_DIR:-server/data}/apc.config.json     ← 被 .gitignore 覆盖
 *   种子文件: server/apc.catalog.json（可用 APC_CATALOG_FILE 指定）
 *
 * 为什么不用 .env：本仓库把 .env 纳入了 git 跟踪，而仓库是公开的，
 * 把生产库密码写进 .env 等于公开凭据。因此页面配置一律落到「不入库」的数据卷。
 *
 * 生效优先级：
 *   database …… 页面保存值 > 环境变量（HANA_*）> 内置默认
 *   catalog  …… 若设置了 APC_CATALOG_FILE，则该文件为准（页面保存不生效，界面上会明示），
 *                否则 页面保存值 > 种子文件
 *
 * 安全约定：
 *   1) 密码只进不出——接口只回 passwordSet，绝不回传密码原文；
 *   2) 保存前一律经过 apcCatalog 的结构校验与 sqlGuard 的只读校验；
 *   3) 写文件采用「临时文件 + rename」原子写，避免半截文件导致服务起不来。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { validateCatalog, normalizeQueries, normalizeParams } from './apcCatalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SEED_FILE = path.join(__dirname, 'apc.catalog.json')
const CONFIG_VERSION = 1

/**
 * 双数据库系统：两个 HANA 连接槽位，可手工配置并在页面上「手动切换使用哪个」。
 * 两个槽位共享同一套 SQL 取数模板与参数目录（同一套监测项），只是数据源不同。
 * SQL 模板与参数目录为共享配置；只有「连接」按槽位分别保存。
 */
export const DB_SLOTS = ['db1', 'db2']
export const DB_DEFAULT_NAMES = { db1: '数据库系统 1', db2: '数据库系统 2' }

// ===== 路径 =====

function dataDir() {
  return process.env.MES_DATA_DIR
    ? path.resolve(process.env.MES_DATA_DIR)
    : path.join(__dirname, 'data')
}

/** 运行期配置文件路径（可用 APC_CONFIG_FILE 覆盖，测试用） */
export function configFilePath() {
  const custom = (process.env.APC_CONFIG_FILE || '').trim()
  return custom ? path.resolve(custom) : path.join(dataDir(), 'apc.config.json')
}

/** 参数目录种子文件路径 */
export function seedFilePath() {
  const custom = (process.env.APC_CATALOG_FILE || '').trim()
  return custom ? path.resolve(custom) : DEFAULT_SEED_FILE
}

/** 是否由 APC_CATALOG_FILE 锁定参数目录（锁定时页面保存参数不生效） */
export function isCatalogFileLocked() {
  return Boolean((process.env.APC_CATALOG_FILE || '').trim())
}

// ===== 通用工具 =====

function configError(message) {
  const err = new Error(message)
  err.code = 'EAPCCONFIG'
  err.status = 400
  return err
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

/** 原子写：先写临时文件再 rename，避免进程中断留下半截 JSON */
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

// ===== 环境变量侧的 HANA 配置（历史行为，保持兼容）=====

/** 从环境变量读取 HANA 配置（页面未覆盖时的取值来源） */
export function getEnvHanaConfig() {
  const env = process.env
  return {
    host: (env.HANA_HOST || '').trim(),
    port: Math.round(num(env.HANA_PORT, 30015)),
    user: (env.HANA_USER || '').trim(),
    password: env.HANA_PASSWORD || '',
    databaseName: (env.HANA_DATABASE || '').trim(),
    schema: (env.HANA_SCHEMA || '').trim(),
    useTLS: toBool(env.HANA_USE_TLS, false),
    validateCert: toBool(env.HANA_VALIDATE_CERT, true),
    caFile: (env.HANA_SSL_CA || '').trim(),
    connectTimeoutMs: Math.round(num(env.HANA_CONNECT_TIMEOUT_MS, 8000)),
    statementTimeoutMs: Math.round(num(env.HANA_STATEMENT_TIMEOUT_MS, 15000)),
    maxRows: Math.round(num(env.HANA_MAX_ROWS, 2000)),
    useLimit: toBool(env.HANA_USE_LIMIT, true),
  }
}

// ===== 配置文件读写 =====

let cache = null
let cacheAt = 0
let revision = 0

/** 配置版本号：每次保存/重置自增，供上层缓存失效判断 */
export function getConfigRevision() {
  return revision
}

function emptyConfig() {
  return { version: CONFIG_VERSION, updatedAt: null, database: {}, catalog: {} }
}

/** 读取配置文件（带缓存；文件损坏时降级为空配置并记录原因，不阻断服务启动） */
export function readConfig(force = false) {
  if (!force && cache && cacheAt > 0) return cache
  const file = configFilePath()
  let raw = emptyConfig()
  let error = ''
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        // 兼容历史单库配置：旧的 `database` 单对象迁移进 db1 槽位
        let databases = {}
        if (parsed.databases && typeof parsed.databases === 'object') databases = parsed.databases
        else if (parsed.database && typeof parsed.database === 'object') databases = { db1: parsed.database }
        const activeDatabase = DB_SLOTS.includes(parsed.activeDatabase) ? parsed.activeDatabase : DB_SLOTS[0]
        raw = {
          version: Math.round(num(parsed.version, CONFIG_VERSION)),
          updatedAt: parsed.updatedAt || null,
          databases,
          activeDatabase,
          catalog: parsed.catalog && typeof parsed.catalog === 'object' ? parsed.catalog : {},
        }
      }
    }
  } catch (err) {
    error = String((err && err.message) || err)
  }
  cache = raw
  cacheAt = Date.now()
  lastReadError = error
  return raw
}

let lastReadError = ''
export function getConfigFileError() {
  readConfig()
  return lastReadError
}

function persist(next) {
  const file = configFilePath()
  next.version = CONFIG_VERSION
  next.updatedAt = new Date().toISOString()
  writeFileAtomic(file, JSON.stringify(next, null, 2))
  cache = next
  cacheAt = Date.now()
  revision++
  lastReadError = ''
  return next
}

// ===== database 段 =====

const DB_TEXT_KEYS = ['host', 'user', 'databaseName', 'schema', 'caFile']
const DB_BOOL_KEYS = ['useTLS', 'validateCert', 'useLimit']
const DB_NUM_RANGES = {
  port: [1, 65535, 30015],
  connectTimeoutMs: [1000, 60000, 8000],
  statementTimeoutMs: [1000, 120000, 15000],
  maxRows: [1, 20000, 2000],
}

/** 校验并规范化 database 段（只处理传入的字段，便于分段保存） */
export function normalizeDatabase(input) {
  if (input == null) return {}
  if (typeof input !== 'object') throw configError('数据库配置格式非法（应为对象）')
  const out = {}

  for (const key of DB_TEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const v = String(input[key] == null ? '' : input[key]).trim()
    if (key === 'host' && v && !/^[A-Za-z0-9._:\-[\]]{1,128}$/.test(v)) {
      throw configError(`数据库地址格式非法：${v}`)
    }
    out[key] = v
  }

  for (const [key, [lo, hi]] of Object.entries(DB_NUM_RANGES)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const raw = input[key]
    if (raw === '' || raw == null) continue
    const v = Math.round(Number(raw))
    if (!Number.isFinite(v) || v < lo || v > hi) {
      throw configError(`配置项 ${key} 超出允许范围（${lo} ~ ${hi}）：${raw}`)
    }
    out[key] = v
  }

  for (const key of DB_BOOL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    out[key] = toBool(input[key], false)
  }

  // 密码三态：undefined=保持原值；null=显式清除；非空字符串=更新
  if (Object.prototype.hasOwnProperty.call(input, 'password')) {
    const p = input.password
    if (p === undefined) {
      // 保持
    } else if (p === null) {
      out.password = null
    } else if (typeof p === 'string' && p !== '') {
      out.password = p
    }
    // 空字符串视为「未修改」，避免前端每次保存都清掉密码
  }

  // 槽位显示名（仅用于界面区分两个数据库系统，不参与连接）
  if (Object.prototype.hasOwnProperty.call(input, 'name')) {
    out.name = String(input.name == null ? '' : input.name).trim().slice(0, 64)
  }

  return out
}

/** 合并后的生效数据库配置：页面保存值 > 环境变量 > 内置默认
 * @param {string} [id] 数据库槽位（db1/db2）；缺省取当前「正在使用」的槽位
 */
export function getEffectiveHanaConfig(id) {
  const slotId = id && DB_SLOTS.includes(id) ? id : getActiveDatabaseId()
  const env = getEnvHanaConfig()
  const saved = (readConfig().databases || {})[slotId] || {}
  const out = { ...env }
  for (const key of [...DB_TEXT_KEYS, ...DB_BOOL_KEYS, ...Object.keys(DB_NUM_RANGES)]) {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) continue
    const v = saved[key]
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v === '') continue
    out[key] = v
  }
  if (Object.prototype.hasOwnProperty.call(saved, 'password')) {
    // null 表示页面上显式清除了密码
    out.password = saved.password === null ? '' : String(saved.password)
  }
  return out
}

/** 当前所有数据库槽位（含默认名，不暴露密码） */
export function getDatabases() {
  const raw = readConfig().databases || {}
  const out = {}
  for (const id of DB_SLOTS) {
    const slot = raw[id] && typeof raw[id] === 'object' ? raw[id] : {}
    out[id] = { ...slot, name: slot.name || DB_DEFAULT_NAMES[id] }
  }
  return out
}

/** 数据库槽位 id 列表（固定顺序） */
export function getDatabaseIds() {
  return [...DB_SLOTS]
}

/** 当前「正在使用」的数据库槽位 id（缺省 db1） */
export function getActiveDatabaseId() {
  const cur = readConfig().activeDatabase
  return DB_SLOTS.includes(cur) ? cur : DB_SLOTS[0]
}

/** 是否已完成数据源配置（host + user 齐备即视为已配置）
 * @param {string} [id] 数据库槽位；缺省取当前「正在使用」的槽位
 */
export function isDataSourceConfigured(id) {
  const c = getEffectiveHanaConfig(id)
  return Boolean(c.host && c.user)
}

/** 哪些数据库配置项来自页面保存（用于界面标注） */
export function savedDatabaseKeys() {
  return Object.keys(readConfig().database || {})
}

/** 保存某个数据库槽位（id: db1/db2） */
export function saveDatabase(id, input) {
  if (!DB_SLOTS.includes(id)) throw configError(`不支持的数据库槽位：${id || '(空)'}（可选：${DB_SLOTS.join(' / ')}）`)
  const patch = normalizeDatabase(input)
  if (Object.keys(patch).length === 0) throw configError('没有可保存的数据库配置项')
  const cur = readConfig(true)
  const databases = { ...(cur.databases || {}) }
  databases[id] = { ...(databases[id] || {}), ...patch }
  if (!databases[id].name) databases[id].name = DB_DEFAULT_NAMES[id]
  const next = { ...cur, databases }
  persist(next)
  return getEffectiveHanaConfig(id)
}

/** 切换「正在使用」的数据库槽位（下次取数 / 测试均走该槽位） */
export function setActiveDatabase(id) {
  if (!DB_SLOTS.includes(id)) throw configError(`不支持的数据库槽位：${id || '(空)'}（可选：${DB_SLOTS.join(' / ')}）`)
  const cur = readConfig(true)
  if (cur.activeDatabase === id) return id
  const next = { ...cur, activeDatabase: id }
  persist(next)
  return id
}

/** 清空某个数据库槽位（保留槽位名，连接字段全部回到未配置） */
export function resetDatabase(id) {
  if (!DB_SLOTS.includes(id)) throw configError(`不支持的数据库槽位：${id || '(空)'}（可选：${DB_SLOTS.join(' / ')}）`)
  const cur = readConfig(true)
  const databases = { ...(cur.databases || {}) }
  databases[id] = { name: DB_DEFAULT_NAMES[id] }
  const next = { ...cur, databases }
  persist(next)
  return getConfigForClient()
}

// ===== catalog 段（queries / params / meta）=====

function savedCatalog() {
  return readConfig().catalog || {}
}

/** 读取种子文件原文（只读一次磁盘，错误包装成可读信息） */
function readSeedRaw() {
  const seed = seedFilePath()
  try {
    return JSON.parse(fs.readFileSync(seed, 'utf8'))
  } catch (err) {
    throw new Error(`无法读取参数目录种子文件 ${seed}（${(err && err.message) || err}）`)
  }
}

/** 用「种子 + 指定覆盖」拼出待校验的目录，不落盘（保存前预校验用） */
function rawCatalogWith(overrides) {
  const seedRaw = readSeedRaw()
  if (isCatalogFileLocked()) return seedRaw
  return { ...seedRaw, ...(overrides || {}) }
}

/** 合并后的原始目录（种子文件 + 页面覆盖） */
export function getRawCatalog() {
  return rawCatalogWith(savedCatalog())
}

let catalogCache = null
let catalogCacheKey = ''

/** 校验并返回生效的参数目录（带缓存） */
export function getEffectiveCatalog(force = false) {
  const key = `${seedFilePath()}|${configFilePath()}|${revision}`
  if (!force && catalogCache && catalogCacheKey === key) return catalogCache
  const raw = getRawCatalog()
  const catalog = validateCatalog(raw, isCatalogFileLocked() ? seedFilePath() : configFilePath())
  catalogCache = catalog
  catalogCacheKey = key
  return catalog
}

/** 参数目录来源：env-file（环境变量指定文件） | saved（页面保存/种子+覆盖） */
export function getCatalogOrigin() {
  return isCatalogFileLocked() ? 'env-file' : 'saved'
}

/** 保存 queries 段 */
export function saveQueries(input) {
  if (isCatalogFileLocked()) {
    throw configError('当前由 APC_CATALOG_FILE 指定参数目录文件，页面保存不生效；请先移除该环境变量')
  }
  const queries = normalizeQueries(input)
  const cur = readConfig(true)
  const catalog = { ...(cur.catalog || {}), queries }
  // 先按「合并后」的目录整体校验（例如种子是宽表而参数未配列名时立即拦下），再落盘
  validateCatalog(rawCatalogWith(catalog), configFilePath())
  persist({ ...cur, catalog })
  catalogCache = null
  return queries
}

/** 保存 params 段 */
export function saveParams(input) {
  if (isCatalogFileLocked()) {
    throw configError('当前由 APC_CATALOG_FILE 指定参数目录文件，页面保存不生效；请先移除该环境变量')
  }
  let mode = 'long'
  let deadbandPctDefault = 10
  try {
    const eff = getEffectiveCatalog()
    deadbandPctDefault = eff.deadbandPctDefault
    if (eff.queries && eff.queries.mode) mode = eff.queries.mode
  } catch { /* 现有目录不合法时按窄表校验，下面整体校验会给出准确报错 */ }

  // 参数未显式填工艺死区时，要继承目录级默认值，避免保存一次就被重置成 10%
  const params = normalizeParams(Array.isArray(input) ? input : [], { mode, deadbandPctDefault })
  const cur = readConfig(true)
  const catalog = { ...(cur.catalog || {}), params }
  validateCatalog(rawCatalogWith(catalog), configFilePath())
  persist({ ...cur, catalog })
  catalogCache = null
  return params
}

/** 保存 meta（装置名 / 采样间隔 / 默认窗口 / 默认死区） */
export function saveMeta(input) {
  if (isCatalogFileLocked()) {
    throw configError('当前由 APC_CATALOG_FILE 指定参数目录文件，页面保存不生效；请先移除该环境变量')
  }
  if (!input || typeof input !== 'object') throw configError('目录元信息格式非法（应为对象）')
  const patch = {}
  if (input.station !== undefined) patch.station = String(input.station || '').trim() || '过程产线'
  if (input.sampleIntervalSec !== undefined) {
    const v = Math.round(num(input.sampleIntervalSec, NaN))
    if (!Number.isFinite(v) || v < 10 || v > 86400) throw configError('采样间隔需在 10 ~ 86400 秒之间')
    patch.sampleIntervalSec = v
  }
  if (input.defaultWindowMinutes !== undefined) {
    const v = Math.round(num(input.defaultWindowMinutes, NaN))
    if (!Number.isFinite(v) || v < 5 || v > 1440) throw configError('默认统计窗口需在 5 ~ 1440 分钟之间')
    patch.defaultWindowMinutes = v
  }
  if (input.deadbandPctDefault !== undefined) {
    const v = num(input.deadbandPctDefault, NaN)
    if (!Number.isFinite(v) || v < 0 || v > 100) throw configError('默认工艺死区需在 0 ~ 100 之间')
    patch.deadbandPctDefault = v
  }
  if (Object.keys(patch).length === 0) throw configError('没有可保存的目录元信息')
  const cur = readConfig(true)
  const next = { ...cur, catalog: { ...(cur.catalog || {}), ...patch } }
  persist(next)
  catalogCache = null
  return patch
}

// ===== 整体视图（给页面用）=====

const SENSITIVE_DB_KEYS = ['password']

/** 供前端渲染的配置视图：**绝不包含密码原文** */
export function getConfigForClient() {
  const file = configFilePath()
  const raw = readConfig(true)
  const env = getEnvHanaConfig()
  const catalogError = getConfigFileError()

  const databases = getDatabases()
  const activeId = getActiveDatabaseId()
  const slots = DB_SLOTS.map(id => {
    const eff = getEffectiveHanaConfig(id)
    const slotSaved = (readConfig().databases || {})[id] || {}
    const values = {}
    for (const [k, v] of Object.entries(eff)) {
      if (SENSITIVE_DB_KEYS.includes(k)) continue
      values[k] = v
    }
    return {
      id,
      name: databases[id].name || DB_DEFAULT_NAMES[id],
      values,
      passwordSet: Boolean(eff.password),
      savedKeys: Object.keys(slotSaved),
      configured: Boolean(eff.host && eff.user),
    }
  })

  let catalog = null
  let paramsError = ''
  try {
    catalog = getEffectiveCatalog()
  } catch (err) {
    paramsError = String((err && err.message) || err)
  }

  const envValues = {}
  for (const [k, v] of Object.entries(env)) {
    if (SENSITIVE_DB_KEYS.includes(k)) continue
    envValues[k] = v
  }
  envValues.passwordSet = Boolean(env.password)

  return {
    configFile: file,
    configFileExists: fs.existsSync(file),
    configFileError: catalogError,
    updatedAt: raw.updatedAt || null,
    catalogFileLocked: isCatalogFileLocked(),
    seedFile: seedFilePath(),
    database: {
      activeId,
      slots,
      envConfigured: Boolean(env.host && env.user),
      envValues,
      defaults: {
        port: 30015,
        useTLS: false,
        validateCert: true,
        connectTimeoutMs: 8000,
        statementTimeoutMs: 15000,
        maxRows: 2000,
        useLimit: true,
      },
    },
    queries: catalog ? catalog.queries : null,
    params: catalog ? catalog.params : [],
    meta: catalog
      ? {
          station: catalog.station,
          sampleIntervalSec: catalog.sampleIntervalSec,
          defaultWindowMinutes: catalog.defaultWindowMinutes,
          deadbandPctDefault: catalog.deadbandPctDefault,
        }
      : null,
    catalogError: paramsError,
  }
}

// ===== 重置 =====

export const RESET_SECTIONS = ['database', 'queries', 'params', 'meta']

/** meta 段在配置文件里是平铺存放的（saveMeta 直接把键合进 catalog） */
const META_KEYS = ['station', 'sampleIntervalSec', 'defaultWindowMinutes', 'deadbandPctDefault']

/** 把某一段恢复为「种子文件 / 环境变量」提供的默认值
 * @param {string} section
 * @param {string} [databaseId] 仅 reset 'database' 时有效：指定清空某个槽位；缺省清空全部槽位
 */
export function resetSection(section, databaseId) {
  const key = String(section || '').trim()
  if (!RESET_SECTIONS.includes(key)) {
    throw configError(`不支持重置的配置段：${key || '(空)'}（可选：${RESET_SECTIONS.join(' / ')}）`)
  }
  if (key !== 'database' && isCatalogFileLocked()) {
    throw configError('当前由 APC_CATALOG_FILE 指定参数目录文件，页面重置不生效')
  }
  const cur = readConfig(true)
  const next = { ...cur }
  if (key === 'database') {
    if (databaseId && DB_SLOTS.includes(databaseId)) {
      const databases = { ...(cur.databases || {}) }
      databases[databaseId] = { name: DB_DEFAULT_NAMES[databaseId] }
      next.databases = databases
    } else {
      next.databases = {}
    }
  } else {
    const catalog = { ...(cur.catalog || {}) }
    // meta 平铺：四个键要一起删，否则重置后装置名/采样间隔仍停留在页面取值
    const targets = key === 'meta' ? META_KEYS : [key]
    for (const k of targets) delete catalog[k]
    next.catalog = catalog
  }
  persist(next)
  catalogCache = null
  return getConfigForClient()
}

/** 清空本地缓存（测试与热更新用） */
export function invalidateConfigCache() {
  cache = null
  cacheAt = 0
  catalogCache = null
  catalogCacheKey = ''
}
