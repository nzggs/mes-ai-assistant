import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type {
  ApcHistoryResponse,
  ApcOptimization,
  ApcOverview,
  ApcParamItem,
  ApcStatusResponse,
} from '../types'

// 接口层打桩：只验证页面渲染与交互，不触碰真实后端
const mocks = vi.hoisted(() => ({
  fetchApcStatus: vi.fn(),
  fetchApcOverview: vi.fn(),
  fetchApcOptimization: vi.fn(),
  fetchApcHistory: vi.fn(),
  fetchApcConfig: vi.fn(),
  saveApcConfig: vi.fn(),
  resetApcConfig: vi.fn(),
  testApcDatabase: vi.fn(),
  previewApcQuery: vi.fn(),
  setAdminToken: vi.fn(),
  hasAdminToken: vi.fn(() => true),
}))

vi.mock('../services/apcApi', () => ({
  fetchApcStatus: mocks.fetchApcStatus,
  fetchApcOverview: mocks.fetchApcOverview,
  fetchApcOptimization: mocks.fetchApcOptimization,
  fetchApcHistory: mocks.fetchApcHistory,
  // 配置面板用到的接口也一并打桩，避免打开配置入口时打到真实网络
  fetchApcConfig: mocks.fetchApcConfig,
  saveApcConfig: mocks.saveApcConfig,
  resetApcConfig: mocks.resetApcConfig,
  testApcDatabase: mocks.testApcDatabase,
  previewApcQuery: mocks.previewApcQuery,
  setAdminToken: mocks.setAdminToken,
  hasAdminToken: mocks.hasAdminToken,
}))

import { ApcRto } from './ApcRto'

const STATION = '消费类聚合物锂离子电池 · 极片与电芯产线'
const SOURCE = {
  label: '内置仿真数据源',
  note: '未检测到可用的 HANA 配置，当前展示内置仿真过程数据。',
  simulated: true,
}

const SERIES = Array.from({ length: 12 }, (_, i) => ({ t: 1_700_000_000_000 + i * 60_000, v: 12.6 + i * 0.01 }))

function makeItem(over: Partial<ApcParamItem> = {}): ApcParamItem {
  return {
    code: 'COATING_DENSITY',
    name: '正极涂布面密度',
    process: '涂布',
    unit: 'mg/cm²',
    decimals: 2,
    objective: 'quality',
    objectiveLabel: '质量',
    setpoint: 12.6,
    optimalTarget: 12.6,
    min: 11.8,
    max: 13.4,
    lsl: 12.3,
    usl: 12.9,
    maxStepPct: 2,
    latest: 12.72,
    mean: 12.72,
    std: 0.05,
    min_: 12.6,
    max_: 12.8,
    sampleCount: 60,
    cpk: 1.2,
    slope: 0.0001,
    trend: 'stable',
    status: 'warning',
    series: SERIES,
    recommendation: {
      current: 12.6,
      suggested: 12.48,
      delta: -0.12,
      deltaPct: -0.95,
      confidence: 88,
      urgency: 'medium',
      hold: false,
      clampedBy: null,
      predictedMean: 12.6,
      predictedCpk: 1.8,
      reason: '均值高于 RTO 理想操作点，建议下调设定值',
      risk: '偏差较大，已改为分步调整',
    },
    ...over,
  }
}

const HOLD_ITEM = makeItem({
  code: 'FORMATION_TEMP',
  name: '化成柜温度',
  process: '化成',
  unit: '°C',
  decimals: 1,
  objective: 'energy',
  objectiveLabel: '能耗',
  setpoint: 45,
  optimalTarget: 45,
  lsl: 42,
  usl: 48,
  latest: 45.1,
  mean: 45.1,
  status: 'normal',
  cpk: 2.4,
  series: SERIES.map(p => ({ ...p, v: 45 + (p.v - 12.6) })),
  recommendation: {
    current: 45,
    suggested: 45,
    delta: 0,
    deltaPct: 0,
    confidence: 60,
    urgency: 'none',
    hold: true,
    clampedBy: null,
    reason: '偏差处于工艺死区内且过程能力正常，建议保持当前设定值',
  },
})

const OVERVIEW: ApcOverview = {
  station: STATION,
  mode: 'simulated',
  generatedAt: '2026-09-11T02:00:00.000Z',
  elapsedMs: 6,
  windowMinutes: 120,
  sampleIntervalSec: 120,
  rowCount: 600,
  truncated: false,
  source: SOURCE,
  params: [makeItem(), HOLD_ITEM],
}

const OPTIMIZATION: ApcOptimization = {
  station: STATION,
  mode: 'simulated',
  generatedAt: '2026-09-11T02:00:00.000Z',
  windowMinutes: 120,
  source: SOURCE,
  summary: { total: 2, actionable: 1, high: 0, medium: 1, danger: 0, avgConfidence: 74 },
  items: [makeItem(), HOLD_ITEM],
}

