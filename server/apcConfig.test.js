// @vitest-environment node
//
// APC / RTO 运行期配置的测试：
//   ① 取值优先级（页面保存 > 环境变量 > 默认）
//   ② 密码只进不出
//   ③ 取数 SQL / 参数目录的校验与拦截
//   ④ meta 平铺键与各段重置
//   ⑤ 宽表取数模板与 SQL 试运行
//
// 隔离方式：把 APC_CONFIG_FILE 指向临时文件，用例之间互不影响，
// 也不会写坏开发者本机数据卷里的真实配置。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getEffectiveHanaConfig, isDataSourceConfigured, saveDatabase, saveQueries,
  saveParams, saveMeta, resetSection, getConfigForClient, getEffectiveCatalog,
  invalidateConfigCache, setActiveDatabase, getActiveDatabaseId, getDatabases,
} from './apcConfig.js'
import { loadCatalog, buildTemplateVars, buildHistorySql, previewQuery } from './apcService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP_CONFIG = path.join(os.tmpdir(), `apc-config-test-${process.pid}.json`)
const SEED_FILE = path.join(__dirname, 'apc.catalog.json')
const ENV_KEYS = [
  'HANA_HOST', 'HANA_PORT', 'HANA_USER', 'HANA_PASSWORD', 'HANA_DATABASE',
  'HANA_USE_TLS', 'HANA_MAX_ROWS', 'HANA_STATEMENT_TIMEOUT_MS', 'APC_CATALOG_FILE',
]

const OK_COLUMNS = { code: 'PARAM_CODE', ts: 'TS', value: 'VALUE' }
const OK_SQL =
  'SELECT "PARAM_CODE", "TS", "VALUE" FROM "MES_PROCESS_HIST" ' +
  'WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}){{codeFilter}} ' +
  'ORDER BY "TS" ASC LIMIT {{limit}}'
const WIDE_SQL =
  'SELECT "TS", {{columns}} FROM "MES_PROCESS_HIST" ' +
  'WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}) LIMIT {{limit}}'

let originalEnv = {}

beforeEach(() => {
  originalEnv = {}
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k]
    delete process.env[k]
  }
  fs.rmSync(TMP_CONFIG, { force: true })
  process.env.APC_CONFIG_FILE = TMP_CONFIG
  invalidateConfigCache()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k]
    else process.env[k] = originalEnv[k]
  }
  delete process.env.APC_CONFIG_FILE
  invalidateConfigCache()
  fs.rmSync(TMP_CONFIG, { force: true })
})

// ===== 取值优先级 =====

describe('apcConfig · 取值优先级', () => {
  it('未保存任何配置时使用内置默认，且被视为「未配置」', () => {
    const c = getEffectiveHanaConfig()
    expect(c.port).toBe(30015)
    expect(c.maxRows).toBe(2000)
    expect(c.statementTimeoutMs).toBe(15000)
    expect(c.useTLS).toBe(false)
    expect(c.useLimit).toBe(true)
    expect(isDataSourceConfigured()).toBe(false)
    expect(getConfigForClient().configFileExists).toBe(false)
  })

  it('环境变量提供取值，地址 + 用户名齐备即视为已配置', () => {
    process.env.HANA_HOST = '10.1.1.1'
    process.env.HANA_USER = 'RO_USER'
    process.env.HANA_PASSWORD = 'env-secret'
    process.env.HANA_MAX_ROWS = '777'
    invalidateConfigCache()
    const c = getEffectiveHanaConfig()
    expect(c.host).toBe('10.1.1.1')
    expect(c.maxRows).toBe(777)
    expect(isDataSourceConfigured()).toBe(true)
  })

  it('页面保存值优先于环境变量，未覆盖的字段仍继承环境变量', () => {
    process.env.HANA_HOST = '10.1.1.1'
    process.env.HANA_USER = 'RO_USER'
    process.env.HANA_PASSWORD = 'env-secret'
    invalidateConfigCache()

    saveDatabase('db1', { host: '10.2.2.2', maxRows: 500 })
    const c = getEffectiveHanaConfig()
    expect(c.host).toBe('10.2.2.2')       // 页面覆盖
    expect(c.maxRows).toBe(500)           // 页面覆盖
    expect(c.user).toBe('RO_USER')        // 环境变量
    expect(c.password).toBe('env-secret') // 未提交密码 → 保持环境变量密码

    const view = getConfigForClient()
    const slot = view.database.slots.find(s => s.id === 'db1')
    expect(slot.savedKeys).toContain('host')
    expect(view.database.envConfigured).toBe(true)
  })

  it('关闭类布尔值（useTLS=false）也能覆盖环境变量的 true', () => {
    process.env.HANA_USE_TLS = 'true'
    invalidateConfigCache()
    expect(getEffectiveHanaConfig().useTLS).toBe(true)
    saveDatabase('db1', { useTLS: false })
    expect(getEffectiveHanaConfig().useTLS).toBe(false)
  })
})

