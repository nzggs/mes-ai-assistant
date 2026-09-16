import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type {
  ApcCvResult,
  ApcHistoryResponse,
  ApcItemRecommendation,
  ApcMove,
  ApcOptimization,
  ApcOverview,
  ApcStatusResponse,
} from '../types'

// 接口层打桩：只验证页面渲染与交互，不触碰真实后端
const mocks = vi.hoisted(() => ({
  fetchApcStatus: vi.fn(),
  fetchApcOverview: vi.fn(),
  fetchApcOptimization: vi.fn(),
  fetchApcHistory: vi.fn(),
  fetchMesGuide: vi.fn(),
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
  fetchApcStatus: mocks.fetchApcStatus,
  fetchApcOverview: mocks.fetchApcOverview,
  fetchApcOptimization: mocks.fetchApcOptimization,
  fetchApcHistory: mocks.fetchApcHistory,
  // 槽位显示名由 /api/mes/guide 提供（页面用它把 db1/db2 换成系统显示名）
  fetchMesGuide: mocks.fetchMesGuide,
  // 配置面板用到的接口也一并打桩，避免打开配置入口时打到真实网络
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

import { ApcRto } from './ApcRto'

const STATION = '消费类聚合物锂离子电池 · 极片与电芯产线'
const SOURCE = {
  label: 'SAP HANA（只读 · 按项目绑定数据库系统）',
  note: '实时读取 HANA 中记录的过程数据列值；每个项目绑定数据库系统 1 或 2，仅执行 SELECT。',
  ready: true,
  reason: '',
}
const UNCONFIGURED_SOURCE = {
  label: '未配置数据源',
  note: '当前项目尚未添加监测项。请点击「新建监测项」，为它配置取数 SQL、输出结果与参与参数。',
  ready: false,
  reason: 'no-item',
}

const SERIES = Array.from({ length: 12 }, (_, i) => ({ t: 1_700_000_000_000 + i * 60_000, v: 12.6 + i * 0.01 }))

const ITEM_ID = 'it_coating'
const ITEM_NAME = '涂布面密度回路'

/** 参与参数求解行：k 已标定、实际承担 80% 偏差 */
const MOVE_TENSION: ApcMove = {
  code: 'TENSION',
  name: '收放卷张力',
  unit: 'N',
  decimals: 2,
  current: 3.2,
  suggested: 3.35,
  delta: 0.15,
  deltaPct: 4.69,
  min: 2,
  max: 5,
  span: 3,
  weight: 1,
  k: 0.08,
  kMode: 'manual',
  leverage: 0.0576,
  share: 0.8,
  clampedBy: null,
  participating: true,
  excludedReason: '',
}

/** 第二个参数：k 来自标定，且顶到单次限幅 */
const MOVE_SPEED: ApcMove = {
  code: 'SPEED',
  name: '涂布速度',
  unit: 'm/min',
  decimals: 1,
  current: 28,
  suggested: 28.4,
  delta: 0.4,
  deltaPct: 1.43,
  min: 20,
  max: 40,
  span: 20,
  weight: 2,
  k: 0.005,
  kMode: 'calibrated',
  leverage: 0.005,
  share: 0.2,
  clampedBy: 'step',
  participating: true,
  excludedReason: '',
}

/** 第三个参数：k 未标定 → 不参与求解 */
const MOVE_VISC: ApcMove = {
  code: 'SLURRY_VISC',
  name: '浆料粘度',
  unit: 'mPa·s',
  decimals: 0,
  current: 4200,
  suggested: null,
  delta: 0,
  deltaPct: null,
  min: 3000,
  max: 6000,
  span: 3000,
  weight: 1,
  k: 0,
  kMode: 'manual',
  leverage: 0,
  share: 0,
  clampedBy: null,
  participating: false,
  excludedReason: '影响系数 k 未标定（为 0）',
}

const RECOMMENDATION: ApcItemRecommendation = {
  cv: { current: 12.72, target: 12.6, delta: -0.12 },
  moves: [MOVE_TENSION, MOVE_SPEED],
  predictedCV: 12.6,
  residual: 0.01,
  residualPct: 8.3,
  confidence: 88,
  urgency: 'medium',
  hold: false,
  rounds: 1,
  clampedBy: 'step',
  reason: '近 60 个采样点，输出结果「正极涂布面密度」均值 12.72mg/cm²，相对 RTO 理想点 12.60mg/cm² 偏高 0.12mg/cm²；按影响系数把偏差分摊给 2 个参数。',
  risk: '涂布速度 受单次调整幅度上限约束，未能足额调整。',
}

const OUTPUT: ApcCvResult = {
  code: 'COATING_DENSITY',
  name: '正极涂布面密度',
  unit: 'mg/cm²',
  decimals: 2,
  objective: 'quality',
  objectiveLabel: '质量',
  latest: 12.72,
  mean: 12.72,
  std: 0.05,
  min_: 12.6,
  max_: 12.8,
  sampleCount: 60,
  slope: 0.0001,
  trend: 'stable',
  target: 12.6,
  lsl: 12.3,
  usl: 12.9,
  cpk: 1.2,
  status: 'warning',
  specResolved: { ok: true, errors: [], expressions: {}, columns: [] },
  pointDeviation: { n: 12, outOfSpec: 0, outLow: 0, outHigh: 0, worst: null },
  series: SERIES,
  tuning: { deadbandPct: 10, maxRounds: 2, residualTolerancePct: 5 },
  moves: [MOVE_TENSION, MOVE_SPEED, MOVE_VISC],
  recommendation: RECOMMENDATION,
}

/** 死区内 → 建议保持（moves 里没有任何修正量） */
const HOLD_OUTPUT: ApcCvResult = {
  ...OUTPUT,
  status: 'normal',
  cpk: 2.4,
  moves: [MOVE_VISC],
  recommendation: {
    cv: { current: 12.62, target: 12.6, delta: -0.02 },
    moves: [],
    predictedCV: 12.62,
    residual: 0.02,
    residualPct: 100,
    confidence: 60,
    urgency: 'none',
    hold: true,
    rounds: 0,
    clampedBy: null,
    reason: '偏差 0.02mg/cm² 处于工艺死区内（±0.06mg/cm²，为规格带宽的 10%）且过程能力正常，调整收益低于扰动成本，建议保持。',
    risk: '',
  },
}

const OVERVIEW: ApcOverview = {
  project: 'p1',
  projectName: '涂布工序监测',
  item: { id: ITEM_ID, name: ITEM_NAME, description: '' },
  items: [{ id: ITEM_ID, name: ITEM_NAME }],
  station: STATION,
  mode: 'hana',
  ready: true,
  generatedAt: '2026-09-15T02:00:00.000Z',
  elapsedMs: 6,
  windowMinutes: 120,
  sampleIntervalSec: 120,
  rowCount: 600,
  truncated: false,
  source: SOURCE,
  warnings: [],
  output: OUTPUT,
}

const OPTIMIZATION: ApcOptimization = {
  project: 'p1',
  projectName: '涂布工序监测',
  item: { id: ITEM_ID, name: ITEM_NAME, description: '' },
  items: [{ id: ITEM_ID, name: ITEM_NAME }],
  station: STATION,
  mode: 'hana',
  ready: true,
  generatedAt: '2026-09-15T02:00:00.000Z',
  windowMinutes: 120,
  source: SOURCE,
  warnings: [],
  output: OUTPUT,
  recommendation: RECOMMENDATION,
  moves: OUTPUT.moves,
}

const STATUS: ApcStatusResponse = {
  enabled: true,
  mode: 'hana',
  ready: true,
  station: STATION,
  paramCount: 0,
  queryMode: 'wide',
  catalogFile: 'server/apc.catalog.json',
  catalogOrigin: 'saved',
  catalogFileLocked: false,
  catalogError: '',
  configFile: 'server/data/apc.config.json',
  configFileExists: false,
  configFileError: '',
  projects: [],
  hana: {
    configured: false,
    slots: [
      {
        id: 'db1',
        configured: false,
        connected: false,
        connecting: false,
        host: '',
        port: 30015,
        database: '',
        schema: '',
        useTLS: false,
        maxRows: 2000,
        statementTimeoutMs: 15000,
        lastError: '',
        lastConnectAt: null,
        lastQueryAt: null,
        lastQueryMs: null,
        queryCount: 0,
        abortedCount: 0,
      },
      {
        id: 'db2',
        configured: false,
        connected: false,
        connecting: false,
        host: '',
        port: 30015,
        database: '',
        schema: '',
        useTLS: false,
        maxRows: 2000,
        statementTimeoutMs: 15000,
        lastError: '',
        lastConnectAt: null,
        lastQueryAt: null,
        lastQueryMs: null,
        queryCount: 0,
        abortedCount: 0,
      },
    ],
  },
}

const HISTORY: ApcHistoryResponse = {
  ready: true,
  mode: 'hana',
  item: { id: ITEM_ID, name: ITEM_NAME },
  windowMinutes: 120,
  source: SOURCE,
  isOutput: true,
  param: {
    code: 'COATING_DENSITY',
    name: '正极涂布面密度',
    unit: 'mg/cm²',
    decimals: 2,
    target: 12.6,
    lsl: 12.3,
    usl: 12.9,
    min: null,
    max: null,
  },
  specResolved: { ok: true, errors: [], expressions: {}, columns: [] },
  pointDeviation: { n: 12, outOfSpec: 0, outLow: 0, outHigh: 0, worst: null },
  stats: { n: 12, mean: 12.66, std: 0.05, min: 12.6, max: 12.71, cpk: 1.2, trend: 'stable', status: 'warning' },
  points: SERIES,
}

/** 项目摘要（服务端 /api/apc/status 里的 projects 元素） */
const PROJECT_P1 = {
  id: 'p1',
  name: '注液量监测',
  description: '监测注液工序的过程数据',
  dbSlot: 'db1',
  itemCount: 1,
  hasQueries: true,
  createdAt: null,
  updatedAt: null,
}

beforeEach(() => {
  // 选中项目/监测项的记忆存在 localStorage 里，用例之间必须隔离
  localStorage.clear()
  mocks.fetchApcStatus.mockReset().mockResolvedValue({ ...STATUS, projects: [PROJECT_P1] })
  mocks.fetchApcOverview.mockReset().mockResolvedValue(OVERVIEW)
  mocks.fetchApcOptimization.mockReset().mockResolvedValue(OPTIMIZATION)
  mocks.fetchApcHistory.mockReset().mockResolvedValue(HISTORY)
  mocks.fetchMesGuide.mockReset().mockResolvedValue({
    slots: [
      { id: 'db1', name: '数据库系统 1', configured: true },
      { id: 'db2', name: '数据库系统 2', configured: true },
    ],
    limits: { maxRows: 2000, chatRows: 100 },
  })
  mocks.fetchApcConfig.mockReset().mockResolvedValue({
    catalogFileLocked: false,
    database: { slots: [] },
    meta: null,
    updatedAt: null,
  })
  mocks.fetchApcProject.mockReset().mockResolvedValue({
    project: { ...PROJECT_P1, queries: null, params: [], items: [] },
  })
})

describe('ApcRto 页面', () => {
  it('渲染标题、只读声明与数据源状态', async () => {
    render(<ApcRto />)
    expect(await screen.findByText('APC 和 RTO')).toBeInTheDocument()
    expect(screen.getByText('先进过程控制 · 实时优化')).toBeInTheDocument()
    // 只读安全边界必须在界面上明确展示
    expect(screen.getByText('仅 SELECT · 禁增删改')).toBeInTheDocument()
    expect(screen.getByText(/SAP HANA（只读/)).toBeInTheDocument()
  })

  it('未配置数据源时展示空态引导与具体原因，不展示任何曲线、统计与优化建议', async () => {
    mocks.fetchApcOverview.mockResolvedValue({
      ...OVERVIEW,
      mode: 'unconfigured',
      ready: false,
      reason: 'no-item',
      station: '',
      rowCount: 0,
      item: null,
      items: [],
      output: null,
      source: UNCONFIGURED_SOURCE,
    })
    mocks.fetchApcOptimization.mockResolvedValue({
      ...OPTIMIZATION,
      mode: 'unconfigured',
      ready: false,
      reason: 'no-item',
      station: '',
      item: null,
      items: [],
      output: null,
      recommendation: null,
      moves: [],
      source: UNCONFIGURED_SOURCE,
    })
    render(<ApcRto />)
    expect((await screen.findAllByText('未配置数据源')).length).toBeGreaterThan(0)
    // 具体原因必须讲清楚（而不是笼统一句「未配置」）
    expect(screen.getAllByText('当前项目尚未添加监测项').length).toBeGreaterThan(0)
    // 空态下不得出现输出结果卡、汇总指标与参数建议表
    expect(screen.queryByText('正极涂布面密度')).not.toBeInTheDocument()
    expect(screen.queryByText('收放卷张力')).not.toBeInTheDocument()
    expect(screen.queryByText('平均置信度')).not.toBeInTheDocument()
    expect(screen.queryByText('参与参数现状')).not.toBeInTheDocument()
  })

  it('渲染汇总指标：输出结果 / 需调整参数 / 残余偏差 / Cpk / 置信度（多对 1 口径）', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    expect(screen.getByText('需调整参数')).toBeInTheDocument()
    expect(screen.getByText('预计残余偏差')).toBeInTheDocument()
    expect(screen.getByText('过程能力 Cpk')).toBeInTheDocument()
    expect(screen.getByText('平均置信度')).toBeInTheDocument()
    expect(screen.getByText('88%')).toBeInTheDocument()
    // 2 个参数有修正量 / 共 3 个参与参数
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    expect(screen.getByText(/600 行/)).toBeInTheDocument()
  })

  it('实时概览展示输出结果卡（含规格、Cpk、点级判定）与参与参数现状表', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')

    expect(screen.getAllByText('正极涂布面密度').length).toBeGreaterThan(0)
    expect(screen.getByText('12.72')).toBeInTheDocument()
    expect(screen.getByText('12.30 ~ 12.90')).toBeInTheDocument()
    expect(screen.getAllByText('预警').length).toBeGreaterThan(0)
    // 点级判定：全量 12 点全部落在规格内（不受降采样影响）
    expect(screen.getByText(/12 个采样点全部落在规格内/)).toBeInTheDocument()

    // 参与参数表：两条已标定 + 一条未标定（未参与）
    expect(screen.getByText('参与参数现状')).toBeInTheDocument()
    expect(screen.getByText('收放卷张力')).toBeInTheDocument()
    expect(screen.getByText('涂布速度')).toBeInTheDocument()
    expect(screen.getByText('浆料粘度')).toBeInTheDocument()
    expect(screen.getByText('未参与')).toBeInTheDocument()
    expect(screen.getByText(/有 1 个参与参数未参与求解/)).toBeInTheDocument()
  })

  it('监测项选择器按当前生效项回显', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    expect(await screen.findByDisplayValue(ITEM_NAME)).toBeInTheDocument()
  })

  it('优化建议页展示分摊结果、承担份额、约束与理由风险', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    fireEvent.click(screen.getByText('优化建议'))

    expect(await screen.findByText('参数调整明细')).toBeInTheDocument()
    // 分摊份额必须可见（谁承担多少偏差）
    expect(screen.getByText('承担偏差')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByText('20%')).toBeInTheDocument()
    // 约束以中文讲清楚，而不是丢一个 'step'
    expect(screen.getByText('单次限幅')).toBeInTheDocument()
    expect(screen.getByText('推荐理由：')).toBeInTheDocument()
    expect(screen.getByText(/相对 RTO 理想点/)).toBeInTheDocument()
    expect(screen.getByText('风险提示：')).toBeInTheDocument()
    expect(screen.getByText(/受单次调整幅度上限约束/)).toBeInTheDocument()
    expect(screen.getAllByText('88%').length).toBeGreaterThan(0)
    // 未参与求解的参数必须单独列出并讲原因
    expect(screen.getByText('未参与本次求解的参数')).toBeInTheDocument()
    expect(screen.getByText(/影响系数 k 未标定/)).toBeInTheDocument()
  })

  it('死区内时明确显示「建议保持」，且不给出任何调整量', async () => {
    mocks.fetchApcOverview.mockResolvedValue({ ...OVERVIEW, output: HOLD_OUTPUT })
    mocks.fetchApcOptimization.mockResolvedValue({ ...OPTIMIZATION, output: HOLD_OUTPUT, recommendation: HOLD_OUTPUT.recommendation, moves: HOLD_OUTPUT.moves })
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    fireEvent.click(screen.getByText('优化建议'))

    expect(await screen.findByText('建议保持')).toBeInTheDocument()
    expect(screen.getByText(/处于工艺死区内/)).toBeInTheDocument()
  })

  it('点击「曲线」打开详情抽屉，并按当前监测项拉取该条历史', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')

    fireEvent.click(screen.getByText('查看输出结果趋势 →'))
    expect(await screen.findByText('窗口均值')).toBeInTheDocument()
    expect(screen.getByText('规格下限 LSL')).toBeInTheDocument()
    expect(screen.getByText('规格上限 USL')).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.fetchApcHistory).toHaveBeenCalledWith(
        'COATING_DENSITY',
        expect.objectContaining({ minutes: 120, item: ITEM_ID })
      )
    })
    // 明确「建议不会自动下发」，避免被理解为已写入 DCS/PLC
    expect(screen.getByText(/不会自动下发到 DCS\/PLC/)).toBeInTheDocument()
  })

  it('参与参数曲线用「可调下限/上限」标注，而不是借用输出结果的规格线文案', async () => {
    mocks.fetchApcHistory.mockResolvedValue({
      ...HISTORY,
      isOutput: false,
      param: {
        code: 'TENSION',
        name: '收放卷张力',
        unit: 'N',
        decimals: 2,
        target: null,
        lsl: null,
        usl: null,
        min: 2,
        max: 5,
      },
      stats: { n: 12, mean: 3.2, std: 0.05, min: 3.1, max: 3.3, cpk: null, trend: 'stable', status: 'unknown' },
    })
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')

    fireEvent.click(screen.getAllByText('曲线')[0])
    expect(await screen.findByText('可调下限')).toBeInTheDocument()
    expect(screen.getByText('可调上限')).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.fetchApcHistory).toHaveBeenCalledWith(
        'TENSION',
        expect.objectContaining({ item: ITEM_ID })
      )
    })
  })

  it('读取失败时给出可见错误提示', async () => {
    mocks.fetchApcOverview.mockRejectedValue(new Error('HANA 连接失败：主机不可达'))
    render(<ApcRto />)
    expect(await screen.findByText('读取过程数据失败')).toBeInTheDocument()
    expect(screen.getByText(/HANA 连接失败/)).toBeInTheDocument()
  })
})

