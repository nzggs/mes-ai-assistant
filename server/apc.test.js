// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  assertReadOnlySql, applyRowLimit, stripSqlComments, maskSql,
  pickColumn, queryReadOnly, isHanaConfigured,
} from './hanaClient.js'
import {
  basicStats, linearSlope, roundTo, optimizeParam, simulateValueAt,
  loadCatalog, getSourceMode, getOverview, getOptimization, getApcStatus,
  clearApcCache, listParams, getMesGuide, queryMesSql,
} from './apcService.js'
import { saveParams } from './apcConfig.js'

// 测试隔离：把运行期配置指向一个不存在的临时文件。
// 否则开发者本机数据卷里的 apc.config.json（可能配了真实库地址）会让这些用例
// 从「仿真数据源」切成「真实数据源」，导致结果不确定。配置有关的行为另见 apcConfig.test.js。
process.env.APC_CONFIG_FILE = path.join(os.tmpdir(), `apc-config-unused-${process.pid}.json`)
fs.rmSync(process.env.APC_CONFIG_FILE, { force: true })

/** 压平空白，便于比较 SQL 文本 */
function flat(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}

// ===== SQL 只读护栏 =====
// 这一层是「不把数据库搞崩 / 不改坏数据」的第一道闸门，必须严格。
describe('hanaClient · SQL 只读护栏', () => {
  it('放行单条 SELECT / WITH 查询', () => {
    expect(assertReadOnlySql('SELECT * FROM "T"')).toMatch(/^SELECT/i)
    expect(assertReadOnlySql('  with x as (select 1 from dummy) select * from x  ')).toBeTruthy()
    expect(assertReadOnlySql('SELECT 1 FROM DUMMY;')).toBe('SELECT 1 FROM DUMMY')
  })

  it('拒绝一切非查询语句', () => {
    const bad = [
      'INSERT INTO T VALUES (1)',
      'UPDATE T SET A = 1',
      'DELETE FROM T',
      'UPSERT T VALUES (1)',
      'MERGE INTO T USING S ON 1=1',
      'TRUNCATE TABLE T',
      'DROP TABLE T',
      'ALTER TABLE T ADD (A INT)',
      'CREATE TABLE T (A INT)',
      'GRANT SELECT ON T TO U',
      'REVOKE SELECT ON T FROM U',
      'CALL SOME_PROC()',
      'COMMIT',
      'ROLLBACK',
      'DO BEGIN END',
      '',
      '   ',
    ]
    for (const sql of bad) {
      expect(() => assertReadOnlySql(sql), `应拒绝：${sql}`).toThrow()
    }
  })

  it('拒绝多语句拼接与 SELECT INTO / FOR UPDATE', () => {
    expect(() => assertReadOnlySql('SELECT 1 FROM DUMMY; DROP TABLE T')).toThrow(/单条/)
    expect(() => assertReadOnlySql('SELECT 1 FROM DUMMY ; SELECT 2 FROM DUMMY')).toThrow(/单条/)
    expect(() => assertReadOnlySql('SELECT * INTO T2 FROM T')).toThrow(/INTO/)
    expect(() => assertReadOnlySql('SELECT * FROM T FOR UPDATE')).toThrow(/UPDATE/)
  })

  it('注释被完全剥离，无法夹带危险语句绕过校验', () => {
    // 执行的是剥离注释后的 SQL，因此注释里的危险语句既不会被校验拦截、也不会被执行
    const cleaned = assertReadOnlySql('/* DROP TABLE T */ SELECT 1 FROM DUMMY')
    expect(cleaned).not.toMatch(/drop/i)
    expect(flat(cleaned)).toBe('SELECT 1 FROM DUMMY')

    expect(() => assertReadOnlySql('SELECT 1 FROM DUMMY -- DROP TABLE T')).not.toThrow()
    expect(() => assertReadOnlySql('SELECT 1 FROM DUMMY /* ; DROP TABLE T */')).not.toThrow()
    // 行注释内的分号不会造成「多语句」误判
    expect(() => assertReadOnlySql('SELECT 1 FROM DUMMY -- a;b')).not.toThrow()
  })

  it('不误伤字符串字面量与带引号标识符中的关键字', () => {
    expect(() => assertReadOnlySql('SELECT "UPDATE_TIME", "CREATE_BY" FROM T')).not.toThrow()
    expect(() => assertReadOnlySql("SELECT 'drop table x' AS NOTE FROM T")).not.toThrow()
    expect(() => assertReadOnlySql("SELECT * FROM T WHERE S = 'select into'")).not.toThrow()
    // 下划线连接的列名不属于整词匹配，不应被 LAST_UPDATE 误判
    expect(() => assertReadOnlySql('SELECT LAST_UPDATE FROM T')).not.toThrow()
  })

  it('queryReadOnly 在执行入口二次拦截（连接前即拒绝）', async () => {
    await expect(queryReadOnly('DROP TABLE T')).rejects.toThrow()
    await expect(queryReadOnly('SELECT 1 FROM DUMMY; DELETE FROM T')).rejects.toThrow()
  })
})

