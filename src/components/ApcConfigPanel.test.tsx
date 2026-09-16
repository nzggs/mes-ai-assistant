import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ApcConfigResponse, ApcMonitorItem } from '../types'

// 接口层打桩：只验证项目编辑器（项目设置 / 监测项）的渲染与交互，不触碰真实后端。
// 数据层次：监测项目 → 监测项（items[]）→ 输出结果 CV（1 个）+ 参与参数 MV（N 个）。
// 数据库连接与查询限制已移到侧边栏「数据库管理」页，本项目编辑器只选择用哪个数据库系统。
const mocks = vi.hoisted(() => ({
  fetchApcConfig: vi.fn(),
  fetchApcProject: vi.fn(),
  createApcProject: vi.fn(),
  updateApcProject: vi.fn(),
  deleteApcProject: vi.fn(),
  fetchApcItems: vi.fn(),
  createApcItem: vi.fn(),
  updateApcItem: vi.fn(),
  deleteApcItem: vi.fn(),
  previewApcItemQuery: vi.fn(),
  calibrateApcItem: vi.fn(),
  saveApcConfig: vi.fn(),
  setAdminToken: vi.fn(),
}))

vi.mock('../services/apcApi', () => ({
  fetchApcConfig: mocks.fetchApcConfig,
  fetchApcProject: mocks.fetchApcProject,
  createApcProject: mocks.createApcProject,
  updateApcProject: mocks.updateApcProject,
  deleteApcProject: mocks.deleteApcProject,
  fetchApcItems: mocks.fetchApcItems,
  createApcItem: mocks.createApcItem,
  updateApcItem: mocks.updateApcItem,
  deleteApcItem: mocks.deleteApcItem,
  previewApcItemQuery: mocks.previewApcItemQuery,
  calibrateApcItem: mocks.calibrateApcItem,
  saveApcConfig: mocks.saveApcConfig,
  setAdminToken: mocks.setAdminToken,
}))

import { ApcConfigPanel } from './ApcConfigPanel'

const ITEM_SQL =
  'SELECT {{columns}} FROM "MES_PROCESS_HIST" ' +
  'WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}) ORDER BY "TS" LIMIT {{limit}}'

/** 监测项：1 个输出结果（CV）+ 2 个参与参数（MV，其中涂布速度 k 未标定） */
function makeItem(over: Partial<ApcMonitorItem> = {}): ApcMonitorItem {
  return {
    id: 'it1',
    name: '涂布面密度回路',
    description: '张力与速度共同影响面密度',
    query: { mode: 'wide', history: ITEM_SQL, columns: { ts: 'TS' } },
    output: {
      code: 'COATING_DENSITY',
      name: '正极涂布面密度',
      unit: 'mg/cm²',
      decimals: 2,
      column: 'DENSITY',
      objective: 'quality',
      spec: { lsl: 12.3, usl: 12.9, target: 12.6 },
    },
    params: [
      {
        code: 'TENSION',
        name: '收放卷张力',
        process: '卷绕',
        unit: 'N',
        decimals: 2,
        column: 'TENSION_SET',
        min: 2,
        max: 5,
        setpoint: 3.2,
        maxStepPct: 3,
        weight: 1,
        enabled: true,
        k: { mode: 'manual', value: 0.08 },
      },
      {
        code: 'SPEED',
        name: '涂布速度',
        process: '涂布',
        unit: 'm/min',
        decimals: 1,
        column: 'SPEED_SET',
        min: 20,
        max: 40,
        setpoint: null,
        maxStepPct: 2,
        weight: 2,
        enabled: true,
        k: { mode: 'manual', value: 0 },
      },
    ],
    tuning: { deadbandPct: 10, maxRounds: 2, residualTolerancePct: 5 },
    ...over,
  }
}

function makeProject() {
  return {
    id: 'p1',
    name: '注液量监测',
    description: '监测注液工序的过程数据并给出设定值建议',
    dbSlot: 'db1',
    itemCount: 1,
    hasQueries: true,
    createdAt: null,
    updatedAt: null,
    // 老结构字段已迁移，保留为 null / 空数组
    queries: null,
    params: [],
    items: [makeItem()],
  }
}