const STATUS: ApcStatusResponse = {
  enabled: true,
  mode: 'simulated',
  station: STATION,
  paramCount: 2,
  queryMode: 'long',
  catalogFile: 'server/apc.catalog.json',
  catalogOrigin: 'saved',
  catalogFileLocked: false,
  catalogError: '',
  configFile: 'server/data/apc.config.json',
  configFileExists: false,
  configFileError: '',
  hana: {
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
}

const HISTORY: ApcHistoryResponse = {
  param: {
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
  },
  mode: 'simulated',
  windowMinutes: 120,
  source: SOURCE,
  stats: { n: 12, mean: 12.66, std: 0.05, min: 12.6, max: 12.71, cpk: 1.2, trend: 'stable', status: 'warning' },
  points: SERIES,
}

beforeEach(() => {
  mocks.fetchApcStatus.mockReset().mockResolvedValue(STATUS)
  mocks.fetchApcOverview.mockReset().mockResolvedValue(OVERVIEW)
  mocks.fetchApcOptimization.mockReset().mockResolvedValue(OPTIMIZATION)
  mocks.fetchApcHistory.mockReset().mockResolvedValue(HISTORY)
})

describe('ApcRto 页面', () => {
  it('渲染标题、只读声明与数据源状态', async () => {
    render(<ApcRto />)
    expect(await screen.findByText('APC 和 RTO')).toBeInTheDocument()
    expect(screen.getByText('先进过程控制 · 实时优化')).toBeInTheDocument()
    // 只读安全边界必须在界面上明确展示
    expect(screen.getByText('仅 SELECT · 禁增删改')).toBeInTheDocument()
    expect(screen.getByText('内置仿真数据源')).toBeInTheDocument()
    // 仿真源要给出说明，避免被误当成真实数据
    expect(screen.getByText(/未检测到可用的 HANA 配置/)).toBeInTheDocument()
  })

  it('渲染汇总指标与读取统计', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    expect(screen.getByText('过程参数')).toBeInTheDocument()
    expect(screen.getByText('需调整')).toBeInTheDocument()
    expect(screen.getByText('高优先')).toBeInTheDocument()
    expect(screen.getByText('异常参数')).toBeInTheDocument()
    expect(screen.getByText('平均置信度')).toBeInTheDocument()
    expect(screen.getByText('74%')).toBeInTheDocument()
    expect(screen.getByText(/600 行/)).toBeInTheDocument()
  })

  it('实时概览按工序分组展示参数卡片', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    expect(screen.getByText('涂布工序')).toBeInTheDocument()
    expect(screen.getByText('化成工序')).toBeInTheDocument()
    expect(screen.getByText('正极涂布面密度')).toBeInTheDocument()
    expect(screen.getByText('化成柜温度')).toBeInTheDocument()
    // 实测值与「设定 → 建议」都要可读
    expect(screen.getByText('12.72')).toBeInTheDocument()
    expect(screen.getAllByText(/12\.48/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('预警').length).toBeGreaterThan(0)
  })

  it('优化建议页签展示建议值、置信度与推荐理由，并标注保持项', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    fireEvent.click(screen.getByText('优化建议'))

    expect(await screen.findByText('优化建议值')).toBeInTheDocument()
    // 两条建议各有一份「推荐理由」
    expect(screen.getAllByText('推荐理由：').length).toBe(2)
    expect(screen.getByText(/均值高于 RTO 理想操作点/)).toBeInTheDocument()
    expect(screen.getByText(/已改为分步调整/)).toBeInTheDocument()
    expect(screen.getByText('88%')).toBeInTheDocument()
    // 死区内的参数应显示「保持」而非给出调整量
    expect(screen.getByText('建议保持')).toBeInTheDocument()
    expect(screen.getByText(/工艺死区内/)).toBeInTheDocument()
  })

  it('点击参数卡片打开详情抽屉并按需拉取该参数历史', async () => {
    render(<ApcRto />)
    await screen.findByText('APC 和 RTO')
    fireEvent.click(screen.getByText('正极涂布面密度'))

    expect(await screen.findByText('单次调整上限')).toBeInTheDocument()
    expect(screen.getByText('规格下限 LSL')).toBeInTheDocument()
    expect(screen.getByText('规格上限 USL')).toBeInTheDocument()
    expect(screen.getByText('最新实测值')).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.fetchApcHistory).toHaveBeenCalledWith('COATING_DENSITY', { minutes: 120 })
    })
    // 明确「建议不会自动下发」，避免被理解为已写入 DCS/PLC
    expect(screen.getByText(/不会自动下发到 DCS\/PLC/)).toBeInTheDocument()
  })

  it('读取失败时给出可见错误提示', async () => {
    mocks.fetchApcOverview.mockRejectedValue(new Error('HANA 连接失败：主机不可达'))
    render(<ApcRto />)
    expect(await screen.findByText('读取过程数据失败')).toBeInTheDocument()
    expect(screen.getByText(/HANA 连接失败/)).toBeInTheDocument()
  })
})