describe('hanaClient · 行数上限', () => {
  it('默认追加 LIMIT', () => {
    expect(applyRowLimit('SELECT * FROM T', 500)).toBe('SELECT * FROM T LIMIT 500')
  })

  it('已有更小 LIMIT 时保持原样', () => {
    expect(applyRowLimit('SELECT * FROM T LIMIT 10', 500)).toBe('SELECT * FROM T LIMIT 10')
  })

  it('已有更大 LIMIT 时收紧到上限', () => {
    expect(applyRowLimit('SELECT * FROM T LIMIT 9000', 500)).toBe('SELECT * FROM T LIMIT 500')
  })

  it('已使用 SELECT TOP 时不重复注入（HANA 中 TOP 与 LIMIT 不能并用）', () => {
    expect(applyRowLimit('SELECT TOP 20 * FROM T', 500)).toBe('SELECT TOP 20 * FROM T')
  })

  it('关闭注入或上限非法时原样返回', () => {
    expect(applyRowLimit('SELECT * FROM T', 500, false)).toBe('SELECT * FROM T')
    expect(applyRowLimit('SELECT * FROM T', 0)).toBe('SELECT * FROM T')
    expect(applyRowLimit('SELECT * FROM T', NaN)).toBe('SELECT * FROM T')
  })
})

describe('hanaClient · 注释剥离与字面量屏蔽', () => {
  it('stripSqlComments 去掉注释但保留字面量', () => {
    expect(flat(stripSqlComments('SELECT 1 -- 注释\nFROM T'))).toBe('SELECT 1 FROM T')
    expect(flat(stripSqlComments('SELECT /* x */ 1 FROM T'))).toBe('SELECT 1 FROM T')
    expect(stripSqlComments("SELECT 'a--b' FROM T")).toBe("SELECT 'a--b' FROM T")
  })

  it('maskSql 用等长空格屏蔽字面量与引号标识符', () => {
    const src = 'SELECT \'drop\' FROM "update"'
    const masked = maskSql(src)
    expect(masked).not.toMatch(/drop/)
    expect(masked).not.toMatch(/update/)
    expect(masked.length).toBe(src.length)
  })
})

describe('hanaClient · 列名大小写不敏感取值', () => {
  it('兼容 HANA 默认返回大写列名', () => {
    const row = { PARAM_CODE: 'A', TS: 123, VALUE: 4.5 }
    expect(pickColumn(row, 'param_code')).toBe('A')
    expect(pickColumn(row, 'Value')).toBe(4.5)
    expect(pickColumn(row, 'missing')).toBeUndefined()
  })
})

// ===== 统计与优化引擎 =====
describe('apcService · 统计函数', () => {
  it('basicStats 计算均值/标准差/极值', () => {
    const s = basicStats([2, 4, 4, 4, 5, 5, 7, 9])
    expect(s.n).toBe(8)
    expect(s.mean).toBe(5)
    expect(s.min).toBe(2)
    expect(s.max).toBe(9)
    expect(s.std).toBeCloseTo(2.138, 2) // 样本标准差
  })

  it('basicStats 处理空数组与单点', () => {
    expect(basicStats([]).n).toBe(0)
    expect(basicStats([]).mean).toBeNaN()
    expect(basicStats([3]).std).toBe(0)
  })

  it('linearSlope 反映方向', () => {
    expect(linearSlope([1, 2, 3, 4, 5])).toBeGreaterThan(0)
    expect(linearSlope([5, 4, 3, 2, 1])).toBeLessThan(0)
    expect(linearSlope([3, 3, 3, 3])).toBe(0)
    expect(linearSlope([1, 2])).toBe(0) // 点数不足
  })

  it('roundTo 按小数位取整', () => {
    expect(roundTo(12.3456, 2)).toBe(12.35)
    expect(roundTo(12.3456, 0)).toBe(12)
  })
})