function makeConfig(): ApcConfigResponse {
  return {
    configFile: '/data/apc.config.json',
    configFileExists: true,
    configFileError: '',
    updatedAt: '2026-09-15T02:00:00.000Z',
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
    limits: { chatRows: 100 },
    projects: [],
    queries: null,
    params: [],
    meta: {
      station: '消费类聚合物锂离子电池 · 极片与电芯产线',
      sampleIntervalSec: 120,
      defaultWindowMinutes: 120,
      deadbandPctDefault: 10,
    },
    catalogError: '',
  }
}

const PREVIEW_OK = {
  ok: true,
  mode: 'wide' as const,
  sql: 'SELECT "TS", "DENSITY", "TENSION_SET", "SPEED_SET" FROM "MES_PROCESS_HIST" LIMIT 20',
  vars: { minutes: '120', limit: '20', columns: '"TS", "DENSITY", "TENSION_SET", "SPEED_SET"' },
  columns: ['TS', 'DENSITY', 'TENSION_SET'],
  columnCheck: [
    { role: 'output' as const, code: 'COATING_DENSITY', column: 'DENSITY', present: true },
    { role: 'param' as const, code: 'TENSION', column: 'TENSION_SET', present: true },
    // 涂布速度的列没被 SELECT 出来 —— 正是试运行要提前暴露的问题
    { role: 'param' as const, code: 'SPEED', column: 'SPEED_SET', present: false },
  ],
  rows: [{ TS: '2026-09-15T02:00:00.000Z', DENSITY: 12.71, TENSION_SET: 3.2, SPEED_SET: 28 }],
  rowCount: 1,
  truncated: false,
  elapsedMs: 18,
  warnings: ['参与参数 SPEED 的列「SPEED_SET」未出现在查询结果中，该项将取不到数据。'],
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
  mocks.previewApcItemQuery.mockResolvedValue(PREVIEW_OK)
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
    // 先填描述让草稿变脏 → 名称缺失时报错且不调用接口
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

  it('编辑模式：改名后保存，只提交项目信息（不提交 items）', async () => {
    mocks.updateApcProject.mockResolvedValue({ ok: true, project: makeProject(), projects: [] })
    const { onSaved } = renderEditor('p1')
    const nameInput = await screen.findByDisplayValue('注液量监测')
    fireEvent.change(nameInput, { target: { value: '注液量监测（改）' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.updateApcProject).toHaveBeenCalledTimes(1))
    const [id, patch] = mocks.updateApcProject.mock.calls[0]
    expect(id).toBe('p1')
    expect(patch.name).toBe('注液量监测（改）')
    // 监测项没改动 → 不提交 items，也不该动服务端监测项接口
    expect(patch.items).toBeUndefined()
    expect(mocks.updateApcItem).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith('p1')
  })

  it('编辑模式：切换绑定的数据库系统到 db2 后随项目信息一起提交', async () => {
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

describe('ApcConfigPanel · 监测项', () => {
  it('左侧列出监测项，右侧回显取数 SQL、时间戳列与输出结果（CV）', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))

    // 左侧列表
    expect(await screen.findByText('涂布面密度回路')).toBeInTheDocument()
    expect(screen.getByText(/COATING_DENSITY ← 2 个参与参数/)).toBeInTheDocument()
    // 右侧详情：SQL 模板、时间戳列、输出结果编码与数据列名
    expect(screen.getByDisplayValue(new RegExp('MES_PROCESS_HIST'))).toBeInTheDocument()
    expect(screen.getByDisplayValue('TS')).toBeInTheDocument()
    expect(screen.getByDisplayValue('COATING_DENSITY')).toBeInTheDocument()
    expect(screen.getByDisplayValue('DENSITY')).toBeInTheDocument()
    // 窄表已被物理移除：界面上不再有长/窄表单选
    expect(screen.queryByRole('radio', { name: /窄表/ })).not.toBeInTheDocument()
    expect(screen.getAllByText(/{{columns}}/).length).toBeGreaterThan(0)
  })

  it('改输出结果的数据列名后保存，按监测项接口全量提交', async () => {
    mocks.updateApcItem.mockResolvedValue({ ok: true, item: makeItem(), items: [makeItem()] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))

    fireEvent.change(await screen.findByDisplayValue('DENSITY'), { target: { value: 'DENSITY_CALC' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.updateApcItem).toHaveBeenCalledTimes(1))
    const [pid, itemId, payload] = mocks.updateApcItem.mock.calls[0]
    expect(pid).toBe('p1')
    expect(itemId).toBe('it1')
    expect(payload.output.column).toBe('DENSITY_CALC')
    expect(payload.output.code).toBe('COATING_DENSITY')
    expect(payload.params.length).toBe(2)
    expect(payload.query.columns.ts).toBe('TS')
  })

  it('输出结果的规格支持列名表达式，原样提交（不强行转数字）', async () => {
    mocks.updateApcItem.mockResolvedValue({ ok: true, item: makeItem(), items: [makeItem()] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))

    fireEvent.change(await screen.findByDisplayValue('12.3'), { target: { value: 'LSL_COL' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.updateApcItem).toHaveBeenCalledTimes(1))
    expect(mocks.updateApcItem.mock.calls[0][2].output.spec.lsl).toBe('LSL_COL')
  })

  it('规格被清空时本地校验直接拦住并说明原因，不会把「空规格」提交上去', async () => {
    mocks.updateApcItem.mockResolvedValue({ ok: true, item: makeItem(), items: [makeItem()] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))

    fireEvent.change(await screen.findByDisplayValue('12.9'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    expect(await screen.findByText(/缺少规格上限 usl/)).toBeInTheDocument()
    expect(mocks.updateApcItem).not.toHaveBeenCalled()
  })

  it('新增监测项后缺必填项时报错且不提交（不会静默创建一个空监测项）', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))

    fireEvent.click(screen.getByTitle('新增监测项'))
    expect(await screen.findByDisplayValue('新监测项 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    // 校验按「标识与取值 → 取数」的顺序给出第一条缺陷，逐项修完才能保存
    expect(await screen.findByText(/输出结果必须配置数据列名/)).toBeInTheDocument()
    expect(mocks.createApcItem).not.toHaveBeenCalled()
  })

  it('删除监测项需确认，且到保存时才真正调用删除接口', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.deleteApcItem.mockResolvedValue({ ok: true, items: [] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))

    await screen.findByText('涂布面密度回路')
    fireEvent.click(screen.getByTitle('删除当前监测项'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(screen.getByText(/待删除 1 项/)).toBeInTheDocument()
    // 还没点保存 → 服务端不该动
    expect(mocks.deleteApcItem).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))
    await waitFor(() => expect(mocks.deleteApcItem).toHaveBeenCalledWith('p1', 'it1'))
    confirmSpy.mockRestore()
  })
})

describe('ApcConfigPanel · 参与参数（MV）', () => {
  it('列出参与参数，改名称后随监测项一起提交', async () => {
    mocks.updateApcItem.mockResolvedValue({ ok: true, item: makeItem(), items: [makeItem()] })
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))
    fireEvent.click(screen.getByRole('button', { name: /^参与参数/ }))

    expect(await screen.findByText('收放卷张力')).toBeInTheDocument()
    expect(screen.getByText(/列 TENSION_SET/)).toBeInTheDocument()
    // k 未标定的参数在列表里被标出来，免得运行期才发现它不参与求解
    expect(screen.getByText('k=0')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /涂布速度/ }))
    fireEvent.change(screen.getByDisplayValue('涂布速度'), { target: { value: '涂布速度（改）' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    await waitFor(() => expect(mocks.updateApcItem).toHaveBeenCalledTimes(1))
    const payload = mocks.updateApcItem.mock.calls[0][2]
    expect(payload.params[1].name).toBe('涂布速度（改）')
    expect(payload.params[1].code).toBe('SPEED')
  })

  it('新增参与参数后缺数据列名时报错并指明是哪个参数', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))
    fireEvent.click(screen.getByRole('button', { name: /^参与参数/ }))

    fireEvent.click(screen.getByRole('button', { name: /新增参数/ }))
    fireEvent.click(screen.getByRole('button', { name: /^保存/ }))

    expect(await screen.findByText(/参与参数 MV_3 必须配置数据列名/)).toBeInTheDocument()
    expect(mocks.updateApcItem).not.toHaveBeenCalled()
  })
})

