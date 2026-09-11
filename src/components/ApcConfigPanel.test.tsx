import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ApcConfigResponse } from '../types'

// 接口层打桩：只验证三个配置窗口的渲染与交互，不触碰真实后端
const mocks = vi.hoisted(() => ({
  fetchApcConfig: vi.fn(),
  saveApcConfig: vi.fn(),
  resetApcConfig: vi.fn(),
  testApcDatabase: vi.fn(),
  previewApcQuery: vi.fn(),
  setAdminToken: vi.fn(),
  hasAdminToken: vi.fn(() => true),
}))

vi.mock('../services/apcApi', () => ({
  fetchApcConfig: mocks.fetchApcConfig,
  saveApcConfig: mocks.saveApcConfig,
  resetApcConfig: mocks.resetApcConfig,
  testApcDatabase: mocks.testApcDatabase,
  previewApcQuery: mocks.previewApcQuery,
  setAdminToken: mocks.setAdminToken,
  hasAdminToken: mocks.hasAdminToken,
}))

import { ApcConfigPanel } from './ApcConfigPanel'

const QUERY_SQL =
  'SELECT "PARAM_CODE", "TS", "VALUE" FROM "MES_PROCESS_HIST" ' +
  'WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}){{codeFilter}} LIMIT {{limit}}'

function makeConfig(): ApcConfigResponse {
  return {
    configFile: '/data/apc.config.json',
    configFileExists: true,
    configFileError: '',
    updatedAt: '2026-09-11T02:00:00.000Z',
    catalogFileLocked: false,
    seedFile: '/app/server/apc.catalog.json',
    database: {
      activeId: 'db1',
      slots: [
        {
          id: 'db1',
          name: '数据库系统 1',
          values: {
            host: '10.0.0.21',
            port: 30015,
            user: 'RO_APC',
            databaseName: '',
            schema: 'MES',
            useTLS: false,
            validateCert: true,
            caFile: '',
            connectTimeoutMs: 8000,
            statementTimeoutMs: 15000,
            maxRows: 2000,
            useLimit: true,
          },
          passwordSet: true,
          savedKeys: ['host', 'user'],
          configured: true,
        },
        {
          id: 'db2',
          name: '数据库系统 2',
          values: {
            host: '',
            port: 30015,
            user: '',
            databaseName: '',
            schema: '',
            useTLS: false,
            validateCert: true,
            caFile: '',
            connectTimeoutMs: 8000,
            statementTimeoutMs: 15000,
            maxRows: 2000,
            useLimit: true,
          },
          passwordSet: false,
          savedKeys: [],
          configured: false,
        },
      ],
      envConfigured: false,
      envValues: { port: 30015, maxRows: 2000, passwordSet: false },
      defaults: {
        port: 30015,
        maxRows: 2000,
        connectTimeoutMs: 8000,
        statementTimeoutMs: 15000,
        useTLS: false,
        validateCert: true,
        useLimit: true,
      },
    },
    queries: { mode: 'long', history: QUERY_SQL, columns: { code: 'PARAM_CODE', ts: 'TS', value: 'VALUE' } },
    params: [
      {
        code: 'COATING_DENSITY',
        name: '正极涂布面密度',
        process: '涂布',
        unit: 'mg/cm²',
        decimals: 2,
        setpoint: 12.6,
        optimalTarget: 12.6,
        lsl: 12.3,
        usl: 12.9,
        min: 11.8,
        max: 13.4,
        maxStepPct: 2,
        deadbandPct: 10,
        objective: 'quality',
        processGain: 1,
        column: '',
        sim: { sigmaScale: 3 },
      },
      {
        code: 'CALENDER_GAP',
        name: '辊压辊缝',
        process: '辊压',
        unit: 'µm',
        decimals: 1,
        setpoint: 62,
        optimalTarget: 62,
        lsl: 60.5,
        usl: 63.5,
        min: 58,
        max: 67,
        maxStepPct: 2,
        deadbandPct: 10,
        objective: 'quality',
        processGain: 1,
        column: '',
      },
    ],
    meta: { station: '消费类聚合物锂离子电池 · 极片与电芯产线', sampleIntervalSec: 120, defaultWindowMinutes: 120, deadbandPctDefault: 10 },
    catalogError: '',
  }
}

function renderPanel() {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(<ApcConfigPanel onClose={onClose} onSaved={onSaved} />)
  return { onClose, onSaved }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchApcConfig.mockResolvedValue(makeConfig())
  mocks.hasAdminToken.mockReturnValue(true)
})

