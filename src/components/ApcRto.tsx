// 「APC 和 RTO」页面
//
// 定位：先进过程控制（APC）+ 实时优化（RTO）。
//   - 即时读取只读数据源（HANA）中记录的过程数据列值；
//   - 一个监测项 = 1 个输出结果（CV，被控量）+ N 个参与参数（MV，操纵量）；
//   - 按加权最小调整把 CV 的偏差分摊给各 MV，给出「哪个参数动多少」的建议；
//   - 全程只读，不做任何写库操作；数据源与安全边界在后端统一约束。
//
// 数据源：系统不内置仿真/演示数据源。未创建监测项目、项目未添加监测项、监测项未配
// SQL 模板、或绑定的数据库未配置连接时，一律按「未配置数据源」展示空态引导，绝不展示任何推测数据。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  fetchApcStatus,
  fetchApcOverview,
  fetchApcOptimization,
  fetchApcHistory,
  fetchMesGuide,
} from '../services/apcApi'
import { ApcTrendChart } from './ApcTrendChart'
import { ApcConfigPanel } from './ApcConfigPanel'
import type {
  ApcCvResult,
  ApcHistoryResponse,
  ApcItemRecommendation,
  ApcMove,
  ApcOptimization,
  ApcOverview,
  ApcParamStatus,
  ApcSpecValue,
  ApcStatusResponse,
  ApcUrgency,
} from '../types'

const WINDOW_OPTIONS = [
  { value: 30, label: '近 30 分钟' },
  { value: 60, label: '近 1 小时' },
  { value: 120, label: '近 2 小时' },
  { value: 240, label: '近 4 小时' },
  { value: 480, label: '近 8 小时' },
  { value: 1440, label: '近 24 小时' },
]

const INTERVAL_OPTIONS = [
  { value: 15, label: '15 秒' },
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 300, label: '5 分钟' },
]

const STATUS_META: Record<ApcParamStatus, { label: string; color: string; bg: string; dot: string }> = {
  normal: { label: '正常', color: '#15803d', bg: '#f0fdf4', dot: '#22c55e' },
  warning: { label: '预警', color: '#b45309', bg: '#fffbeb', dot: '#f59e0b' },
  danger: { label: '异常', color: '#b91c1c', bg: '#fef2f2', dot: '#ef4444' },
  unknown: { label: '未知', color: '#64748b', bg: '#f1f5f9', dot: '#94a3b8' },
}

const URGENCY_META: Record<ApcUrgency, { label: string; color: string; bg: string }> = {
  high: { label: '高优先', color: '#b91c1c', bg: '#fef2f2' },
  medium: { label: '中优先', color: '#b45309', bg: '#fffbeb' },
  low: { label: '低优先', color: '#1d4ed8', bg: '#eff6ff' },
  none: { label: '保持', color: '#475569', bg: '#f1f5f9' },
}

const OBJECTIVE_ICON: Record<string, string> = {
  quality: '🎯',
  energy: '⚡',
  yield: '📈',
  stability: '⚖️',
}

/** 数据源未就绪时的下一步动作（与服务端 SOURCE_REASON_NOTE 对应） */
const REASON_LABEL: Record<string, string> = {
  'no-project': '尚未创建监测项目',
  'no-item': '当前项目尚未添加监测项',
  'no-template': '当前监测项尚未配置取数 SQL 模板',
  'no-connection': '绑定的数据库系统尚未配置连接',
}

function fmt(v: number | null | undefined, decimals: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(decimals)
}

/** 规格类字段显示：数字按小数位格式化；列名表达式原样展示（运行期才求值） */
function fmtSpec(v: ApcSpecValue | null | undefined, decimals: number): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(decimals) : '—'
  return String(v)
}

function fmtTime(iso: string | number | null): string {
  if (iso == null) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function trendArrow(trend: string): string {
  if (trend === 'up') return '↑'
  if (trend === 'down') return '↓'
  return '→'
}

/** 相对时间（用于「最近一次错误」这类历史事件，避免只给一个绝对时间不好判断新旧） */
function ago(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec} 秒前`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.round(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.round(hour / 24)} 天前`
}

function confidenceColor(c: number): string {
  if (c >= 85) return '#16a34a'
  if (c >= 70) return '#f59e0b'
  return '#ef4444'
}

/** 约束来源的中文说法（服务端可能返回逗号分隔的多个约束） */
function clampLabel(c: string | null | undefined): string {
  if (!c) return ''
  return String(c)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s === 'step' ? '单次限幅' : s === 'max' ? '顶到可调上限' : s === 'min' ? '顶到可调下限' : s))
    .join('、')
}