describe('apcService · 优化建议引擎', () => {
  const PARAM = {
    code: 'TEST_PARAM',
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
    sim: { sigmaScale: 3 },
  }

  function series(values) {
    return values.map((v, i) => ({ t: 1_700_000_000_000 + i * 60_000, v }))
  }

  /** 生成 n 个点，围绕 base 做微小抖动（保证 σ>0 但不至于影响结论） */
  function steady(base, n = 40) {
    return series(Array.from({ length: n }, (_, i) => base + (i % 3) * 0.005))
  }

  it('样本不足时建议保持，不做激进调整', () => {
    const r = optimizeParam(PARAM, series([12, 12, 12]))
    expect(r.recommendation.hold).toBe(true)
    expect(r.recommendation.urgency).toBe('none')
    expect(r.recommendation.confidence).toBe(30)
    expect(r.recommendation.reason).toContain('样本')
  })

  it('实测均值偏高时下调设定值，偏低时上调', () => {
    const high = optimizeParam(PARAM, steady(10.6))
    expect(high.recommendation.hold).toBe(false)
    expect(high.recommendation.suggested).toBeLessThan(PARAM.setpoint)
    expect(high.recommendation.delta).toBeLessThan(0)
    expect(high.recommendation.reason).toContain('高于')

    const low = optimizeParam(PARAM, steady(9.4))
    expect(low.recommendation.suggested).toBeGreaterThan(PARAM.setpoint)
    expect(low.recommendation.reason).toContain('低于')
  })

  it('偏差落在工艺死区内时建议保持（过程能力正常）', () => {
    const r = optimizeParam(PARAM, steady(10.03))
    expect(r.status).toBe('normal')
    expect(r.recommendation.hold).toBe(true)
    expect(r.recommendation.reason).toContain('死区')
  })

  it('单次调整受 maxStepPct 限幅并标记 clampedBy=step', () => {
    // 设定值 10、均值 9.3 → 期望修正 +0.7，但单次上限为 10*5% = 0.5
    const r = optimizeParam(PARAM, steady(9.3))
    expect(r.recommendation.hold).toBe(false)
    expect(r.recommendation.delta).toBeLessThanOrEqual(0.5 + 1e-9)
    expect(r.recommendation.clampedBy).toBe('step')
    expect(r.recommendation.urgency).toBe('high')
    expect(r.recommendation.risk).toContain('分步')
  })

  it('目标值远超可调范围时受可调上限约束', () => {
    const p = { ...PARAM, optimalTarget: 99 }
    const r = optimizeParam(p, steady(10))
    expect(r.recommendation.suggested).toBeLessThanOrEqual(p.max)
    expect(r.recommendation.clampedBy).toBe('max') // 可调上限优先于限幅
    expect(r.recommendation.risk).toContain('可调范围')
  })

  it('建议值按参数小数位取整，且给出预测均值与置信度区间', () => {
    const r = optimizeParam(PARAM, steady(10.37))
    const s = r.recommendation.suggested
    expect(Math.abs(s * 100 - Math.round(s * 100))).toBeLessThan(1e-9)
    expect(r.recommendation.predictedMean).toBeTypeOf('number')
    expect(r.recommendation.confidence).toBeGreaterThanOrEqual(30)
    expect(r.recommendation.confidence).toBeLessThanOrEqual(95)
  })

  it('统计量与状态齐备，曲线按展示上限压缩', () => {
    const r = optimizeParam(PARAM, series(Array.from({ length: 300 }, (_, i) => 9.2 + i * 0.001)))
    expect(r.sampleCount).toBe(300)
    expect(r.mean).toBeTypeOf('number')
    expect(r.std).toBeTypeOf('number')
    expect(['normal', 'warning', 'danger']).toContain(r.status)
    expect(['up', 'down', 'stable']).toContain(r.trend)
    expect(r.series.length).toBeGreaterThan(0)
    expect(r.series.length).toBeLessThanOrEqual(61)
  })

  it('均值超出规格限时判定为异常', () => {
    const r = optimizeParam(PARAM, steady(11.5))
    expect(r.status).toBe('danger')
    expect(r.recommendation.risk).toContain('批量超规格')
  })
})