describe('ApcConfigPanel · 数据库登录窗口', () => {
  it('回显生效的连接参数，且不回显密码原文', async () => {
    renderPanel()
    expect(await screen.findByDisplayValue('10.0.0.21')).toBeInTheDocument()
    expect(screen.getByDisplayValue('RO_APC')).toBeInTheDocument()
    expect(screen.getByDisplayValue('MES')).toBeInTheDocument()
    // 密码框：有已保存密码时提示留空即不修改，且不出现密码原文
    const pw = screen.getByPlaceholderText(/留空表示不修改/)
    expect(pw).toHaveAttribute('type', 'password')
    expect(pw).toHaveValue('')
  })

  it('标注每个配置项的来源（页面配置 / 环境变量 / 默认值）', async () => {
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    expect(screen.getAllByText('页面配置').length).toBeGreaterThan(0)
    expect(screen.getAllByText('默认值').length).toBeGreaterThan(0)
  })

  it('测试连接使用页面草稿值，并展示结果与版本', async () => {
    mocks.testApcDatabase.mockResolvedValue({
      ok: true,
      elapsedMs: 42,
      serverVersion: '2.00.075.00',
      target: { host: '10.0.0.21', port: 30015, user: 'RO_APC', databaseName: '', schema: 'MES', useTLS: false, validateCert: true },
    })
    renderPanel()
    const hostInput = await screen.findByDisplayValue('10.0.0.21')
    fireEvent.change(hostInput, { target: { value: '10.9.9.9' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    await waitFor(() => expect(mocks.testApcDatabase).toHaveBeenCalled())
    expect(mocks.testApcDatabase.mock.calls[0][0]).toMatchObject({ host: '10.9.9.9' })
    expect(await screen.findByText(/连接成功/)).toBeInTheDocument()
    expect(screen.getByText(/2\.00\.075\.00/)).toBeInTheDocument()
  })

  it('测试失败时展示失败原因与目标', async () => {
    mocks.testApcDatabase.mockResolvedValue({
      ok: false,
      elapsedMs: 8001,
      error: '连接超时（>8000ms）',
      target: { host: '10.0.0.21', port: 30015, user: 'RO_APC', databaseName: '', schema: '', useTLS: false, validateCert: true },
    })
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText(/连接失败/)).toBeInTheDocument()
    expect(screen.getByText(/原因：连接超时/)).toBeInTheDocument()
  })

  it('改动后点保存，只提交 databases 段（按槽位）', async () => {
    mocks.saveApcConfig.mockResolvedValue({ ok: true, saved: ['database'], config: makeConfig() })
    const { onSaved } = renderPanel()
    const hostInput = await screen.findByDisplayValue('10.0.0.21')
    fireEvent.change(hostInput, { target: { value: '10.3.3.3' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.saveApcConfig).toHaveBeenCalledTimes(1))
    const patch = mocks.saveApcConfig.mock.calls[0][0]
    expect(Object.keys(patch)).toEqual(['databases'])
    expect(patch.databases.db1.host).toBe('10.3.3.3')
    expect(patch.databases.db1.password).toBeUndefined() // 未输入密码 → 不提交，服务端保持原值
    expect(onSaved).toHaveBeenCalled()
  })

  it('勾选「清除已保存的密码」后以 null 提交，表示显式清除', async () => {
    mocks.saveApcConfig.mockResolvedValue({ ok: true, saved: ['database'], config: makeConfig() })
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByLabelText('清除已保存的密码'))
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.saveApcConfig).toHaveBeenCalledTimes(1))
    expect(mocks.saveApcConfig.mock.calls[0][0].databases.db1.password).toBeNull()
  })

  it('缺少管理员令牌时给出令牌输入入口而不是直接报错', async () => {
    const err = Object.assign(new Error('需要管理员令牌（ADMIN_TOKEN）'), { status: 403 })
    mocks.fetchApcConfig.mockRejectedValue(err)
    renderPanel()
    expect(await screen.findByText(/需要管理员令牌/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('粘贴 ADMIN_TOKEN')).toBeInTheDocument()
  })
})

describe('ApcConfigPanel · 双数据库系统分页与切换', () => {
  it('数据库登录窗口渲染两个系统标签页，并标出当前使用', async () => {
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    expect(screen.getByRole('button', { name: /数据库系统 1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /数据库系统 2/ })).toBeInTheDocument()
    expect(screen.getByText('当前使用')).toBeInTheDocument() // db1 是 active
  })

  it('切换到第二个系统后显示其空配置，并通过「切换为当前使用」改变数据源', async () => {
    mocks.saveApcConfig.mockResolvedValue({ ok: true, saved: ['database'], config: makeConfig() })
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByRole('button', { name: /数据库系统 2/ }))
    // db2 未配置 → 地址输入框为空
    expect(screen.getByPlaceholderText(/如 10\.0\.0\.21/)).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '切换为当前使用' }))

    await waitFor(() => expect(mocks.saveApcConfig).toHaveBeenCalled())
    expect(mocks.saveApcConfig.mock.calls[0][0].activeDatabase).toBe('db2')
  })

  it('测试连接带上当前编辑的槽位 id', async () => {
    mocks.testApcDatabase.mockResolvedValue({
      ok: true, elapsedMs: 10,
      target: { host: '10.0.0.21', port: 30015, user: 'RO_APC', databaseName: '', schema: 'MES', useTLS: false, validateCert: true },
    })
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByRole('button', { name: /数据库系统 2/ }))
    fireEvent.change(screen.getByPlaceholderText(/如 10\.0\.0\.21/), { target: { value: '10.8.8.8' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(mocks.testApcDatabase).toHaveBeenCalled())
    expect(mocks.testApcDatabase.mock.calls[0][0]).toMatchObject({ host: '10.8.8.8' })
    expect(mocks.testApcDatabase.mock.calls[0][1]).toBe('db2')
  })
})