// ===== 密码只进不出 =====

describe('apcConfig · 密码只进不出', () => {
  it('配置视图不含密码原文，只回 passwordSet', () => {
    saveDatabase('db1', { host: 'hana.prod', user: 'RO', password: 'p@ssw0rd!' })
    const view = getConfigForClient()
    const slot = view.database.slots.find(s => s.id === 'db1')
    expect(slot.passwordSet).toBe(true)
    expect(slot.values).not.toHaveProperty('password')
    expect(JSON.stringify(view)).not.toContain('p@ssw0rd!')
    // 服务端自己必须记得住（否则取数连不上）
    expect(getEffectiveHanaConfig('db1').password).toBe('p@ssw0rd!')
  })

  it('密码三态：不提交=保持；空串=保持；null=清除', () => {
    saveDatabase('db1', { host: 'h', user: 'u', password: 'p@ss' })
    saveDatabase('db1', { host: 'h' })
    expect(getEffectiveHanaConfig('db1').password).toBe('p@ss')
    // 页面上留空（提交空串）→ 保持原密码，不能因为保存一次就把密码清掉
    saveDatabase('db1', { host: 'h', user: 'u', password: '' })
    expect(getEffectiveHanaConfig('db1').password).toBe('p@ss')
    // 显式清除
    saveDatabase('db1', { password: null })
    expect(getEffectiveHanaConfig('db1').password).toBe('')
    expect(getConfigForClient().database.slots.find(s => s.id === 'db1').passwordSet).toBe(false)
  })

  it('配置原子落盘且带时间戳', () => {
    saveDatabase('db1', { host: 'h', user: 'u', password: 'secret' })
    const raw = JSON.parse(fs.readFileSync(TMP_CONFIG, 'utf8'))
    expect(raw.databases.db1.password).toBe('secret')
    expect(typeof raw.updatedAt).toBe('string')
    expect(fs.existsSync(`${TMP_CONFIG}.tmp-${process.pid}`)).toBe(false)
  })

  it('字段范围与格式校验', () => {
    expect(() => saveDatabase('db1', { port: 99999 })).toThrow(/端口|范围/)
    expect(() => saveDatabase('db1', { port: 0 })).toThrow(/范围/)
    expect(() => saveDatabase('db1', { host: 'a b; rm -rf /' })).toThrow(/地址/)
    expect(() => saveDatabase('db1', { maxRows: 999999 })).toThrow(/范围/)
    expect(() => saveDatabase('db1', {})).toThrow(/没有可保存/)
    expect(() => saveDatabase('dbX', { host: 'x' })).toThrow(/槽位/)
  })
})

// ===== 取数 SQL 校验 =====