// ===== 数据源与聚合接口 =====
describe('apcService · 数据源与聚合', () => {
  // 种子目录现为空（监测项由管理员在页面自行增删），先建一个参数，
  // 让「仿真数据源 / listParams / getOverview / getOptimization」等用例有数据可验证。
  beforeEach(() => {
    clearApcCache()
    saveParams([{ code: 'P1', name: '参数1', lsl: 0.9, usl: 1.1, min: 0.5, max: 1.5, setpoint: 1 }])
  })

  it('未配置 HANA 时回退到内置仿真数据源', () => {
    // 测试环境 .env 不含 HANA_* 配置 → 必须走仿真分支
    if (!isHanaConfigured()) {
      expect(getSourceMode()).toBe('simulated')
    }
    const st = getApcStatus()
    expect(st.enabled).toBe(true)
    expect(st.catalogError).toBe('')
    expect(st.paramCount).toBeGreaterThan(0)
  })

  it('参数目录字段合法（编码唯一、规格上下限与可调范围有序）', () => {
    const params = listParams()
    expect(params.length).toBeGreaterThan(0)
    const codes = new Set()
    for (const p of params) {
      expect(p.code).toMatch(/^[A-Za-z0-9_]{1,64}$/)
      expect(codes.has(p.code)).toBe(false)
      codes.add(p.code)
      expect(p.lsl).toBeLessThan(p.usl)
      expect(p.min).toBeLessThan(p.max)
      expect(p.maxStepPct).toBeGreaterThan(0)
      expect(Number.isFinite(p.setpoint)).toBe(true)
    }
  })

  it('仿真值对同一时间戳稳定、随时间变化', () => {
    const p = listParams()[0]
    const t = 1_700_000_000_000
    expect(simulateValueAt(p, t)).toBe(simulateValueAt(p, t))
    expect(simulateValueAt(p, t)).not.toBe(simulateValueAt(p, t + 600_000))
  })

  it('getOverview 返回全部参数的实时值与曲线', async () => {
    const ov = await getOverview({ minutes: 60 })
    expect(ov.params.length).toBe(listParams().length)
    expect(ov.windowMinutes).toBe(60)
    expect(ov.rowCount).toBeGreaterThan(0)
    expect(ov.source.label).toBeTruthy()
    for (const p of ov.params) {
      expect(p.series.length).toBeGreaterThan(1)
      expect(p.recommendation).toBeTruthy()
      expect(p.latest).not.toBeNull()
    }
  })

  it('getOptimization 汇总口径与条目一致，需调整项排在保持项之前', async () => {
    const op = await getOptimization({ minutes: 60 })
    expect(op.items.length).toBe(op.summary.total)
    expect(op.summary.actionable).toBe(op.items.filter(i => !i.recommendation.hold).length)
    expect(op.summary.danger).toBe(op.items.filter(i => i.status === 'danger').length)
    const firstHold = op.items.findIndex(i => i.recommendation.hold)
    if (firstHold >= 0) {
      expect(op.items.slice(firstHold).every(i => i.recommendation.hold)).toBe(true)
    }
  })

  it('按参数编码过滤只返回指定参数', async () => {
    const all = listParams()
    const code = all[0].code
    const op = await getOptimization({ minutes: 30, codes: [code] })
    expect(op.items.length).toBe(1)
    expect(op.items[0].code).toBe(code)
  })
})