describe('ApcConfigPanel · SQL 查询语句窗口', () => {
  it('展示模板与占位符，试运行后列出返回列并支持点选映射', async () => {
    mocks.previewApcQuery.mockResolvedValue({
      ok: true,
      mode: 'long',
      sql: 'SELECT "PARAM_CODE" FROM "MES_PROCESS_HIST" LIMIT 20',
      vars: { minutes: '120', limit: '20' },
      columns: ['PARAM_CODE', 'TS', 'VALUE'],
      rows: [{ PARAM_CODE: 'COATING_DENSITY', TS: '2026-09-11T02:00:00.000Z', VALUE: 12.61 }],
      rowCount: 1,
      truncated: false,
      elapsedMs: 18,
      warnings: [],
    })
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByRole('button', { name: 'SQL 查询语句' }))

    expect(screen.getByDisplayValue(new RegExp('MES_PROCESS_HIST'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '{{codeFilter}}' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /试运行/ }))
    await waitFor(() => expect(mocks.previewApcQuery).toHaveBeenCalled())

    // 试运行把当前草稿一起发过去（未保存也能验证）
    const payload = mocks.previewApcQuery.mock.calls[0][0]
    expect(payload.queries.history).toContain('{{minutes}}')
    expect(payload.params.length).toBe(2)

    expect(await screen.findByText(/1 行/)).toBeInTheDocument()
    expect(screen.getAllByText('PARAM_CODE').length).toBeGreaterThan(0)
    expect(screen.getByText('COATING_DENSITY')).toBeInTheDocument()
    // 列名旁提供「编码列 / 数值列 / 时间列」点选映射
    expect(screen.getAllByRole('button', { name: '编码列' }).length).toBe(3)
    expect(screen.getAllByRole('button', { name: '时间列' }).length).toBe(3)
  })

  it('宽表模式提示未填数据列名的参数', async () => {
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByRole('button', { name: 'SQL 查询语句' }))
    fireEvent.click(screen.getByRole('radio', { name: /宽表/ }))

    expect(await screen.findByText(/COATING_DENSITY/)).toBeInTheDocument()
    expect(screen.getByText(/保存会被拒绝/)).toBeInTheDocument()
  })
})

describe('ApcConfigPanel · 参数配置窗口', () => {
  it('列出全部参数，选中后可编辑并保存 params 段', async () => {
    mocks.saveApcConfig.mockResolvedValue({ ok: true, saved: ['params'], config: makeConfig() })
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }))

    expect(screen.getByText(/个/)).toBeInTheDocument()
    // 切到第二个参数
    fireEvent.click(screen.getByRole('button', { name: /辊压辊缝/ }))
    const nameInput = screen.getByDisplayValue('辊压辊缝')
    fireEvent.change(nameInput, { target: { value: '辊压辊缝（改）' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.saveApcConfig).toHaveBeenCalledTimes(1))
    const patch = mocks.saveApcConfig.mock.calls[0][0]
    expect(patch.params.length).toBe(2)
    expect(patch.params[1].name).toBe('辊压辊缝（改）')
  })

  it('可直接编辑目录元信息（装置名 / 默认死区）', async () => {
    renderPanel()
    await screen.findByDisplayValue('10.0.0.21')
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }))
    const stationInput = screen.getByDisplayValue(/极片与电芯产线/)
    fireEvent.change(stationInput, { target: { value: '一号产线' } })
    expect(screen.getByDisplayValue('一号产线')).toBeInTheDocument()
  })

  it('目录被 APC_CATALOG_FILE 锁定时给出明确提示并禁用重置', async () => {
    const cfg = makeConfig()
    cfg.catalogFileLocked = true
    mocks.fetchApcConfig.mockResolvedValue(cfg)
    renderPanel()
    expect(await screen.findByText(/APC_CATALOG_FILE/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }))
    expect(screen.getByRole('button', { name: '恢复默认目录' })).toBeDisabled()
  })
})
