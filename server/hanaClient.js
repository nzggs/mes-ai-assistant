/**
 * HANA 只读数据源连接器
 * ============================================================================
 * 面向「APC 和 RTO」功能：即时读取 HANA 中记录的过程数据列值，用于参数优化建议。
 *
 * 设计原则（安全优先，避免把生产库搞崩）：
 *  1) 只读：仅允许 SELECT / WITH 开头的单条语句；DDL/DML（insert/update/delete/
 *     merge/truncate/drop/alter/create/grant/...）以及 SELECT INTO、FOR UPDATE
 *     一律在进入驱动之前被拒绝。校验前会先剥离注释、屏蔽字符串与带引号标识符，
 *     避免用注释或字面量夹带危险关键字。
 *  2) 绝不接收客户端传入的裸 SQL：上层只执行 apc.catalog.json 里的 SQL 模板，
 *     运行期只有「受校验的整数」与「目录内白名单参数编码」被代入。
 *  3) 限量：默认给查询追加 LIMIT（可用 HANA_USE_LIMIT 关闭），并在客户端再做一次
 *     硬截断；任何一次读取都不会超过 HANA_MAX_ROWS 行。
 *  4) 限时：连接超时与语句超时均为客户端强制，超时即销毁连接，
 *     不给数据库留下长时间占用会话的机会。
 *  5) 单连接 + 串行队列：同一时刻只允许一条查询在飞，杜绝并发风暴。
 *
 * 驱动为 hdb（SAP 官方纯 JS 实现），动态 require，未安装时不影响服务启动。
 */
import { createRequire } from 'module'
import { getEffectiveHanaConfig, isDataSourceConfigured, isAnyDatabaseConfigured } from './apcConfig.js'
import { assertReadOnlySql, applyRowLimit, stripSqlComments } from './sqlGuard.js'

// 只读护栏与模板工具统一放在 sqlGuard.js（纯函数，零依赖），此处再导出以保持既有引用可用
export { assertReadOnlySql, applyRowLimit, stripSqlComments, maskSql } from './sqlGuard.js'
// 槽位级「是否已配置」判断来自 apcConfig，这里再导出供 apcService 等既有引用使用
export { isDataSourceConfigured } from './apcConfig.js'

/** 数据库槽位列表（与 apcConfig 保持一致：两个数据库系统） */
const DB_SLOTS = ['db1', 'db2']

const require = createRequire(import.meta.url)

// ===== 驱动加载（延迟 + 容错，缺驱动不影响服务整体启动）=====
let hdbModule = null
let hdbLoadError = null
function loadHdb() {
  if (hdbModule) return hdbModule
  if (hdbLoadError) throw hdbLoadError
  try {
    hdbModule = require('hdb')
    return hdbModule
  } catch (err) {
    hdbLoadError = new Error(
      'HANA 驱动（hdb）未安装：请在 server 目录执行 npm install hdb，或重新构建镜像'
    )
    hdbLoadError.cause = err
    throw hdbLoadError
  }
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

// ===== 配置 =====
/**
 * 读取生效的 HANA 连接配置。
 * 取值优先级：**页面保存的配置（数据卷 apc.config.json）> 环境变量 HANA_* > 内置默认**。
 * 页面保存是管理员在「APC和RTO → 数据源配置 → 数据库登录」里填写的，
 * 账号密码只落在服务端数据卷，任何接口都不会把密码回传给浏览器。
 * @returns {object} 含 host/port/user/password/databaseName/schema/useTLS/...
 */
export function getHanaConfig(id) {
  return getEffectiveHanaConfig(id)
}

/** 是否已完成 HANA 连接配置（任一槽位 host + user 齐备即视为已配置）
 * @param {string} [id] 传槽位 id 则只判断该槽位
 */
export function isHanaConfigured(id) {
  if (id) return isDataSourceConfigured(id)
  return isAnyDatabaseConfigured()
}

// ===== SQL 只读护栏 =====
// 已统一迁移到 server/sqlGuard.js（assertReadOnlySql / applyRowLimit / stripSqlComments / maskSql）。
// 本文件在顶部 import 使用，并原样再导出以兼容既有引用；新增取数 SQL 也必须过同一层护栏。
// ===== 连接与执行 =====
// 每个数据库槽位（db1/db2）各自维护一条共享连接 + 独立串行队列：
// 两个系统的连接互不阻塞，同一槽位内仍然同时只允许一条查询在飞。

function newSlotState() {
  return {
    client: null,
    connectPromise: null,
    queue: Promise.resolve(),
    connected: false,
    connecting: false,
    lastError: '',
    lastConnectAt: 0,
    lastQueryAt: 0,
    lastQueryMs: 0,
    queryCount: 0,
    abortedCount: 0,
  }
}

const slots = new Map()

function slotEntry(id) {
  const key = DB_SLOTS.includes(id) ? id : 'db1'
  let entry = slots.get(key)
  if (!entry) {
    entry = newSlotState()
    slots.set(key, entry)
  }
  return entry
}

/** 销毁某个槽位的连接（超时/异常时调用，确保服务端会话被释放） */
function destroyClient(entry, reason) {
  const c = entry.client
  entry.client = null
  entry.connected = false
  if (reason) entry.lastError = String(reason)
  if (!c) return
  try {
    if (typeof c.destroy === 'function') c.destroy(new Error(reason || 'reset'))
    else if (typeof c.close === 'function') c.close()
  } catch { /* 忽略关闭异常 */ }
}

/** 队列串行化：同一槽位同一时刻只有一条查询在飞，避免并发压垮数据源 */
function withLock(entry, task) {
  const run = entry.queue.then(task, task)
  entry.queue = run.then(() => undefined, () => undefined)
  return run
}

/** 组装 hdb 连接参数（供共享连接与一次性测试连接复用） */
function buildClientOptions(cfg) {
  const opts = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
  }
  if (cfg.databaseName) opts.databaseName = cfg.databaseName
  if (cfg.useTLS) {
    opts.useTLS = true
    if (cfg.caFile) opts.ca = cfg.caFile
    if (!cfg.validateCert) opts.rejectUnauthorized = false
  }
  return opts
}