describe('ApcConfigPanel · 试运行与逐列核对', () => {
  it('试运行把当前草稿（未保存）整项发给服务端，并逐列标出哪些列真的取回来了', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))
    fireEvent.click(await screen.findByRole('button', { name: /试运行/ }))

    await waitFor(() => expect(mocks.previewApcItemQuery).toHaveBeenCalledTimes(1))
    const payload = mocks.previewApcItemQuery.mock.calls[0][0]
    expect(payload.projectId).toBe('p1')
    expect(payload.item.query.history).toContain('{{minutes}}')
    expect(payload.item.output.column).toBe('DENSITY')
    expect(payload.item.params.length).toBe(2)

    // 三列核对结果都要可见：✓ 已取回、✗ 未取回
    expect(await screen.findByText(/✓ 输出 COATING_DENSITY · DENSITY/)).toBeInTheDocument()
    expect(screen.getByText(/✓ 参数 TENSION · TENSION_SET/)).toBeInTheDocument()
    expect(screen.getByText(/✗ 参数 SPEED · SPEED_SET/)).toBeInTheDocument()
    // 未取回的列要在告警里说清楚后果
    expect(screen.getByText(/未出现在查询结果中，该项将取不到数据/)).toBeInTheDocument()
    // 返回的数据行也要能看到，便于确认列里的值是不是想要的量
    expect(screen.getByText('12.71')).toBeInTheDocument()
  })

  it('缺少必填项时不做无谓的取数请求，直接在界面说明原因', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))
    // 时间戳列清空 → 本地校验应先拦住
    fireEvent.change(await screen.findByDisplayValue('TS'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /试运行/ }))

    expect(await screen.findByText(/必须配置时间戳列/)).toBeInTheDocument()
    expect(mocks.previewApcItemQuery).not.toHaveBeenCalled()
  })
})

