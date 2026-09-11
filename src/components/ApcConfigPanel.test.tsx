import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ApcConfigResponse } from '../types'

// 接口层打桩：只验证项目编辑器（项目设置 / SQL 模板 / 参数配置）的渲染与交互，不触碰真实后端。
// 数据库连接与查询限制已移到侧边栏「数据库管理」页，本项目编辑器只选择用哪个数据库系统。
const mocks = vi.hoisted(() => ({
  fetchApcConfig: vi.fn(),
  fetchApcProject: vi.fn(),
  createApcProject: vi.fn(),
  updateApcProject: vi.fn(),
  deleteApcProject: vi.fn(),
  saveApcConfig: vi.fn(),
  resetApcConfig: vi.fn(),
  previewApcQuery: vi.fn(),
  setAdminToken: vi.fn(),
  hasAdminToken: vi.fn(() => true),
}))

vi.mock('../services/apcApi', () => ({
  fetchApcConfig: mocks.fetchApcConfig,
  fetchApcProject: mocks.fetchApcProject,
  createApcProject: mocks.createApcProject,
  updateApcProject: mocks.updateApcProject,
  deleteApcProject: mocks.deleteApcProject,
  saveApcConfig: mocks.saveApcConfig,
  resetApcConfig: mocks.resetApcConfig,
  previewApcQuery: mocks.previewApcQuery,
  setAdminToken: mocks.setAdminToken,
  hasAdminToken: mocks.hasAdminToken,
}))

import { ApcConfigPanel } from './ApcConfigPanel'

const QUERY_SQL =
  'SELECT "PARAM_CODE", "TS", "VALUE" FROM "MES_PROCESS_HIST" ' +
  'WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}){{codeFilter}} LIMIT {{limit}}'

const PARAMS = [
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
    dbSlot: 'db1',
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
    dbSlot: 'db1',
  },
]

const QUERIES = { mode: 'long', history: QUERY_SQL, columns: { code: 'PARAM_CODE', ts: 'TS', value: 'VALUE' } }

function makeConfig(): ApcConfigResponse {
  return {
    configFile: '/data/apc.config.json',
    configFileExists: true,
    configFileError: '',
    updatedAt: '2026-09-11T02:00:00.000Z',
    catalogFileLocked: false,
    seedFile: '/app/server/apc.catalog.json',
    database: {
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
    queries: QUERIES,
    params: PARAMS,
    meta: { station: '消费类聚合物锂离子电池 · 极片与电芯产线', sampleIntervalSec: 120, defaultWindowMinutes: 120, deadbandPctDefault: 10 },
    catalogError: '',
  } as ApcConfigResponse
}

function makeProject() {
  return {
    id: 'p1',
    name: '注液量监测',
    description: '监测注液工序的过程数据并给出设定值建议',
    dbSlot: 'db1',
    paramCount: 2,
    hasQueries: true,
    queries: QUERIES,
    params: PARAMS,
  }
}

function renderEditor(projectId: string | null = 'p1') {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(<ApcConfigPanel projectId={projectId} onClose={onClose} onSaved={onSaved} />)
  return { onClose, onSaved }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchApcConfig.mockResolvedValue(makeConfig())
  mocks.fetchApcProject.mockResolvedValue({ project: makeProject() })
  mocks.hasAdminToken.mockReturnValue(true)
})