describe('apcConfig · 取数 SQL 校验', () => {
  it('接受合法模板并立即生效', () => {
    saveQueries({ mode: 'long', history: OK_SQL, columns: OK_COLUMNS })
    const q = getEffectiveCatalog().queries
    expect(q.mode).toBe('long')
    expect(q.history).toContain('{{minutes}}')
    expect(q.columns.value).toBe('VALUE')
  })

  it('拒绝非只读语句、多语句与 SELECT INTO', () => {
    expect(() => saveQueries({ mode: 'long', history: 'DELETE FROM T', columns: OK_COLUMNS })).toThrow()
    expect(() => saveQueries({ mode: 'long', history: 'UPDATE T SET A=1 WHERE {{minutes}}=1', columns: OK_COLUMNS })).toThrow()
    expect(() => saveQueries({ mode: 'long', history: 'SELECT 1 FROM T; DROP TABLE T', columns: OK_COLUMNS })).toThrow(/单条/)
    expect(() => saveQueries({ mode: 'long', history: 'SELECT * INTO T2 FROM T WHERE {{minutes}}=1', columns: OK_COLUMNS })).toThrow()
    // 注释夹带也不例外
    expect(() => saveQueries({ mode: 'long', history: '/* DROP TABLE T */ SELECT {{minutes}} FROM T', columns: OK_COLUMNS })).not.toThrow()
  })

  it('拒绝未知占位符与完全不用占位符的模板', () => {
    expect(() => saveQueries({ mode: 'long', history: 'SELECT {{oops}} FROM T', columns: OK_COLUMNS })).toThrow(/占位符/)
    expect(() => saveQueries({ mode: 'long', history: 'SELECT 1 FROM T', columns: OK_COLUMNS })).toThrow(/占位符/)
  })

  it('拒绝非法列名（防注入）与缺失的映射列', () => {
    expect(() => saveQueries({
      mode: 'long', history: OK_SQL,
      columns: { ...OK_COLUMNS, value: 'V" ; DROP TABLE T' },
    })).toThrow(/非法/)
    expect(() => saveQueries({ mode: 'long', history: OK_SQL, columns: { code: 'C', ts: 'T' } })).toThrow(/数值列/)
    expect(() => saveQueries({ mode: 'long', history: OK_SQL, columns: { ts: 'T', value: 'V' } })).toThrow(/参数编码列/)
  })

  it('宽表模式必须给每个参数配数据列名，配齐后才允许保存', () => {
    // 种子目录现为空（监测项由管理员自行增删），先建一个未配列名的参数，宽表校验才会触发
    saveParams([{ code: 'P1', name: '参数1', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5 }])
    expect(() => saveQueries({ mode: 'wide', history: WIDE_SQL, columns: { ts: 'TS' } })).toThrow(/数据列名/)

    const withColumns = getEffectiveCatalog().params.map((p, i) => ({ ...p, column: `TAG_${i}` }))
    saveParams(withColumns)
    const q = saveQueries({ mode: 'wide', history: WIDE_SQL, columns: { ts: 'TS' } })
    expect(q.mode).toBe('wide')
    expect(getEffectiveCatalog().queries.mode).toBe('wide')
  })
})

// ===== 参数目录校验 =====

describe('apcConfig · 参数目录校验', () => {
  const base = { lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5 }

  it('拒绝重复编码 / 规格倒挂 / 非法编码（空数组已放开允许）', () => {
    expect(() => saveParams([{ ...base, code: 'A' }, { ...base, code: 'A' }])).toThrow(/重复/)
    expect(() => saveParams([{ ...base, code: 'B', lsl: 5, usl: 1 }])).toThrow(/规格上下限/)
    expect(() => saveParams([{ ...base, code: 'C', min: 9, max: 3 }])).toThrow(/可调范围/)
    expect(() => saveParams([{ ...base, code: "D'; DROP TABLE T--" }])).toThrow(/code 非法/)
    // 空数组已放开：监测项完全由管理员自行增删，「一个都不配」是合法状态
    expect(saveParams([])).toEqual([])
  })

  it('保存后 loadCatalog 立即反映改动', () => {
    // 种子目录现为空，先建一个参数，再验证改名能立即反映
    saveParams([{ code: 'P1', name: '原始参数', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5 }])
    const next = getEffectiveCatalog().params.map((x, i) =>
      i === 0 ? { ...x, name: '改名后的参数', maxStepPct: 4.5 } : x
    )
    saveParams(next)
    const cat = loadCatalog(true)
    expect(cat.params[0].name).toBe('改名后的参数')
    expect(cat.params[0].maxStepPct).toBe(4.5)
    expect(cat.params.length).toBe(next.length)
  })

  it('缺省工艺死区取自目录默认值', () => {
    saveMeta({ deadbandPctDefault: 25 })
    const p = { ...base, code: 'NODB' }
    saveParams([{ ...p, name: '不带死区' }])
    expect(getEffectiveCatalog().params[0].deadbandPct).toBe(25)
    saveParams([{ ...p, name: '带死区', deadbandPct: 5 }])
    expect(getEffectiveCatalog().params[0].deadbandPct).toBe(5)
  })
})

// ===== meta 与重置 =====