describe('ApcConfigPanel · 调优策略与自检', () => {
  it('调优策略页展示自检提示（k 未标定）与求解范围预览', async () => {
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))
    fireEvent.click(screen.getByRole('button', { name: /^调优策略/ }))

    // 自检：k=0 的参数会被排除出求解集，必须提前讲清楚
    expect(await screen.findByText(/影响系数 k 为 0（尚未标定）/)).toBeInTheDocument()
    expect(screen.getByText('配置自检（不阻断保存，但会导致算不出建议）')).toBeInTheDocument()
    // 求解范围预览：1 个参与求解、1 个被排除
    expect(screen.getByText('被排除')).toBeInTheDocument()
    expect(screen.getAllByText('参与求解').length).toBeGreaterThan(0)
    // 死区不可删，说明里要讲清它为什么存在
    expect(screen.getByText(/这是 RTO 与「自动追目标」的分界线/)).toBeInTheDocument()
  })

  it('目录被 APC_CATALOG_FILE 锁定时禁止编辑监测项并说明原因', async () => {
    const cfg = makeConfig()
    cfg.catalogFileLocked = true
    mocks.fetchApcConfig.mockResolvedValue(cfg)
    renderEditor('p1')
    await screen.findByDisplayValue('注液量监测')
    fireEvent.click(screen.getByRole('button', { name: /^监测项/ }))

    expect(await screen.findByText(/监测项配置不会被读取/)).toBeInTheDocument()
    expect(screen.getByTitle('新增监测项')).toBeDisabled()
  })
})