async function ensureConnected(id) {
  const entry = slotEntry(id)
  if (entry.client && entry.connected) return entry.client
  if (entry.connectPromise) {
    await entry.connectPromise
    if (entry.client && entry.connected) return entry.client
  }
  const cfg = getHanaConfig(id)
  if (!cfg.host || !cfg.user) throw new Error(`数据库系统（${id || 'db1'}）未配置连接（缺少地址 / 用户名）`)

  const hdb = loadHdb()
  const opts = buildClientOptions(cfg)

  const c = hdb.createClient(opts)
  c.on('error', (err) => {
    entry.connected = false
    entry.lastError = String((err && err.message) || err)
  })
  entry.client = c
  entry.connecting = true

  entry.connectPromise = new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      destroyClient(entry, '连接 HANA 超时')
      reject(new Error(`连接 HANA 超时（>${cfg.connectTimeoutMs}ms）`))
    }, cfg.connectTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    c.connect((err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        destroyClient(entry, (err && err.message) || err)
        reject(err)
        return
      }
      entry.connected = true
      entry.lastConnectAt = Date.now()
      entry.lastError = ''
      resolve()
    })
  })

  try {
    await entry.connectPromise
  } finally {
    entry.connectPromise = null
    entry.connecting = false
  }
  return entry.client
}

/**
 * 执行一条只读查询。
 * @param {string} sql 必须是 SELECT/WITH 单语句
 * @param {{slotId?:string, maxRows?:number, timeoutMs?:number, injectLimit?:boolean}} [opts]
 * @returns {Promise<{rows:object[], truncated:boolean, sql:string}>}
 */
export async function queryReadOnly(sql, opts = {}) {
  const slotId = DB_SLOTS.includes(opts.slotId) ? opts.slotId : 'db1'
  const entry = slotEntry(slotId)
  const cfg = getHanaConfig(slotId)
  const safeSql = assertReadOnlySql(sql)
  const maxRows = Number.isFinite(opts.maxRows) ? opts.maxRows : cfg.maxRows
  const injectLimit = opts.injectLimit === undefined ? cfg.useLimit : Boolean(opts.injectLimit)
  const finalSql = applyRowLimit(safeSql, maxRows, injectLimit)
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : cfg.statementTimeoutMs

  return withLock(entry, async () => {
    const started = Date.now()
    let c
    try {
      c = await ensureConnected(slotId)
    } catch (err) {
      throw new Error(`HANA 连接失败：${(err && err.message) || err}`)
    }

    const rows = await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        entry.abortedCount++
        destroyClient(entry, '查询超时，已强制断开连接')
        reject(new Error(`HANA 查询超时（>${timeoutMs}ms），已主动中止以免长期占用数据库`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      c.exec(finalSql, (err, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) return reject(err)
        resolve(Array.isArray(result) ? result : [])
      })
    })

    const elapsed = Date.now() - started
    entry.lastQueryAt = Date.now()
    entry.lastQueryMs = elapsed
    entry.queryCount++

    // 客户端二次硬截断：即使驱动返回超出上限，也不会把超量数据带出本模块
    const capped = Number.isFinite(maxRows) && maxRows > 0 ? rows.slice(0, maxRows) : rows
    return { rows: capped, truncated: rows.length > capped.length, sql: finalSql }
  })
}

/** 按列名大小写不敏感取值（HANA 默认返回大写列名） */
export function pickColumn(row, name) {
  if (!row || !name) return undefined
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name]
  const target = String(name).toUpperCase()
  for (const key of Object.keys(row)) {
    if (key.toUpperCase() === target) return row[key]
  }
  return undefined
}