// ===== 按参数绑定数据库槽位（dbSlot）与 MES 直查 =====
describe('apcService · 按参数绑定数据库与 MES 直查', () => {
  beforeEach(() => clearApcCache())

  it('项目绑定数据库：参数 dbSlot 统一为项目槽位，非法槽位被拒绝', () => {
    saveParams([
      { code: 'A1', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5 },
      { code: 'A2', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5, dbSlot: 'db2' },
    ])
    const params = listParams()
    // 项目的取数库在项目层面决定：所有参数统一跟随项目槽位（缺省项目 = db1）
    expect(params.find(p => p.code === 'A1').dbSlot).toBe('db1')
    expect(params.find(p => p.code === 'A2').dbSlot).toBe('db1')
    expect(() => saveParams([
      { code: 'B1', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5, dbSlot: 'db3' },
    ])).toThrow(/使用数据库/)
  })

  it('getMesGuide 只返回槽位与硬性限制（SQL 从知识库检索，与项目模板无关）', () => {
    saveParams([{ code: 'G1', name: '参数G', unit: 'V', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5, dbSlot: 'db2' }])
    const guide = getMesGuide()
    expect(guide.slots.map(s => s.id)).toEqual(['db1', 'db2'])
    expect(guide.slots[0].configured).toBe(false)
    expect(guide.limits.chatRows).toBeGreaterThan(0)
    // 问答环节与项目 SQL 模板/参数白名单解耦
    expect(guide.template).toBeUndefined()
    expect(guide.params).toBeUndefined()
    expect(JSON.stringify(guide)).not.toContain('password')
  })

  it('queryMesSql 硬护栏：缺槽位 / 占位符残留 / 未配置槽位 / 非 SELECT 一律拒绝', async () => {
    // 缺槽位
    await expect(queryMesSql({ sql: 'SELECT 1 FROM DUMMY' })).rejects.toMatchObject({ status: 400 })
    await expect(queryMesSql({ slot: 'db9', sql: 'SELECT 1 FROM DUMMY' })).rejects.toMatchObject({ status: 400 })
    // 模板占位符未代入
    await expect(queryMesSql({ slot: 'db1', sql: 'SELECT {{minutes}} FROM DUMMY' })).rejects.toMatchObject({ status: 400 })
    // 非 SELECT（护栏在未配置检查之后仍会拦截——用一个「已配置」的槽位概念无法满足时，先看未配置分支）
    await expect(queryMesSql({ slot: 'db1', sql: 'DELETE FROM T' })).rejects.toThrow()
    // 测试环境未配置任何槽位 → 明确 400 而不是回退仿真
    await expect(queryMesSql({ slot: 'db1', sql: 'SELECT 1 FROM DUMMY' })).rejects.toMatchObject({ status: 400 })
  })
})

// ===== 参数目录校验 =====
describe('apcService · 参数目录校验', () => {
  const original = process.env.APC_CATALOG_FILE
  const tmpFiles = []

  function writeCatalog(content) {
    const file = path.join(os.tmpdir(), `apc-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(file, content, 'utf8')
    tmpFiles.push(file)
    return file
  }

  afterEach(() => {
    if (original === undefined) delete process.env.APC_CATALOG_FILE
    else process.env.APC_CATALOG_FILE = original
    for (const f of tmpFiles.splice(0)) {
      try { fs.unlinkSync(f) } catch { /* 忽略清理失败 */ }
    }
    loadCatalog(true)
  })

  it('拒绝重复的参数编码', () => {
    const file = writeCatalog(JSON.stringify({
      params: [
        { code: 'A', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5 },
        { code: 'A', lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5 },
      ],
    }))
    process.env.APC_CATALOG_FILE = file
    expect(() => loadCatalog(true)).toThrow(/重复/)
  })

  it('拒绝非法参数编码（防 SQL 注入）', () => {
    const file = writeCatalog(JSON.stringify({
      params: [{ code: "A'; DROP TABLE T--", lsl: 0, usl: 1, min: -1, max: 2, setpoint: 0.5 }],
    }))
    process.env.APC_CATALOG_FILE = file
    expect(() => loadCatalog(true)).toThrow(/code 非法/)
  })

  it('拒绝缺失参数数组', () => {
    const file = writeCatalog(JSON.stringify({ station: 'x' }))
    process.env.APC_CATALOG_FILE = file
    expect(() => loadCatalog(true)).toThrow(/params/)
  })
})