describe('apcConfig · 元信息与重置', () => {
  it('saveMeta 生效，resetSection("meta") 能把平铺的四个键一起清掉', () => {
    saveMeta({ station: '验证线', sampleIntervalSec: 60, defaultWindowMinutes: 30, deadbandPctDefault: 5 })
    let cat = getEffectiveCatalog()
    expect(cat.station).toBe('验证线')
    expect(cat.sampleIntervalSec).toBe(60)
    expect(cat.defaultWindowMinutes).toBe(30)

    resetSection('meta')
    cat = getEffectiveCatalog()
    expect(cat.station).not.toBe('验证线')
    expect(cat.defaultWindowMinutes).toBe(120)
    expect(cat.sampleIntervalSec).toBe(120)
    expect(cat.deadbandPctDefault).toBe(10)
  })

  it('各段可独立重置，非法段名被拒', () => {
    saveDatabase('db1', { host: 'h', user: 'u' })
    saveParams([{ code: 'T1', name: 'N0', process: 'x', unit: '', decimals: 2, setpoint: 1, optimalTarget: 1, lsl: 0.9, usl: 1.1, min: 0.5, max: 1.5, maxStepPct: 3, deadbandPct: 10, objective: 'quality', processGain: 1, column: '', sim: { sigmaScale: 1 } }])
    resetSection('params')
    expect(getEffectiveCatalog().params.find(p => p.name === 'N0')).toBeUndefined()
    resetSection('database')
    expect(getConfigForClient().database.slots.every(s => s.savedKeys.length === 0)).toBe(true)
    expect(getEffectiveHanaConfig().host).toBe('')
    expect(() => resetSection('nope')).toThrow(/不支持/)
    expect(() => resetSection('')).toThrow(/不支持/)
  })

  it('meta 越界值与空补丁被拒', () => {
    expect(() => saveMeta({ sampleIntervalSec: 1 })).toThrow(/采样间隔/)
    expect(() => saveMeta({ defaultWindowMinutes: 99999 })).toThrow(/统计窗口/)
    expect(() => saveMeta({ deadbandPctDefault: 300 })).toThrow(/死区/)
    expect(() => saveMeta({})).toThrow(/没有可保存/)
  })
})

// ===== 双数据库系统槽位与切换 =====

describe('apcConfig · 双数据库系统槽位与切换', () => {
  it('两个槽位独立保存，互不干扰；缺省 active 为 db1', () => {
    expect(getActiveDatabaseId()).toBe('db1')
    saveDatabase('db1', { host: '10.1.1.1', user: 'U1' })
    saveDatabase('db2', { host: '10.2.2.2', user: 'U2' })
    const view = getConfigForClient()
    expect(view.database.activeId).toBe('db1')
    expect(view.database.slots).toHaveLength(2)
    expect(getEffectiveHanaConfig('db1').host).toBe('10.1.1.1')
    expect(getEffectiveHanaConfig('db2').host).toBe('10.2.2.2')
    expect(getEffectiveHanaConfig().host).toBe('10.1.1.1') // 默认取 active
  })

  it('setActiveDatabase 切换当前使用的数据源', () => {
    saveDatabase('db1', { host: '10.1.1.1', user: 'U1' })
    saveDatabase('db2', { host: '10.2.2.2', user: 'U2' })
    setActiveDatabase('db2')
    expect(getActiveDatabaseId()).toBe('db2')
    expect(getEffectiveHanaConfig().host).toBe('10.2.2.2')
    expect(getConfigForClient().database.activeId).toBe('db2')
  })

  it('resetSection(database, db2) 只清空指定槽位', () => {
    saveDatabase('db1', { host: '10.1.1.1', user: 'U1' })
    saveDatabase('db2', { host: '10.2.2.2', user: 'U2' })
    resetSection('database', 'db2')
    const view = getConfigForClient()
    const db1 = view.database.slots.find(s => s.id === 'db1')
    const db2 = view.database.slots.find(s => s.id === 'db2')
    expect(db1.savedKeys).toContain('host')
    expect(db2.savedKeys).not.toContain('host')
    expect(getEffectiveHanaConfig('db1').host).toBe('10.1.1.1')
    expect(getEffectiveHanaConfig('db2').host).toBe('')
  })

  it('槽位显示名可手工设置，缺省回退到默认名', () => {
    saveDatabase('db2', { host: 'h', user: 'u', name: '二厂HANA' })
    const view = getConfigForClient()
    expect(view.database.slots.find(s => s.id === 'db2').name).toBe('二厂HANA')
    expect(view.database.slots.find(s => s.id === 'db1').name).toBe('数据库系统 1')
  })

  it('历史单库配置自动迁移进 db1 槽位', () => {
    fs.writeFileSync(TMP_CONFIG, JSON.stringify({ version: 1, database: { host: 'legacy', user: 'lu' }, catalog: {} }))
    invalidateConfigCache()
    expect(getEffectiveHanaConfig('db1').host).toBe('legacy')
    expect(getDatabases().db1.host).toBe('legacy')
  })
})