describe('ApcRto · 选中项目的记忆与校验', () => {
  it('本地记忆的项目有效时，「编辑项目」按该项目打开编辑器', async () => {
    localStorage.setItem('mes-ai-apc-project', 'p1')
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')

    const editBtn = screen.getByRole('button', { name: /编辑项目/ })
    await waitFor(() => expect(editBtn).toBeEnabled())
    fireEvent.click(editBtn)

    expect(await screen.findByDisplayValue('注液量监测')).toBeInTheDocument()
    expect(mocks.fetchApcProject).toHaveBeenCalledWith('p1')
  })

  it('本地记忆的项目已不存在时自动清理，并回落到第一个真实项目取数', async () => {
    // 典型场景：旧版本自动迁移出来的 p_default 已被删除，浏览器里还记着它
    localStorage.setItem('mes-ai-apc-project', 'p_default')
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')

    await waitFor(() => expect(localStorage.getItem('mes-ai-apc-project')).toBeNull())
    await waitFor(() => {
      const calls = mocks.fetchApcOverview.mock.calls
      expect(calls[calls.length - 1][0].project).toBe('p1')
    })
  })

  it('脏的监测项记忆会被服务端回落值纠正并同步回本地', async () => {
    localStorage.setItem('mes-ai-apc-project', 'p1')
    localStorage.setItem('mes-ai-apc-item', 'it_gone')
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')

    // 第一次取数照旧带上本地记忆的（可能已失效的）id —— 由服务端决定实际项
    await waitFor(() => expect(mocks.fetchApcOverview).toHaveBeenCalled())
    expect(mocks.fetchApcOverview.mock.calls[0][0].item).toBe('it_gone')
    // 服务端回落出真实监测项后，本地记忆被纠正
    await waitFor(() => expect(localStorage.getItem('mes-ai-apc-item')).toBe(ITEM_ID))
  })

  it('一个项目也没有时，「编辑项目」禁用且不会去读不存在的项目', async () => {
    localStorage.setItem('mes-ai-apc-project', 'p_default')
    mocks.fetchApcStatus.mockResolvedValue({ ...STATUS, projects: [] })
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')

    await waitFor(() => expect(localStorage.getItem('mes-ai-apc-project')).toBeNull())
    expect(screen.getByRole('button', { name: /编辑项目/ })).toBeDisabled()

    // 「新建项目」始终可用，且打开的是空表单（不读任何项目详情）
    fireEvent.click(screen.getByRole('button', { name: /新建项目/ }))
    expect(await screen.findByText('新建监测项目')).toBeInTheDocument()
    expect(mocks.fetchApcProject).not.toHaveBeenCalled()
  })

  it('数据库一律显示系统显示名（改名后跟着变），不写死「数据库系统 2」', async () => {
    // 系统里把 db2 改成了「甲二只读数据库」，项目绑在 db2 上
    mocks.fetchMesGuide.mockResolvedValue({
      slots: [
        { id: 'db1', name: '数据库系统 1', configured: true },
        { id: 'db2', name: '甲二只读数据库', configured: true },
      ],
      limits: { maxRows: 2000, chatRows: 100 },
    })
    mocks.fetchApcStatus.mockResolvedValue({
      ...STATUS,
      projects: [{ ...PROJECT_P1, id: 'p2', name: '二厂注液监测', dbSlot: 'db2' }],
    })
    localStorage.setItem('mes-ai-apc-project', 'p2')
    render(<ApcRto />)

    await screen.findByText('APC 和 RTO')
    // 「项目库」一栏显示该项目的数据库系统显示名
    expect(await screen.findByText('项目库')).toBeInTheDocument()
    expect((await screen.findAllByText('甲二只读数据库')).length).toBeGreaterThan(0)
    expect(screen.queryByText('数据库系统 2')).not.toBeInTheDocument()
  })
})