export function ApcRto({ initialProjectId }: { initialProjectId?: string | null } = {}) {
  const [status, setStatus] = useState<ApcStatusResponse | null>(null)
  const [overview, setOverview] = useState<ApcOverview | null>(null)
  const [optimization, setOptimization] = useState<ApcOptimization | null>(null)
  const [windowMinutes, setWindowMinutes] = useState(120)
  const [auto, setAuto] = useState(true)
  const [intervalSec, setIntervalSec] = useState(60)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'overview' | 'optimize'>('overview')
  const [detail, setDetail] = useState<{ code: string; isOutput: boolean } | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  // 项目制：当前选中的监测项目 + 正在编辑的项目 id（null = 新建）
  const [activeProject, setActiveProject] = useState<string>(() => {
    if (initialProjectId) return initialProjectId
    try { return localStorage.getItem('mes-ai-apc-project') || '' } catch { return '' }
  })
  const [activeItem, setActiveItem] = useState<string>(() => {
    try { return localStorage.getItem('mes-ai-apc-item') || '' } catch { return '' }
  })
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined) // undefined=关闭

  const projects = useMemo(() => status?.projects || [], [status])
  // 选中项目必须真实存在于服务端返回的列表里：
  // localStorage 里可能残留已被删除（或旧版本自动迁移出来的 p_default）的项目 id，
  // 这种脏 id 会让「编辑项目」去读一个不存在的项目，报「监测项目不存在：xxx」。
  const activeProjectId = useMemo(() => {
    if (!status) return activeProject
    if (activeProject && projects.some(p => p.id === activeProject)) return activeProject
    return projects[0]?.id || ''
  }, [status, activeProject, projects])
  const activeProjectMeta = projects.find(p => p.id === activeProjectId) || null

  // 监测项列表来自概览接口（服务端已按「当前有效项」回落），用于渲染选择器
  const itemOptions = useMemo(() => overview?.items || [], [overview])

  // 槽位显示名：一律取系统显示名（侧边栏「数据库管理」页的「系统显示名」），
  // 不再写死「数据库系统 1 / 2」——系统里改了名字本页跟着变；取不到时回落为变量本身（db1 / db2）。
  const [slotNames, setSlotNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    fetchMesGuide()
      .then(g => {
        if (cancelled || !g.slots?.length) return
        setSlotNames(Object.fromEntries(g.slots.map(s => [s.id, s.name || s.id])))
      })
      .catch(() => { /* 指引不可用时静默：回落为变量名 */ })
    return () => { cancelled = true }
  }, [])
  const slotLabel = useCallback(
    (slot?: string) => (slot ? (slotNames[slot] || slot) : ''),
    [slotNames]
  )

  const handleSelectProject = useCallback((id: string) => {
    setActiveProject(id)
    // 换项目后原监测项多半不属于新项目，清掉选择让服务端回落为该项目的第一个
    setActiveItem('')
    try {
      localStorage.setItem('mes-ai-apc-project', id)
      localStorage.removeItem('mes-ai-apc-item')
    } catch { /* 忽略 */ }
  }, [])

  const handleSelectItem = useCallback((id: string) => {
    setActiveItem(id)
    setDetail(null)
    try { localStorage.setItem('mes-ai-apc-item', id) } catch { /* 忽略 */ }
  }, [])

  // 打开项目编辑器：只认列表里真实存在的项目，其余一律按「新建」打开，
  // 绝不把脏 id 交给配置面板（面板会 404，页面显示「读取配置失败：监测项目不存在」）。
  const openEditor = useCallback((id: string) => {
    setEditingId(id && projects.some(p => p.id === id) ? id : null)
  }, [projects])

  // 自愈：确认本地记忆的项目 id 已不在列表里就清掉，免得下次进来继续拿它去请求
  useEffect(() => {
    if (!status || !activeProject) return
    if (projects.some(p => p.id === activeProject)) return
    setActiveProject('')
    setActiveItem('')
    try {
      localStorage.removeItem('mes-ai-apc-project')
      localStorage.removeItem('mes-ai-apc-item')
    } catch { /* 忽略 */ }
  }, [status, activeProject, projects])

  // 自愈：服务端会按「实际生效的监测项」回落，这里把它同步回本地，
  // 避免选中项已被删除后页面一直显示另一项却挂着旧的下拉值。
  useEffect(() => {
    const real = overview?.item?.id || ''
    if (!real || real === activeItem) return
    setActiveItem(real)
    try { localStorage.setItem('mes-ai-apc-item', real) } catch { /* 忽略 */ }
  }, [overview, activeItem])

  // 状态获取一律吞掉异常，且必须自身永不 reject：它会在 load() 的 finally 里被
  // 「发后不管」地调用（void loadStatus()），一旦这里抛错，外层 load 的 Promise 会
  // 变成未捕获的 rejection。用 async + 内部 try 把同步抛错也一并兜住。
  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchApcStatus()
      setStatus(s)
    } catch { /* 状态获取失败不阻塞主数据加载 */ }
  }, [])

  const load = useCallback(async (opts: { refresh?: boolean } = {}) => {
    setLoading(true)
    try {
      const base = {
        minutes: windowMinutes,
        refresh: opts.refresh,
        project: activeProjectId || undefined,
        item: activeItem || undefined,
      }
      const [ov, op] = await Promise.all([
        fetchApcOverview(base),
        fetchApcOptimization(base),
      ])
      setOverview(ov)
      setOptimization(op)
      setUpdatedAt(Date.now())
      setError('')
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
      // 取数之后连接状态一定变了（成功即已建连；失败则正是需要显示红灯的时候），
      // 所以这里无条件刷新一次状态——否则「已经取到数了，灯还是黄的」。
      void loadStatus()
    }
  }, [windowMinutes, activeProjectId, activeItem, loadStatus])

  // 配置保存后：重新拉状态（数据源就绪与否可能已变化）并立即刷新数据
  const handleConfigSaved = useCallback(() => {
    void loadStatus()
    void load({ refresh: true })
  }, [loadStatus, load])

  // 项目编辑器保存/删除成功后：刷新项目列表 + 数据；新建后自动切换选中
  const handleProjectSaved = useCallback((savedId?: string) => {
    setEditingId(undefined)
    if (savedId) handleSelectProject(savedId)
    void loadStatus()
    // load 依赖 activeProjectId，等一拍让选中项目生效后再刷新
    setTimeout(() => void load({ refresh: true }), 0)
  }, [handleSelectProject, loadStatus, load])

  useEffect(() => { void loadStatus() }, [loadStatus])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => { void load() }, Math.max(10, intervalSec) * 1000)
    return () => clearInterval(id)
  }, [auto, intervalSec, load])

  const output = overview?.output || null
  const rec: ApcItemRecommendation | null = output ? output.recommendation : null
  const moves: ApcMove[] = useMemo(() => output?.moves || [], [output])
  const movers = useMemo(() => moves.filter(m => m.delta !== 0), [moves])
  const excluded = useMemo(() => moves.filter(m => !m.participating), [moves])

  // ===== 复制建议 / 导出 CSV =====
  const buildAdviceText = useCallback((): string => {
    if (!overview || !overview.ready || !output) return ''
    const lines: string[] = []
    const r = output.recommendation
    lines.push('# APC / RTO 过程参数优化建议')
    lines.push(`装置：${overview.station || '—'}`)
    lines.push(`监测项目：${overview.projectName || '—'}`)
    lines.push(`监测项：${overview.item?.name || '—'}${overview.item?.description ? `（${overview.item.description}）` : ''}`)
    lines.push(`统计窗口：近 ${overview.windowMinutes} 分钟 · 生成时间：${fmtTime(overview.generatedAt)}`)
    lines.push(`数据源：${overview.source.label}`)
    lines.push('')
    lines.push(`## 输出结果 ${output.name}（${output.code}）`)
    lines.push(
      `窗口均值 ${fmt(output.mean, output.decimals)}${output.unit}，` +
      `RTO 理想点 ${fmt(output.target, output.decimals)}${output.unit}，` +
      `偏差 ${fmt(r.cv.delta, output.decimals)}${output.unit}（${(r.cv.delta ?? 0) >= 0 ? '偏低' : '偏高'}）`
    )
    lines.push(`规格 ${fmt(output.lsl, output.decimals)} ~ ${fmt(output.usl, output.decimals)}${output.unit}，过程能力 Cpk=${output.cpk == null ? '—' : output.cpk}（${STATUS_META[output.status].label}）`)
    lines.push(`紧急度：${URGENCY_META[r.urgency].label} · 置信度：${r.confidence}% · 分摊轮数：${r.rounds}`)
    if (!r.hold) {
      lines.push(
        `预计调整后均值 ${fmt(r.predictedCV, output.decimals)}${output.unit}` +
        (r.residual != null ? `，仍有残余偏差 ${fmt(r.residual, output.decimals)}${output.unit}（${r.residualPct}%）` : '')
      )
    }
    lines.push('')
    if (r.moves.length === 0) {
      lines.push('## 参数调整')
      lines.push(r.hold ? '各参数均无需调整（死区内或修正量小于最小调节步长）。' : '没有可参与求解的参数。')
    } else {
      lines.push('## 参数调整')
      r.moves.forEach((m, i) => {
        lines.push(
          `${i + 1}. ${m.name}（${m.code}）：${fmt(m.current, m.decimals)} → ${fmt(m.suggested, m.decimals)}${m.unit}` +
          `（${m.delta > 0 ? '+' : ''}${fmt(m.delta, m.decimals)}${m.unit}${m.deltaPct != null ? `，${m.deltaPct}%` : ''}）` +
          `，承担偏差 ${Math.round(m.share * 100)}%，影响系数 k=${m.k}，调整阻力 w=${m.weight}` +
          (m.clampedBy ? `（${clampLabel(m.clampedBy)}）` : '')
        )
      })
    }
    if (excluded.length > 0) {
      lines.push('')
      lines.push('## 未参与本次求解')
      excluded.forEach(m => lines.push(`- ${m.name}（${m.code}）：${m.excludedReason}`))
    }
    lines.push('')
    lines.push('## 推荐理由')
    lines.push(r.reason)
    if (r.risk) {
      lines.push('')
      lines.push('## 风险提示')
      lines.push(r.risk)
    }
    lines.push('')
    lines.push('说明：以上建议仅在页面展示，不会自动下发到 DCS/PLC，需由工艺工程师确认后手动执行。')
    return lines.join('\n')
  }, [overview, output, excluded])

  const handleCopy = useCallback(async () => {
    const text = buildAdviceText()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('复制失败，请检查浏览器剪贴板权限')
    }
  }, [buildAdviceText])

  const handleExportCsv = useCallback(() => {
    if (!overview || !output) return
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const row = (cells: unknown[]) => cells.map(esc).join(',')
    const lines: string[] = []

    lines.push(row(['# APC / RTO 优化建议']))
    lines.push(row(['装置', overview.station || '']))
    lines.push(row(['监测项目', overview.projectName || '']))
    lines.push(row(['监测项', overview.item?.name || '']))
    lines.push(row(['统计窗口（分钟）', overview.windowMinutes]))
    lines.push(row(['生成时间', fmtTime(overview.generatedAt)]))
    lines.push(row(['数据源', overview.source.label]))
    lines.push(row([
      '输出结果', `${output.name}(${output.code})`, output.unit,
      `均值 ${fmt(output.mean, output.decimals)}`,
      `理想点 ${fmt(output.target, output.decimals)}`,
      `偏差 ${fmt(output.recommendation.cv.delta, output.decimals)}`,
      `Cpk ${output.cpk == null ? '—' : output.cpk}`,
      STATUS_META[output.status].label,
      URGENCY_META[output.recommendation.urgency].label,
      `置信度 ${output.recommendation.confidence}%`,
    ]))
    lines.push('')
    lines.push(row([
      '参数名称', '参数编码', '单位', '当前值', '建议值', '调整量', '调整幅度%',
      '承担份额%', '影响系数k', '调整阻力w', '可调下限', '可调上限', '约束', '是否参与', '说明',
    ]))
    for (const m of moves) {
      lines.push(row([
        m.name, m.code, m.unit,
        fmt(m.current, m.decimals), fmt(m.suggested, m.decimals), fmt(m.delta, m.decimals),
        m.deltaPct == null ? '' : m.deltaPct,
        Math.round(m.share * 100),
        m.k, m.weight,
        fmtSpec(m.min, m.decimals), fmtSpec(m.max, m.decimals),
        clampLabel(m.clampedBy),
        m.participating ? '是' : '否',
        m.participating ? '' : m.excludedReason,
      ]))
    }
    lines.push('')
    lines.push(row(['推荐理由', output.recommendation.reason]))
    if (output.recommendation.risk) lines.push(row(['风险提示', output.recommendation.risk]))

    const csv = '\uFEFF' + lines.join('\r\n')
    const stamp = new Date()
    const name = `APC优化建议_${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}_${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.csv`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [overview, output, moves])

  const canExport = Boolean(overview?.ready && output)

  return (
    <div className="h-full overflow-y-auto bg-mes-bg">
      <div className="max-w-[1280px] mx-auto px-5 py-5">
        {/* ===== 标题与工具条 ===== */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-mes-text">APC 和 RTO</h1>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText font-medium">
                先进过程控制 · 实时优化
              </span>
            </div>
            <p className="text-xs text-mes-textTertiary mt-1 leading-relaxed">
              即时读取只读数据源中记录的过程数据列值，把输出结果的偏差按影响系数分摊到各参与参数，给出调整建议。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={windowMinutes}
              onChange={e => setWindowMinutes(Number(e.target.value))}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-mes-border bg-white text-mes-textSecondary focus:outline-none focus:border-mes-primary"
              title="统计窗口"
            >
              {WINDOW_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            <label className="flex items-center gap-1.5 text-xs text-mes-textSecondary px-2.5 py-1.5 rounded-lg border border-mes-border bg-white cursor-pointer">
              <input
                type="checkbox"
                checked={auto}
                onChange={e => setAuto(e.target.checked)}
                className="accent-mes-primary"
              />
              自动刷新
            </label>
            {auto && (
              <select
                value={intervalSec}
                onChange={e => setIntervalSec(Number(e.target.value))}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-mes-border bg-white text-mes-textSecondary focus:outline-none focus:border-mes-primary"
              >
                {INTERVAL_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>每 {o.label}</option>
                ))}
              </select>
            )}

            <button
              onClick={() => load({ refresh: true })}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover disabled:opacity-60 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'animate-spin' : ''}>
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              立即刷新
            </button>

            <select
              value={activeProjectId}
              onChange={e => handleSelectProject(e.target.value)}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-mes-border bg-white text-mes-textSecondary focus:outline-none focus:border-mes-primary max-w-[180px]"
              title="监测项目"
            >
              {projects.length === 0 && <option value="">（暂无项目）</option>}
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>

            <select
              value={overview?.item?.id || ''}
              onChange={e => handleSelectItem(e.target.value)}
              disabled={itemOptions.length === 0}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-mes-border bg-white text-mes-textSecondary focus:outline-none focus:border-mes-primary max-w-[200px] disabled:opacity-60"
              title="监测项（1 个输出结果 + N 个参与参数）"
            >
              {itemOptions.length === 0 && <option value="">（暂无监测项）</option>}
              {itemOptions.map(it => (
                <option key={it.id} value={it.id}>{it.name}</option>
              ))}
            </select>

            <button
              onClick={() => openEditor(activeProjectId)}
              disabled={!activeProjectId}
              title="编辑当前监测项目（监测项 / 取数 SQL / 输出结果 / 参与参数）"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              编辑项目
            </button>

            <button
              onClick={() => setEditingId(null)}
              title="新建监测项目"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              新建项目
            </button>

            <button
              onClick={handleCopy}
              disabled={!canExport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {copied ? '已复制' : '复制建议'}
            </button>

            <button
              onClick={handleExportCsv}
              disabled={!canExport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              导出 CSV
            </button>
          </div>
        </div>

        {/* ===== 数据源状态条 ===== */}
        <div className="rounded-xl border border-mes-border bg-white px-4 py-3 mb-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-mes-textTertiary">数据源</span>
              <span className={`px-2 py-0.5 rounded-full font-medium ${
                overview?.mode === 'hana'
                  ? 'bg-green-50 text-green-700'
                  : 'bg-amber-50 text-amber-700'
              }`}>
                {overview?.source?.label || '—'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-mes-textTertiary">只读模式</span>
              <span className="px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">仅 SELECT · 禁增删改</span>
            </div>
            {activeProjectMeta && (
              <div className="flex items-center gap-2">
                <span className="text-mes-textTertiary">项目库</span>
                {/* 槽位显示名一律取系统显示名（侧边栏「数据库管理」页），系统里改名这里跟着变 */}
                <span className="text-mes-textSecondary">{slotLabel(activeProjectMeta.dbSlot)}</span>
              </div>
            )}
            {status?.hana && status.hana.slots?.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-mes-textTertiary">连接</span>
                {status.hana.slots.map(s => (
                  <span key={s.id} className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${s.connected ? 'bg-mes-success' : (s.configured ? 'bg-amber-400' : 'bg-gray-300')}`} />
                    <span className="text-mes-textSecondary">
                      {s.configured
                        ? (s.connected
                            ? `${s.name || s.id} 已连接 ${s.host}:${s.port}`
                            : `${s.name || s.id} 未连接${s.lastError ? '（探测失败）' : ''}`)
                        : `${s.name || s.id} 未配置`}
                    </span>
                  </span>
                ))}
                {overview?.mode !== 'hana' && <span className="text-mes-textSecondary">未配置（不展示数据）</span>}
              </div>
            )}
            {overview && overview.ready && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-mes-textTertiary">本次读取</span>
                  <span className="text-mes-textSecondary">{overview.rowCount} 行 / {overview.elapsedMs} ms</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-mes-textTertiary">更新时间</span>
                  <span className="text-mes-textSecondary">{fmtTime(updatedAt)}</span>
                </div>
              </>
            )}
            {overview?.truncated && (
              <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium">
                结果已按上限截断，建议缩小统计窗口
              </span>
            )}
          </div>
          {Array.isArray(overview?.warnings) && overview.warnings.length > 0 && (
            <div className="mt-3 pt-3 border-t border-mes-border text-[11px] text-amber-700 leading-relaxed space-y-1">
              {overview.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}
          {overview && !overview.ready && (
            <div className="mt-3 pt-3 border-t border-mes-border text-[11px] text-mes-textTertiary leading-relaxed">
              {overview.source?.note}
            </div>
          )}
          {overview?.mode === 'hana' && status?.hana?.slots?.some(s => s.configured && !s.connected && s.lastError) && (
            <div className="mt-3 pt-3 border-t border-mes-border text-[11px] text-red-600">
              {status.hana.slots
                .filter(s => s.configured && !s.connected && s.lastError)
                .map(s => (
                  <div key={s.id}>
                    最近一次数据源错误（{s.name || s.id}）：{s.lastError}
                    {s.lastErrorAt ? `（${ago(s.lastErrorAt)}）` : ''}
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* ===== 错误提示 ===== */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 mb-4 text-xs text-red-700 leading-relaxed">
            <div className="font-medium mb-1">读取过程数据失败</div>
            <div>{error}</div>
            {status?.catalogError && <div className="mt-1">参数目录异常：{status.catalogError}</div>}
          </div>
        )}

        {/* ===== 汇总指标（仅在数据源就绪时展示）===== */}
        {output && rec && overview?.ready && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-mes-border rounded-xl overflow-hidden border border-mes-border mb-4">
            <MetricCell label="输出结果" value={output.code} hint={output.name} />
            <MetricCell
              label="需调整参数"
              value={`${movers.length} / ${moves.length}`}
              hint="有修正量 / 全部参与参数"
              tone={movers.length > 0 ? 'primary' : 'normal'}
            />
            <MetricCell
              label="预计残余偏差"
              value={rec.residual == null ? '—' : `${fmt(rec.residual, output.decimals)}`}
              hint={rec.residualPct == null ? '—' : `占原偏差 ${rec.residualPct}%`}
              tone={rec.residualPct != null && rec.residualPct > 20 ? 'danger' : 'normal'}
            />
            <MetricCell label="过程能力 Cpk" value={output.cpk == null ? '—' : String(output.cpk)} hint={STATUS_META[output.status].label} tone={output.status === 'danger' ? 'danger' : 'normal'} />
            <MetricCell label="平均置信度" value={`${rec.confidence}%`} hint="基于样本量、能力与标定来源" />
          </div>
        )}

        {/* ===== 页签 ===== */}
        <div className="flex items-center gap-1 mb-3 border-b border-mes-border">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
            实时概览
          </TabButton>
          <TabButton active={tab === 'optimize'} onClick={() => setTab('optimize')}>
            优化建议
            {movers.length > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText font-medium">{movers.length}</span>
            )}
          </TabButton>
        </div>

        {/* ===== 内容 ===== */}
        {!overview && !error && (
          <div className="py-16 text-center text-sm text-mes-textTertiary">
            <div className="animate-pulse">正在读取过程数据…</div>
          </div>
        )}

        {/* ===== 未配置数据源：空态引导（不展示任何曲线、统计与优化建议）===== */}
        {overview && !overview.ready && (
          <div className="rounded-xl border border-dashed border-mes-border bg-white px-6 py-12 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-mes-tagBg text-mes-tagText flex items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-mes-text mb-1.5">未配置数据源</h3>
            {overview.reason && REASON_LABEL[overview.reason] && (
              <div className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 inline-block mb-2">
                {REASON_LABEL[overview.reason]}
              </div>
            )}
            <p className="text-xs text-mes-textSecondary leading-relaxed max-w-[640px] mx-auto">
              {overview.source?.note || '请先新建监测项目，为它添加监测项并配置取数 SQL 模板。'}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => openEditor(activeProjectId)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover transition-colors"
              >
                {activeProjectId ? '编辑当前项目' : '新建监测项目'}
              </button>
              <button
                onClick={() => { void loadStatus(); void load({ refresh: true }) }}
                disabled={loading}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50 transition-colors"
              >
                重新检测
              </button>
            </div>
            <p className="mt-3 text-[11px] text-mes-textTertiary">
              {projects.length === 0
                ? '当前还没有任何监测项目'
                : `当前共 ${projects.length} 个监测项目${activeProjectMeta ? ` · 该项目有 ${activeProjectMeta.itemCount} 个监测项` : ''}`}
            </p>
          </div>
        )}

        {overview?.ready && output && rec && tab === 'overview' && (
          <div className="space-y-4">
            <OutputCard output={output} />
            <ParamStatusTable
              moves={moves}
              unit={output.unit}
              excludedCount={excluded.length}
              onOpenCurve={m => setDetail({ code: m.code, isOutput: false })}
              onOpenOutputCurve={() => setDetail({ code: output.code, isOutput: true })}
            />
          </div>
        )}

        {overview?.ready && output && rec && tab === 'optimize' && (
          <div className="space-y-4">
            <RecommendationPanel
              output={output}
              rec={rec}
              onOpenOutputCurve={() => setDetail({ code: output.code, isOutput: true })}
            />
            <MovesTable
              title="参数调整明细"
              desc="按杠杆份额 k²·量程²/w 把输出结果的偏差分摊给各参数；约束生效时会把未消除部分重新分摊给未顶限的参数"
              moves={moves}
              unit={output.unit}
              emphasize
              onOpenCurve={m => setDetail({ code: m.code, isOutput: false })}
            />
            {excluded.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="text-xs font-semibold text-amber-800 mb-1.5">未参与本次求解的参数</div>
                <div className="space-y-1">
                  {excluded.map(m => (
                    <div key={m.code} className="text-[11px] text-amber-800">
                      · {m.name}（{m.code}）：{m.excludedReason || '未参与'}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-amber-700 leading-relaxed">
                  k 为 0 的参数可用单变量试验估计：k ≈ ΔCV / ΔMV；标定后它才会参与分摊。
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== 详情抽屉 ===== */}
      {detail && (
        <CurveDetail
          code={detail.code}
          isOutput={detail.isOutput}
          windowMinutes={windowMinutes}
          projectId={activeProjectId}
          itemId={overview?.item?.id || ''}
          onClose={() => setDetail(null)}
        />
      )}

      {/* ===== 监测项目编辑器（项目设置 / 监测项）===== */}
      {editingId !== undefined && (
        <ApcConfigPanel
          projectId={editingId}
          onClose={() => setEditingId(undefined)}
          onSaved={handleProjectSaved}
        />
      )}
    </div>
  )
}

// ===== 子组件 =====

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-mes-primary text-mes-primary'
          : 'border-transparent text-mes-textSecondary hover:text-mes-text'
      }`}
    >
      <span className="inline-flex items-center">{children}</span>
    </button>
  )
}

function MetricCell({ label, value, hint, tone = 'normal' }: { label: string; value: string; hint: string; tone?: 'normal' | 'primary' | 'danger' }) {
  const color = tone === 'danger' ? 'text-red-600' : tone === 'primary' ? 'text-mes-primary' : 'text-mes-text'
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-[11px] text-mes-textTertiary mb-1">{label}</div>
      <div className={`text-xl font-bold truncate ${color}`}>{value}</div>
      <div className="text-[10px] text-mes-textTertiary mt-0.5 truncate">{hint}</div>
    </div>
  )
}

function Sparkline({ points, color }: { points: { t: number; v: number }[]; color: string }) {
  if (points.length < 2) return <div className="h-8" />
  const w = 160
  const h = 32
  const vs = points.map(p => p.v)
  let lo = Math.min(...vs)
  let hi = Math.max(...vs)
  if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
  const path = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w
    const y = h - ((p.v - lo) / (hi - lo)) * h
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8" preserveAspectRatio="none">
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** 输出结果（CV）大卡片：实时值 + 统计 + 规格 + 点级超限 */
function OutputCard({ output }: { output: ApcCvResult }) {
  const meta = STATUS_META[output.status]
  const specExprs = output.specResolved?.ok ? Object.entries(output.specResolved.expressions || {}) : []
  const pdev = output.pointDeviation
  return (
    <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-mes-border bg-gray-50/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm">{OBJECTIVE_ICON[output.objective] || '🎯'}</span>
          <span className="text-sm font-semibold text-mes-text truncate">{output.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-mes-border text-mes-textTertiary shrink-0">
            输出结果 · {output.code}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: meta.color, backgroundColor: meta.bg }}>
            {meta.label}
          </span>
        </div>
        <span className="text-[10px] text-mes-textTertiary shrink-0">影响{output.objectiveLabel}</span>
      </div>

      <div className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="text-[10px] text-mes-textTertiary">实测值（最新）</div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold" style={{ color: output.status === 'normal' ? '#1a1a1a' : meta.color }}>
                {fmt(output.latest, output.decimals)}
              </span>
              {output.unit && <span className="text-[11px] text-mes-textTertiary">{output.unit}</span>}
            </div>
            <div className="text-[10px] text-mes-textTertiary mt-0.5">
              窗口均值 {fmt(output.mean, output.decimals)} · σ {fmt(output.std, output.decimals)}
              <span className="ml-1">{trendArrow(output.trend)}</span>
            </div>
          </div>
          <div className="w-[45%] max-w-[260px] min-w-[140px] flex-1">
            <Sparkline points={output.series} color={meta.dot} />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 sm:grid-cols-6 gap-px bg-mes-border rounded-lg overflow-hidden">
          <MiniStat label="RTO 理想点" value={fmt(output.target, output.decimals)} />
          <MiniStat label="规格范围" value={`${fmt(output.lsl, output.decimals)} ~ ${fmt(output.usl, output.decimals)}`} />
          <MiniStat label="Cpk" value={output.cpk == null ? '—' : String(output.cpk)} />
          <MiniStat label="窗口极差" value={`${fmt(output.min_, output.decimals)} ~ ${fmt(output.max_, output.decimals)}`} />
          <MiniStat label="样本点数" value={String(output.sampleCount)} />
          <MiniStat label="趋势" value={`${trendArrow(output.trend)} ${output.trend === 'up' ? '上行' : output.trend === 'down' ? '下行' : '平稳'}`} />
        </div>

        {output.specResolved && !output.specResolved.ok && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
            规格未能确定，本次不做优化判定：{output.specResolved.errors.join('；')}。
            {output.specResolved.columns.length > 0 && (
              <> 涉及列：<span className="font-mono">{output.specResolved.columns.join('、')}</span>。</>
            )}
            请在「编辑项目 → 监测项 → 取数与输出」核对规格表达式引用的列名是否已出现在取数 SQL 的结果列中。
          </div>
        )}
        {specExprs.length > 0 && (
          <div className="mt-2 text-[10px] text-mes-textTertiary leading-relaxed">
            规格取自列名表达式（按每行求值）：
            {specExprs.map(([f, src]) => (
              <span key={f} className="ml-1.5 font-mono">{f} = {src}</span>
            ))}
          </div>
        )}
        {output.specResolved?.ok && pdev && pdev.n > 0 && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
            pdev.outOfSpec > 0
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
          >
            {pdev.outOfSpec > 0 ? (
              <>
                窗口 {pdev.n} 个采样点中 <span className="font-semibold">{pdev.outOfSpec}</span> 点超规格
                （超上限 {pdev.outHigh}、低下限 {pdev.outLow}）
                {pdev.worst && (
                  <>
                    　最差：{fmt(pdev.worst.v, output.decimals)}{output.unit}，
                    偏离 {fmt(pdev.worst.deviation, output.decimals)}{output.unit}
                    （{pdev.worst.direction === 'high' ? '超上限' : '低下限'}）
                  </>
                )}
              </>
            ) : (
              <>窗口 {pdev.n} 个采样点全部落在规格内。</>
            )}
            <span className="text-mes-textTertiary">（点级按各自数据行判定，不受趋势图降采样影响）</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 优化建议面板：预计效果 + 理由 + 风险 */
function RecommendationPanel({
  output, rec, onOpenOutputCurve,
}: {
  output: ApcCvResult
  rec: ApcItemRecommendation
  onOpenOutputCurve: () => void
}) {
  const uMeta = URGENCY_META[rec.urgency]
  const cColor = confidenceColor(rec.confidence)
  return (
    <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-mes-border bg-gray-50/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-mes-text">优化建议 · {output.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: uMeta.color, backgroundColor: uMeta.bg }}>
            {uMeta.label}
          </span>
          {rec.hold && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 shrink-0">建议保持</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[11px] text-mes-textSecondary">
            置信度
            <span className="font-semibold" style={{ color: cColor }}>{rec.confidence}%</span>
          </span>
          {rec.rounds > 1 && (
            <span className="text-[10px] text-mes-textTertiary" title="某参数顶到约束后，未消除的偏差被重新分摊给其它参数">
              分摊 {rec.rounds} 轮
            </span>
          )}
          <button onClick={onOpenOutputCurve} className="text-[11px] text-mes-primary hover:underline">
            查看输出结果趋势 →
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-3">
          <div>
            <div className="text-[10px] text-mes-textTertiary mb-0.5">输出结果均值</div>
            <div className="text-lg font-bold text-mes-textSecondary">
              {fmt(rec.cv.current, output.decimals)}
              {output.unit && <span className="text-[11px] font-normal ml-0.5">{output.unit}</span>}
            </div>
          </div>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
            rec.hold ? 'bg-gray-100 text-gray-400' : ((rec.cv.delta ?? 0) > 0 ? 'bg-orange-50 text-orange-500' : 'bg-blue-50 text-blue-500')
          }`}>
            {rec.hold ? <span className="text-xs">—</span> : <span className="text-xs font-bold">{(rec.cv.delta ?? 0) > 0 ? '↑' : '↓'}</span>}
          </div>
          <div>
            <div className="text-[10px] text-mes-textTertiary mb-0.5">RTO 理想操作点</div>
            <div className="text-lg font-bold text-mes-text" style={{ color: '#4d6bfe' }}>
              {fmt(rec.cv.target, output.decimals)}
              {output.unit && <span className="text-[11px] font-normal ml-0.5">{output.unit}</span>}
            </div>
          </div>
          {rec.cv.delta != null && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText">
              偏差 {fmt(rec.cv.delta, output.decimals)}{output.unit}（{(rec.cv.delta) >= 0 ? '偏低' : '偏高'}）
            </span>
          )}
          {rec.clampedBy && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
              约束生效：{clampLabel(rec.clampedBy)}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-mes-border rounded-lg overflow-hidden mb-3">
          <MiniStat label="预计调整后均值" value={fmt(rec.predictedCV, output.decimals)} />
          <MiniStat label="预计残余偏差" value={rec.residual == null ? '—' : fmt(rec.residual, output.decimals)} />
          <MiniStat label="残余占原偏差" value={rec.residualPct == null ? '—' : `${rec.residualPct}%`} />
          <MiniStat label="需调整参数" value={`${rec.moves.length} 个`} />
        </div>

        <div className="bg-gray-50 rounded-lg p-2.5">
          <p className="text-xs text-mes-textSecondary leading-relaxed">
            <span className="font-medium text-mes-text">推荐理由：</span>{rec.reason}
          </p>
          {rec.risk && (
            <p className="text-xs text-amber-700 leading-relaxed mt-1.5">
              <span className="font-medium">风险提示：</span>{rec.risk}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** 参与参数调整表 */
function MovesTable({
  title, desc, moves, unit, emphasize = false, onOpenCurve,
}: {
  title: string
  desc?: string
  moves: ApcMove[]
  unit: string
  /** true=突出调整量与承担份额（优化建议页） */
  emphasize?: boolean
  onOpenCurve: (m: ApcMove) => void
}) {
  if (moves.length === 0) {
    return (
      <div className="rounded-xl border border-mes-border bg-white px-4 py-8 text-center text-xs text-mes-textTertiary">
        该监测项尚未配置参与参数，只能观察输出结果。
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-mes-border bg-gray-50/60">
        <div className="text-sm font-semibold text-mes-text">{title}</div>
        {desc && <div className="text-[11px] text-mes-textTertiary mt-0.5 leading-relaxed">{desc}</div>}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-[11px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">参数</th>
              <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">当前值{unit ? `（${unit}）` : ''}</th>
              <th className="px-3 py-2 text-center font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border"></th>
              <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">建议值</th>
              <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">调整量</th>
              <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">幅度</th>
              {emphasize && (
                <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">承担偏差</th>
              )}
              <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">k</th>
              <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">w</th>
              <th className="px-3 py-2 text-left font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">可调范围</th>
              <th className="px-3 py-2 text-left font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">约束</th>
              <th className="px-3 py-2 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border"></th>
            </tr>
          </thead>
          <tbody>
            {moves.map(m => {
              const moving = m.delta !== 0
              return (
                <tr key={m.code} className={`odd:bg-white even:bg-gray-50/50 ${m.participating ? '' : 'opacity-70'}`}>
                  <td className="px-3 py-2 border-b border-mes-border/60 align-middle">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-mes-text">{m.name}</span>
                      {!m.participating && (
                        <span className="text-[9px] px-1 rounded bg-amber-50 text-amber-700" title={m.excludedReason}>未参与</span>
                      )}
                    </div>
                    <div className="text-[10px] text-mes-textTertiary font-mono">{m.code}</div>
                  </td>
                  <td className="px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap text-mes-textSecondary font-mono">
                    {fmt(m.current, m.decimals)}
                  </td>
                  <td className="px-3 py-2 border-b border-mes-border/60 text-center text-mes-textTertiary">
                    {m.participating ? '→' : '—'}
                  </td>
                  <td className={`px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap font-mono ${moving ? 'font-semibold' : 'text-mes-textTertiary'}`}
                      style={moving ? { color: m.delta > 0 ? '#ea580c' : '#16a34a' } : undefined}>
                    {fmt(m.suggested, m.decimals)}
                  </td>
                  <td className={`px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap font-mono ${moving ? 'font-semibold' : 'text-mes-textTertiary'}`}>
                    {moving ? `${m.delta > 0 ? '+' : ''}${fmt(m.delta, m.decimals)}` : '0'}
                  </td>
                  <td className="px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap text-mes-textSecondary">
                    {m.deltaPct == null ? '—' : `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%`}
                  </td>
                  {emphasize && (
                    <td className="px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap">
                      {moving ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-mes-text">{Math.round(m.share * 100)}%</span>
                          <span className="w-10 h-1.5 rounded-full bg-gray-100 overflow-hidden inline-block">
                            <span className="block h-full bg-mes-primary" style={{ width: `${Math.min(100, Math.round(m.share * 100))}%` }} />
                          </span>
                        </span>
                      ) : <span className="text-mes-textTertiary">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap font-mono text-mes-textSecondary">
                    {m.k === 0 ? <span className="text-amber-600">0</span> : m.k}
                    {m.kMode === 'calibrated' && <span className="ml-1 text-[9px] text-emerald-600">标</span>}
                  </td>
                  <td className="px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap font-mono text-mes-textSecondary">{m.weight}</td>
                  <td className="px-3 py-2 border-b border-mes-border/60 whitespace-nowrap text-mes-textTertiary font-mono">
                    {fmtSpec(m.min, m.decimals)} ~ {fmtSpec(m.max, m.decimals)}
                  </td>
                  <td className="px-3 py-2 border-b border-mes-border/60 whitespace-nowrap">
                    {m.clampedBy
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">{clampLabel(m.clampedBy)}</span>
                      : <span className="text-mes-textTertiary">—</span>}
                  </td>
                  <td className="px-3 py-2 border-b border-mes-border/60 text-right whitespace-nowrap">
                    <button onClick={() => onOpenCurve(m)} className="text-[10px] text-mes-primary hover:underline">
                      曲线
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 text-[10px] text-mes-textTertiary bg-gray-50 border-t border-mes-border">
        调整量按各参数自己的小数位取整；「承担偏差」= |kᵢ·ΔMVᵢ| / |ΔCV|；「k」标「标」表示该系数来自自动标定。
      </div>
    </div>
  )
}

/** 实时概览页的参数现状表（不做分摊，只看现状与求解资格） */
function ParamStatusTable({
  moves, unit, excludedCount, onOpenCurve, onOpenOutputCurve,
}: {
  moves: ApcMove[]
  unit: string
  excludedCount: number
  onOpenCurve: (m: ApcMove) => void
  onOpenOutputCurve: () => void
}) {
  return (
    <div>
      {excludedCount > 0 && (
        <div className="mb-2 text-[11px] text-amber-700">
          有 {excludedCount} 个参与参数未参与求解（停用 / 未取到数据 / k 未标定），详见「优化建议」页。
        </div>
      )}
      <MovesTable
        title="参与参数现状"
        desc="当前工作点、可调范围与求解资格；点右侧「曲线」可看该参数的历史走势"
        moves={moves}
        unit={unit}
        onOpenCurve={onOpenCurve}
      />
      <div className="mt-2 text-right">
        <button onClick={onOpenOutputCurve} className="text-[11px] text-mes-primary hover:underline">
          查看输出结果趋势 →
        </button>
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-2.5 py-2">
      <div className="text-[10px] text-mes-textTertiary mb-0.5">{label}</div>
      <div className="text-xs font-medium text-mes-text truncate">{value}</div>
    </div>
  )
}

/** 单条曲线详情抽屉：输出结果（含规格带）或任一参与参数 */
function CurveDetail({
  code, isOutput, windowMinutes, projectId, itemId, onClose,
}: {
  code: string
  isOutput: boolean
  windowMinutes: number
  projectId?: string
  itemId?: string
  onClose: () => void
}) {
  const [history, setHistory] = useState<ApcHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  /** 横轴口径：默认自动（有时间戳按时间，没有则退化为序号） */
  const [axisMode, setAxisMode] = useState<'auto' | 'time' | 'index'>('auto')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr('')
    fetchApcHistory(code, { minutes: windowMinutes, project: projectId || undefined, item: itemId || undefined })
      .then(h => { if (!cancelled) setHistory(h) })
      .catch(e => { if (!cancelled) setErr(e?.message || String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [code, windowMinutes, projectId, itemId])

  const param = history?.param || null
  const stats = history?.stats || null
  const points = history?.points || []
  const specInfo = history?.specResolved
  const pdev = history?.pointDeviation
  const status: ApcParamStatus = stats?.status || 'unknown'
  const meta = STATUS_META[status]
  const decimals = param?.decimals ?? 3
  const specExprs = specInfo?.ok ? Object.entries(specInfo.expressions || {}) : []

  // 时间戳缺失或重复时，用相邻点时间差算出的「采样间隔」会是 0 秒，属于误导性数字，直接给 —。
  const sampleIntervalSec = useMemo(() => {
    const pts = points
    if (pts.length < 2) return null
    const span = pts[pts.length - 1].t - pts[0].t
    const uniq = new Set(pts.map(p => p.t)).size
    if (!Number.isFinite(span) || span <= 0 || uniq < 2) return null
    return Math.round(span / (pts.length - 1) / 1000)
  }, [points])

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-[860px] h-full bg-white shadow-2xl overflow-y-auto animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-mes-border px-5 py-3 flex items-center justify-between gap-3 z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-mes-text truncate">{param?.name || code}</h2>
              {isOutput ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-mes-tagBg text-mes-tagText font-medium shrink-0">输出结果</span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-mes-border text-mes-textTertiary shrink-0">参与参数</span>
              )}
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: meta.color, backgroundColor: meta.bg }}>
                {meta.label}
              </span>
            </div>
            <div className="text-[11px] text-mes-textTertiary mt-0.5">
              {param?.code || code}
              {history?.item?.name ? ` · 监测项 ${history.item.name}` : ''}
              {param?.unit ? ` · 单位 ${param.unit}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-mes-textTertiary shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {loading && !history && (
            <div className="text-xs text-mes-textTertiary animate-pulse">正在读取该曲线的历史数据列值…</div>
          )}
          {err && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              读取失败：{err}
            </div>
          )}
          {history && !history.ready && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              当前监测项未就绪，无法读取曲线：{history.reason ? REASON_LABEL[history.reason] || history.reason : ''}
            </div>
          )}

          {specInfo && !specInfo.ok && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 leading-relaxed">
              <span className="font-medium">规格未能确定：</span>{specInfo.errors.join('；')}。
              {specInfo.columns.length > 0 && (
                <> 涉及列：<span className="font-mono">{specInfo.columns.join('、')}</span>。</>
              )}
              请在「编辑项目 → 监测项 → 取数与输出」核对规格表达式引用的列名是否已写进取数 SQL 的 SELECT。
            </div>
          )}
          {specExprs.length > 0 && (
            <div className="text-[10px] text-mes-textTertiary leading-relaxed">
              规格取自列名表达式（按每行求值）：
              {specExprs.map(([f, src]) => (
                <span key={f} className="ml-1.5 font-mono">{f} = {src}</span>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-1 text-[11px]">
            <span className="text-mes-textTertiary mr-1">横轴</span>
            {([['auto', '自动'], ['time', '按时间'], ['index', '按序号']] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setAxisMode(v)}
                className={`px-2 py-0.5 rounded-full border transition-colors ${
                  axisMode === v
                    ? 'border-mes-primary text-mes-primary bg-mes-tagBg'
                    : 'border-mes-border text-mes-textTertiary hover:text-mes-textSecondary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <ApcTrendChart
            points={points}
            lsl={isOutput ? (param?.lsl ?? null) : null}
            usl={isOutput ? (param?.usl ?? null) : null}
            setpoint={isOutput ? null : (param?.min ?? null)}
            optimalTarget={isOutput ? (param?.target ?? null) : (param?.max ?? null)}
            unit={param?.unit || ''}
            decimals={decimals}
            status={status}
            height={240}
            axisMode={axisMode}
            setpointLabel="可调下限"
            targetLabel="可调上限"
          />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-mes-border rounded-xl overflow-hidden border border-mes-border">
            <MiniStat label="窗口均值" value={`${fmt(stats?.mean ?? null, decimals)}${param?.unit ? ' ' + param.unit : ''}`} />
            <MiniStat label="标准差 σ" value={fmt(stats?.std ?? null, decimals)} />
            <MiniStat label="窗口极值" value={`${fmt(stats?.min ?? null, decimals)} ~ ${fmt(stats?.max ?? null, decimals)}`} />
            <MiniStat label="样本点数" value={String(stats?.n ?? 0)} />
            {isOutput ? (
              <>
                <MiniStat label="RTO 理想点" value={fmt(param?.target ?? null, decimals)} />
                <MiniStat label="规格下限 LSL" value={fmt(param?.lsl ?? null, decimals)} />
                <MiniStat label="规格上限 USL" value={fmt(param?.usl ?? null, decimals)} />
                <MiniStat label="过程能力 Cpk" value={stats?.cpk == null ? '—' : String(stats.cpk)} />
              </>
            ) : (
              <>
                <MiniStat label="可调下限" value={fmt(param?.min ?? null, decimals)} />
                <MiniStat label="可调上限" value={fmt(param?.max ?? null, decimals)} />
                <MiniStat label="趋势" value={`${trendArrow(stats?.trend || 'stable')} ${stats?.trend === 'up' ? '上行' : stats?.trend === 'down' ? '下行' : '平稳'}`} />
                <MiniStat label="采样间隔" value={sampleIntervalSec == null ? '—（未取到时间列）' : `${sampleIntervalSec} 秒`} />
              </>
            )}
          </div>

          {pdev && pdev.n > 0 && isOutput && (
            <div className={`rounded-xl border px-4 py-3 text-[11px] leading-relaxed ${
              pdev.outOfSpec > 0
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
            >
              <span className="font-medium">点级规格判定（全量 {pdev.n} 点，不受趋势图降采样影响）：</span>
              {pdev.outOfSpec > 0
                ? ` ${pdev.outOfSpec} 点超规格（超上限 ${pdev.outHigh}、低下限 ${pdev.outLow}）`
                : ' 全部落在规格内'}
              {pdev.worst && (
                <>；最差点 {fmt(pdev.worst.v, decimals)}{param?.unit || ''}，偏离 {fmt(pdev.worst.deviation, decimals)}{param?.unit || ''}（{pdev.worst.direction === 'high' ? '超上限' : '低下限'}）</>
              )}
              。超限点在趋势图上以红点标出。
            </div>
          )}

          <div className="rounded-xl bg-gray-50 px-4 py-3 text-[11px] text-mes-textTertiary leading-relaxed">
            说明：本页所有过程数据均来自只读数据源的 SELECT 查询，不做任何写库操作；
            设定值建议仅在页面展示，不会自动下发到 DCS/PLC，需由工艺工程师确认后手动执行。
          </div>
        </div>
      </div>
    </div>
  )
}