/** 连接/运行动态，供 /api/apc/status 展示（不含任何凭据）。返回每个槽位各自的状态 */
export function getHanaStatus() {
  return {
    configured: isAnyDatabaseConfigured(),
    slots: DB_SLOTS.map((id) => {
      const entry = slotEntry(id)
      const cfg = getHanaConfig(id)
      return {
        id,
        configured: Boolean(cfg.host && cfg.user),
        connected: entry.connected,
        connecting: entry.connecting,
        host: cfg.host || '',
        port: cfg.port,
        database: cfg.databaseName || '',
        schema: cfg.schema || '',
        useTLS: cfg.useTLS,
        maxRows: cfg.maxRows,
        statementTimeoutMs: cfg.statementTimeoutMs,
        lastError: entry.lastError,
        lastConnectAt: entry.lastConnectAt || null,
        lastQueryAt: entry.lastQueryAt || null,
        lastQueryMs: entry.lastQueryMs || null,
        queryCount: entry.queryCount,
        abortedCount: entry.abortedCount,
      }
    }),
  }
}

/** 连通性探测：最轻量的一条只读语句（slotId 指定探测哪个数据库系统） */
export async function pingHana(slotId) {
  const id = DB_SLOTS.includes(slotId) ? slotId : 'db1'
  const cfg = getHanaConfig(id)
  await queryReadOnly('SELECT 1 AS "OK" FROM DUMMY', {
    slotId: id,
    maxRows: 1,
    timeoutMs: Math.min(cfg.statementTimeoutMs, 8000),
    // 探测语句不注入 LIMIT（部分老版本 HANA 不支持 LIMIT），仅靠客户端硬截断
    injectLimit: false,
  })
  return true
}

/** 主动断开连接（进程退出 / 配置变更后重连）；slotId 缺省时断开全部槽位 */
export function closeHana(slotId) {
  const targets = slotId && DB_SLOTS.includes(slotId) ? [slotEntry(slotId)] : [...slots.values()]
  for (const entry of targets) {
    entry.connectPromise = null
    entry.connecting = false
    destroyClient(entry, '')
  }
  return Promise.resolve()
}

/** 连接目标摘要（供界面回显，**不含密码**） */
export function describeTarget(cfg) {
  return {
    host: cfg.host || '',
    port: cfg.port,
    user: cfg.user || '',
    databaseName: cfg.databaseName || '',
    schema: cfg.schema || '',
    useTLS: Boolean(cfg.useTLS),
    validateCert: cfg.validateCert !== false,
  }
}

/**
 * 用「页面草稿凭据」做一次一次性连通性测试（不落盘、不污染共享连接）。
 * 管理员在数据库登录窗口点「测试连接」时调用：先用未保存的值验证能不能连上，
 * 通过后再保存，避免把错误配置写进数据卷导致后续取数全部失败。
 *
 * @param {object} [override] 页面草稿，只覆盖显式传入的字段；password 为空则沿用已保存/环境的密码
 * @returns {Promise<{ok:boolean, elapsedMs:number, target:object, serverVersion?:string, error?:string}>}
 */
export async function testHanaConnection(override = {}, id) {
  const base = getHanaConfig(id)
  const merged = { ...base }
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined || v === null || v === '') continue
    merged[k] = v
  }
  // 密码：页面留空表示「沿用已保存的密码」，不要因为测试连接把密码清掉
  if (typeof override.password !== 'string' || override.password === '') {
    merged.password = base.password
  }

  const target = describeTarget(merged)
  const started = Date.now()

  if (!merged.host || !merged.user) {
    return { ok: false, elapsedMs: 0, target, error: '缺少数据库地址或用户名，无法测试连接' }
  }

  let hdb
  try {
    hdb = loadHdb()
  } catch (err) {
    return { ok: false, elapsedMs: Date.now() - started, target, error: String((err && err.message) || err) }
  }

  const timeoutMs = Math.max(1000, Math.min(Number(merged.connectTimeoutMs) || 8000, 30000))
  const client = hdb.createClient(buildClientOptions(merged))

  const run = (sql, execTimeoutMs) => new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`语句超时（>${execTimeoutMs}ms）`))
    }, execTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    client.exec(sql, (err, rows) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(Array.isArray(rows) ? rows : [])
    })
  })

  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`连接超时（>${timeoutMs}ms）`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      client.connect((err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      })
    })

    await run('SELECT 1 AS "OK" FROM DUMMY', Math.min(Number(merged.statementTimeoutMs) || 15000, 15000))

    // 版本号是锦上添花：无权限时忽略，不影响「连接成功」的结论
    let serverVersion = ''
    try {
      const rows = await run('SELECT VERSION FROM M_DATABASE', 5000)
      if (rows.length > 0) {
        const v = pickColumn(rows[0], 'VERSION')
        if (v != null) serverVersion = String(v)
      }
    } catch { /* 忽略：部分只读账号无 M_DATABASE 权限 */ }

    return { ok: true, elapsedMs: Date.now() - started, target, serverVersion }
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      target,
      error: String((err && err.message) || err),
    }
  } finally {
    try {
      if (typeof client.destroy === 'function') client.destroy(new Error('probe finished'))
      else if (typeof client.close === 'function') client.close()
    } catch { /* 忽略关闭异常 */ }
  }
}