// ===== APC_CATALOG_FILE 锁定 =====

describe('apcConfig · APC_CATALOG_FILE 锁定', () => {
  it('锁定时目录类保存被明确拒绝，数据库配置仍可保存', () => {
    process.env.APC_CATALOG_FILE = SEED_FILE
    invalidateConfigCache()
    const view = getConfigForClient()
    expect(view.catalogFileLocked).toBe(true)
    expect(view.seedFile).toBe(SEED_FILE)

    expect(() => saveQueries({ mode: 'long', history: OK_SQL, columns: OK_COLUMNS })).toThrow(/APC_CATALOG_FILE/)
    expect(() => saveParams(getEffectiveCatalog().params)).toThrow(/APC_CATALOG_FILE/)
    expect(() => saveMeta({ station: 'x' })).toThrow(/APC_CATALOG_FILE/)
    expect(() => resetSection('params')).toThrow(/APC_CATALOG_FILE/)

    saveDatabase('db1', { host: 'still-works' })
    expect(getEffectiveHanaConfig().host).toBe('still-works')
  })
})

// ===== 宽表模板渲染 =====

describe('apcService · 取数模板渲染', () => {
  const params = [{ code: 'A', column: 'TAG_A' }, { code: 'B', column: 'TAG_B' }]

  it('窄表生成 codeFilter，宽表生成 columns', () => {
    const longVars = buildTemplateVars(
      { params, queries: { mode: 'long', columns: { code: 'PARAM_CODE' } } },
      { minutes: 60, limit: 50, codes: ['A', 'B'], params }
    )
    expect(longVars.codeFilter).toBe(` AND "PARAM_CODE" IN ('A', 'B')`)
    expect(longVars.columns).toBe('')
    expect(longVars.minutes).toBe('60')
    expect(longVars.limit).toBe('50')

    const wideVars = buildTemplateVars(
      { params, queries: { mode: 'wide' } },
      { minutes: 90, limit: 10, params }
    )
    expect(wideVars.columns).toBe('"TAG_A", "TAG_B"')
    expect(wideVars.codeFilter).toBe('')
    expect(wideVars.minutes).toBe('90')
  })

  it('schema 占位符取自目录元信息', () => {
    const vars = buildTemplateVars(
      { schema: 'MES', params, queries: { mode: 'long', columns: {} } },
      { minutes: 5, limit: 5, codes: [], params: [] }
    )
    expect(vars.schema).toBe('MES')
  })

  it('宽表参数缺列名时渲染即报错，不会拿坏 SQL 去打库', () => {
    const catalog = { queries: { mode: 'wide', history: 'SELECT {{columns}} FROM T' }, params: [{ code: 'A' }] }
    expect(() => buildHistorySql(catalog, { minutes: 10, limit: 10, params: [{ code: 'A' }] })).toThrow(/数据列名/)
  })

  it('未配置取数模板时明确报错', () => {
    expect(() => buildHistorySql({ queries: null, params: [] }, { minutes: 10, limit: 10 })).toThrow(/取数模板/)
  })
})

// ===== SQL 试运行 =====

describe('apcService · SQL 试运行', () => {
  it('未配置只读数据源时给出可读错误，而不是静默失败', async () => {
    await expect(previewQuery({})).rejects.toThrow(/数据库连接/)
  })

  it('草稿非法同样被拦截：试运行不能成为绕过护栏的口子', async () => {
    process.env.HANA_HOST = '127.0.0.1'
    process.env.HANA_USER = 'ro'
    invalidateConfigCache()

    // 非只读语句
    await expect(previewQuery({
      queries: { mode: 'long', history: 'DROP TABLE T', columns: OK_COLUMNS },
    })).rejects.toThrow()
    // 多语句
    await expect(previewQuery({
      queries: { mode: 'long', history: 'SELECT {{minutes}} FROM T; DELETE FROM T', columns: OK_COLUMNS },
    })).rejects.toThrow(/单条/)
    // 映射不全（缺数值列）
    await expect(previewQuery({
      queries: { mode: 'long', history: OK_SQL, columns: { code: 'C', ts: 'T' } },
    })).rejects.toThrow(/数值列/)
    // 未知占位符
    await expect(previewQuery({
      queries: { mode: 'long', history: 'SELECT {{minutes}} FROM T WHERE {{x}}=1', columns: OK_COLUMNS },
    })).rejects.toThrow(/占位符/)
  })
})