describe('ApcConfigPanel · 项目设置', () => {
  it('编辑模式：载入项目并回显名称、描述与绑定的数据库系统', async () => {
    renderEditor('p1')
    expect(await screen.findByDisplayValue('注液量监测')).toBeInTheDocument()
    expect(screen.getByDisplayValue(/监测注液工序/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('数据库系统 1（db1）')).toBeInTheDocument()
    // 数据库连接是公用配置，面板里应提示去「数据库管理」页维护
    expect(screen.getAllByText(/数据库管理/).length).toBeGreaterThan(0)
    // 没有未保存改动时保存按钮禁用
    expect(screen.getByRole('button', { name: /^保存/ })).toBeDisabled()
  })

  it('新建模式：标题为「新建监测项目」，无需载入项目详情', async () => {
    renderEditor(null)
    expect(await screen.findByText('新建监测项目')).toBeInTheDocument()
    expect(mocks.fetchApcProject).not.toHaveBeenCalled()
  })

  it('新建模式：名称必填，首次保存调用 createApcProject 并回传新项目 id', async () => {
    mocks.createApcProject.mockResolvedValue({ ok: true, project: { ...makeProject(), id: 'p-new', name: '叠片对齐度' }, projects: [] })
    const { onSaved } = renderEditor(null)
    await screen.findByText('新建监测项目')
    // 先填描述让草稿变脏（填名称之前先试创建）→ 名称缺失报错且不调用接口
    fireEvent.change(screen.getByPlaceholderText(/监测注液工序/), { target: { value: '测试描述' } })
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
    expect(await screen.findByText(/项目名称不能为空/)).toBeInTheDocument()
    expect(mocks.createApcProject).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText(/注液量监测/), { target: { value: '叠片对齐度' } })
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
    await waitFor(() => expect(mocks.createApcProject).toHaveBeenCalledTimes(1))
    const draft = mocks.createApcProject.mock.calls[0][0]
    expect(draft.name).toBe('叠片对齐度')
    expect(draft.description).toBe('测试描述')
    expect(draft.dbSlot).toBe('db1')
    expect(onSaved).toHaveBeenCalledWith('p-new')
  })

  it('编辑模式：改名后保存，只把改动的段（settings）提交 updateApcProject', async () => {
    mocks.updateApcProject.mockResolvedValue({ ok: true, project: makeProject(), projects: [] })
    const { onSaved } = renderEditor('p1')
    const nameInput = await screen.findByDisplayValue('注液量监测')
    fireEvent.change(nameInput, { target: { value: '注液量监测（改）' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.updateApcProject).toHaveBeenCalledTimes(1))
    const [id, patch] = mocks.updateApcProject.mock.calls[0]
    expect(id).toBe('p1')
    expect(patch.name).toBe('注液量监测（改）')
    expect(patch.queries).toBeUndefined() // SQL 模板没改动 → 不提交
    expect(onSaved).toHaveBeenCalledWith('p1')
  })

  it('编辑模式：切换绑定的数据库系统到 db2 后随 settings 段提交', async () => {
    mocks.updateApcProject.mockResolvedValue({ ok: true, project: makeProject(), projects: [] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.change(screen.getByDisplayValue('数据库系统 1（db1）'), { target: { value: 'db2' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))
    await waitFor(() => expect(mocks.updateApcProject).toHaveBeenCalled())
    expect(mocks.updateApcProject.mock.calls[0][1].dbSlot).toBe('db2')
  })

  it('删除项目需经过确认，确认后调用 deleteApcProject', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.deleteApcProject.mockResolvedValue({ ok: true, projects: [] })
    const { onSaved } = renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: '删除项目' }))
    await waitFor(() => expect(mocks.deleteApcProject).toHaveBeenCalledWith('p1'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('缺少管理员令牌时给出令牌输入入口而不是直接报错', async () => {
    const err = Object.assign(new Error('需要管理员令牌（ADMIN_TOKEN）'), { status: 403 })
    mocks.fetchApcConfig.mockRejectedValue(err)
    renderEditor('p1')
    expect(await screen.findByText(/需要管理员令牌/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('粘贴 ADMIN_TOKEN')).toBeInTheDocument()
  })
})

describe('ApcConfigPanel · SQL 模板', () => {
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
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: 'SQL 模板' }))

    expect(screen.getByDisplayValue(new RegExp('MES_PROCESS_HIST'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '{{codeFilter}}' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /试运行/ }))
    await waitFor(() => expect(mocks.previewApcQuery).toHaveBeenCalled())

    // 试运行把当前草稿一起发过去（未保存也能验证），并带上项目绑定的数据库槽位
    const payload = mocks.previewApcQuery.mock.calls[0][0]
    expect(payload.queries.history).toContain('{{minutes}}')
    expect(payload.params.length).toBe(2)
    expect(payload.slot).toBe('db1')

    expect(await screen.findByText(/1 行/)).toBeInTheDocument()
    expect(screen.getAllByText('PARAM_CODE').length).toBeGreaterThan(0)
    expect(screen.getByText('COATING_DENSITY')).toBeInTheDocument()
    // 列名旁提供「编码列 / 数值列 / 时间列」点选映射
    expect(screen.getAllByRole('button', { name: '编码列' }).length).toBe(3)
    expect(screen.getAllByRole('button', { name: '时间列' }).length).toBe(3)
  })

  it('宽表模式提示未填数据列名的参数', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: 'SQL 模板' }))
    fireEvent.click(screen.getByRole('radio', { name: /宽表/ }))

    expect(await screen.findByText(/COATING_DENSITY/)).toBeInTheDocument()
    expect(screen.getByText(/保存会被拒绝/)).toBeInTheDocument()
  })

  it('目录被 APC_CATALOG_FILE 锁定时提示保存不生效并禁用重置', async () => {
    const cfg = makeConfig()
    cfg.catalogFileLocked = true
    mocks.fetchApcConfig.mockResolvedValue(cfg)
    renderEditor('p1')
    await screen.findByText(/APC_CATALOG_FILE/)
    fireEvent.click(screen.getByRole('button', { name: 'SQL 模板' }))
    expect(screen.getByRole('button', { name: '恢复默认模板' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }))
    expect(screen.getByRole('button', { name: '清空参数' })).toBeDisabled()
  })
})

describe('ApcConfigPanel · 参数配置', () => {
  it('列出全部参数，选中后可编辑并随 params 段保存', async () => {
    mocks.updateApcProject.mockResolvedValue({ ok: true, project: makeProject(), projects: [] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }))

    expect(screen.getByText(/个参数|2 个/)).toBeInTheDocument()
    // 切到第二个参数
    fireEvent.click(screen.getByRole('button', { name: /辊压辊缝/ }))
    const nameInput = screen.getByDisplayValue('辊压辊缝')
    fireEvent.change(nameInput, { target: { value: '辊压辊缝（改）' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.updateApcProject).toHaveBeenCalledTimes(1))
    const [, patch] = mocks.updateApcProject.mock.calls[0]
    expect(patch.params.length).toBe(2)
    expect(patch.params[1].name).toBe('辊压辊缝（改）')
    expect(patch.name).toBeUndefined() // 项目信息没改动 → 不提交
  })

  it('参数统一使用项目绑定的数据库（表单内只读展示，不再逐参数选库）', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }))
    expect(screen.getByDisplayValue('数据库系统 1')).toBeInTheDocument()
  })

  it('JSON 批量编辑：应用后写入草稿，再保存才提交 params', async () => {
    mocks.updateApcProject.mockResolvedValue({ ok: true, project: makeProject(), projects: [] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON 批量编辑' }))

    const next = [PARAMS[0], { ...PARAMS[1], name: '辊压辊缝（JSON）' }]
    fireEvent.change(screen.getByRole('textbox'), { target: { value: JSON.stringify(next) } })
    fireEvent.click(screen.getByRole('button', { name: '应用 JSON' }))
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.updateApcProject).toHaveBeenCalledTimes(1))
    const [, patch] = mocks.updateApcProject.mock.calls[0]
    expect(patch.params[1].name).toBe('辊压辊缝（JSON）')
  })
})
