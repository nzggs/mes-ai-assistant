// 「APC 和 RTO」页面
//
// 定位：先进过程控制（APC）+ 实时优化（RTO）。
//   - 即时读取只读数据源（HANA）中记录的过程数据列值；
//   - 依据数据变化（均值偏移、波动、趋势）优化过程参数设定值，给出建议值；
//   - 全程只读，不做任何写库操作；数据源与安全边界在后端统一约束。
//
// 数据源未配置 HANA 时后端回退到内置仿真数据源，页面会明确标注，仅用于功能验证。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchApcStatus,
  fetchApcOverview,
  fetchApcOptimization,
  fetchApcHistory,
} from '../services/apcApi'
import { ApcTrendChart } from './ApcTrendChart'
import { ApcConfigPanel } from './ApcConfigPanel'
import type {
  ApcHistoryResponse,
  ApcOptimization,
  ApcOverview,
  ApcParamItem,
  ApcParamStatus,
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

function fmt(v: number | null | undefined, decimals: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(decimals)
}

function fmtTime(iso: string | number | null): string {
  if (iso == null) return '—'
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function trendArrow(trend: string) {
  if (trend === 'up') return '↑'
  if (trend === 'down') return '↓'
  return '→'
}

function confidenceColor(c: number): string {
  if (c >= 85) return '#16a34a'
  if (c >= 70) return '#f59e0b'
  return '#ef4444'
}

export function ApcRto() {
  const [status, setStatus] = useState<ApcStatusResponse | null>(null)
  const [overview, setOverview] = useState<ApcOverview | null>(null)
  const [optimization, setOptimization] = useState<ApcOptimization | null>(null)
  const [windowMinutes, setWindowMinutes] = useState(120)
  const [auto, setAuto] = useState(true)
  const [intervalSec, setIntervalSec] = useState(60)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'overview' | 'optimize'>('overview')
  const [detailCode, setDetailCode] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)

  const loadStatus = useCallback(() => {
    return fetchApcStatus()
      .then(s => setStatus(s))
      .catch(() => { /* 状态获取失败不阻塞主数据加载 */ })
  }, [])

  const load = useCallback(async (opts: { refresh?: boolean } = {}) => {
    setLoading(true)
    try {
      const [ov, op] = await Promise.all([
        fetchApcOverview({ minutes: windowMinutes, refresh: opts.refresh }),
        fetchApcOptimization({ minutes: windowMinutes, refresh: opts.refresh }),
      ])
      setOverview(ov)
      setOptimization(op)
      setUpdatedAt(Date.now())
      setError('')
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [windowMinutes])

  // 配置保存后：重新拉状态（数据源模式可能已从仿真切到真实库）并立即刷新数据
  const handleConfigSaved = useCallback(() => {
    loadStatus()
    load({ refresh: true })
  }, [loadStatus, load])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => { load() }, Math.max(10, intervalSec) * 1000)
    return () => clearInterval(id)
  }, [auto, intervalSec, load])

  const paramByCode = useMemo(() => {
    const map = new Map<string, ApcParamItem>()
    for (const p of overview?.params || []) map.set(p.code, p)
    return map
  }, [overview])

  const detailParam = detailCode ? paramByCode.get(detailCode) || null : null

  const grouped = useMemo(() => {
    const out: { process: string; items: ApcParamItem[] }[] = []
    for (const p of overview?.params || []) {
      let g = out.find(x => x.process === p.process)
      if (!g) { g = { process: p.process, items: [] }; out.push(g) }
      g.items.push(p)
    }
    return out
  }, [overview])

  const buildAdviceText = useCallback((): string => {
    if (!optimization) return ''
    const lines: string[] = []
    lines.push(`# APC / RTO 过程参数优化建议`)
    lines.push(`装置：${optimization.station}`)
    lines.push(`统计窗口：近 ${optimization.windowMinutes} 分钟 · 生成时间：${fmtTime(optimization.generatedAt)}`)
    lines.push(`数据源：${optimization.source.label}`)
    lines.push('')
    const actionable = optimization.items.filter(i => !i.recommendation.hold)
    if (actionable.length === 0) {
      lines.push('所有过程参数均在工艺死区内，建议维持当前设定值。')
    }
    actionable.forEach((it, i) => {
      const r = it.recommendation
      lines.push(`${i + 1}. ${it.name}（${it.code}｜${it.process}）—— ${URGENCY_META[r.urgency].label}`)
      lines.push(`   当前设定值 ${fmt(r.current, it.decimals)}${it.unit} → 建议值 ${fmt(r.suggested, it.decimals)}${it.unit}（${r.delta > 0 ? '+' : ''}${fmt(r.delta, it.decimals)}${it.unit}${r.deltaPct != null ? `，${r.deltaPct}%` : ''}）`)
      lines.push(`   置信度 ${r.confidence}%`)
      lines.push(`   理由：${r.reason}`)
      if (r.risk) lines.push(`   风险：${r.risk}`)
    })
    const holds = optimization.items.filter(i => i.recommendation.hold)
    if (holds.length > 0) {
      lines.push('')
      lines.push(`保持不动的参数：${holds.map(i => i.name).join('、')}`)
    }
    return lines.join('\n')
  }, [optimization])

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
    if (!optimization) return
    const head = ['工序', '参数名称', '参数编码', '单位', '当前设定值', '建议值', '调整量', '调整幅度%', '实测均值', '标准差', 'Cpk', '状态', '紧急度', '置信度', '推荐理由']
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`
    const rows = optimization.items.map(it => {
      const r = it.recommendation
      return [
        it.process, it.name, it.code, it.unit,
        fmt(r.current, it.decimals), fmt(r.suggested, it.decimals),
        fmt(r.delta, it.decimals), r.deltaPct == null ? '' : String(r.deltaPct),
        fmt(it.mean, it.decimals), fmt(it.std, it.decimals), it.cpk == null ? '' : String(it.cpk),
        STATUS_META[it.status].label, URGENCY_META[r.urgency].label, String(r.confidence), r.reason,
      ].map(v => esc(String(v))).join(',')
    })
    const csv = '\uFEFF' + [head.join(','), ...rows].join('\r\n')
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
  }, [optimization])

  const summary = optimization?.summary

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
              即时读取只读数据源中记录的过程数据列值，依据数据变化优化过程参数设定值，给出建议值。
              {overview ? ` · ${overview.station}` : ''}
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

            <button
              onClick={() => setConfigOpen(true)}
              title="配置只读数据库连接、取数 SQL 与过程参数"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              数据源配置
            </button>

            <button
              onClick={handleCopy}
              disabled={!optimization}
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
              disabled={!optimization}
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
                {overview?.source.label || '—'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-mes-textTertiary">只读模式</span>
              <span className="px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">仅 SELECT · 禁增删改</span>
            </div>
            {status?.hana && (
              <div className="flex items-center gap-2">
                <span className="text-mes-textTertiary">连接</span>
                <span className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${overview?.mode === 'hana' ? 'bg-mes-success' : 'bg-gray-300'}`} />
                  <span className="text-mes-textSecondary">
                    {overview?.mode === 'hana'
                      ? (status.hana.connected ? `已连接 ${status.hana.host}:${status.hana.port}` : '待连接（首次取数时建立）')
                      : '未启用（仿真源）'}
                  </span>
                </span>
              </div>
            )}
            {overview && (
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
          {overview?.source?.simulated && (
            <div className="mt-3 pt-3 border-t border-mes-border text-[11px] text-mes-textTertiary leading-relaxed">
              {overview.source.note}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setConfigOpen(true)}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-mes-primary text-white hover:bg-mes-primaryHover"
                >
                  配置只读数据库连接
                </button>
                <span>配置保存后立即生效，无需重启服务。</span>
              </div>
            </div>
          )}
          {status?.hana?.lastError && overview?.mode === 'hana' && (
            <div className="mt-3 pt-3 border-t border-mes-border text-[11px] text-red-600">
              最近一次数据源错误：{status.hana.lastError}
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

        {/* ===== 汇总指标 ===== */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-mes-border rounded-xl overflow-hidden border border-mes-border mb-4">
            <MetricCell label="过程参数" value={String(summary.total)} hint="纳入优化范围" />
            <MetricCell label="需调整" value={String(summary.actionable)} hint="超出工艺死区" tone={summary.actionable > 0 ? 'primary' : 'normal'} />
            <MetricCell label="高优先" value={String(summary.high)} hint="已触及单次限幅" tone={summary.high > 0 ? 'danger' : 'normal'} />
            <MetricCell label="异常参数" value={String(summary.danger)} hint="过程能力不足" tone={summary.danger > 0 ? 'danger' : 'normal'} />
            <MetricCell label="平均置信度" value={`${summary.avgConfidence}%`} hint="基于样本量与波动" />
          </div>
        )}

        {/* ===== 页签 ===== */}
        <div className="flex items-center gap-1 mb-3 border-b border-mes-border">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
            实时概览
            {overview ? <span className="ml-1 text-[11px] text-mes-textTertiary">{overview.params.length}</span> : null}
          </TabButton>
          <TabButton active={tab === 'optimize'} onClick={() => setTab('optimize')}>
            优化建议
            {summary && summary.actionable > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText font-medium">{summary.actionable}</span>
            )}
          </TabButton>
        </div>

        {/* ===== 内容 ===== */}
        {!overview && !error && (
          <div className="py-16 text-center text-sm text-mes-textTertiary">
            <div className="animate-pulse">正在读取过程数据…</div>
          </div>
        )}

        {overview && tab === 'overview' && (
          <div className="space-y-5">
            {grouped.map(g => (
              <section key={g.process}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-semibold text-mes-text">{g.process}工序</span>
                  <span className="text-[11px] text-mes-textTertiary">{g.items.length} 个过程参数</span>
                  <div className="flex-1 h-px bg-mes-border" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {g.items.map(p => (
                    <ParamCard key={p.code} param={p} onClick={() => setDetailCode(p.code)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {optimization && tab === 'optimize' && (
          <div className="space-y-3">
            {optimization.items.length === 0 && (
              <div className="py-16 text-center text-sm text-mes-textTertiary">窗口内没有可用的过程数据</div>
            )}
            {optimization.items.map(item => (
              <AdviceCard key={item.code} item={item} onOpenTrend={() => { setDetailCode(item.code); setTab('overview') }} />
            ))}
          </div>
        )}
      </div>

      {/* ===== 详情抽屉 ===== */}
      {detailParam && (
        <ParamDetail
          param={detailParam}
          windowMinutes={windowMinutes}
          onClose={() => setDetailCode(null)}
        />
      )}

      {/* ===== 数据源配置面板（数据库登录 / SQL 查询语句 / 参数配置）===== */}
      {configOpen && (
        <ApcConfigPanel
          onClose={() => setConfigOpen(false)}
          onSaved={handleConfigSaved}
        />
      )}
    </div>
  )
}

// ===== 子组件 =====

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-mes-textTertiary mt-0.5">{hint}</div>
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

function ParamCard({ param, onClick }: { param: ApcParamItem; onClick: () => void }) {
  const meta = STATUS_META[param.status]
  const r = param.recommendation
  return (
    <button
      onClick={onClick}
      className="text-left rounded-xl border border-mes-border bg-white p-3.5 hover:shadow-md hover:border-mes-primary/40 transition-all-smooth"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm">{OBJECTIVE_ICON[param.objective] || '🔧'}</span>
            <span className="text-sm font-medium text-mes-text truncate">{param.name}</span>
          </div>
          <div className="text-[10px] text-mes-textTertiary mt-0.5 truncate">{param.code} · 影响{param.objectiveLabel}</div>
        </div>
        <span
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium"
          style={{ color: meta.color, backgroundColor: meta.bg }}
        >
          {meta.label}
        </span>
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-[10px] text-mes-textTertiary">实测值（最新）</div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-bold" style={{ color: param.status === 'normal' ? '#1a1a1a' : meta.color }}>
              {fmt(param.latest, param.decimals)}
            </span>
            {param.unit && <span className="text-[11px] text-mes-textTertiary">{param.unit}</span>}
          </div>
          <div className="text-[10px] text-mes-textTertiary mt-0.5">
            均值 {fmt(param.mean, param.decimals)} · Cpk {param.cpk == null ? '—' : param.cpk}
            <span className="ml-1">{trendArrow(param.trend)}</span>
          </div>
        </div>
        <div className="w-[45%] shrink-0">
          <Sparkline points={param.series} color={meta.dot} />
        </div>
      </div>

      <div className="mt-2.5 pt-2.5 border-t border-mes-border flex items-center justify-between gap-2">
        <div className="text-[11px] text-mes-textSecondary">
          设定 {fmt(r.current, param.decimals)}
          <span className="mx-1 text-mes-textTertiary">→</span>
          <span className={r.hold ? 'text-mes-textSecondary' : 'text-mes-primary font-semibold'}>
            建议 {fmt(r.suggested, param.decimals)}
          </span>
        </div>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
          style={{ color: URGENCY_META[r.urgency].color, backgroundColor: URGENCY_META[r.urgency].bg }}
        >
          {URGENCY_META[r.urgency].label}
        </span>
      </div>
    </button>
  )
}

function AdviceCard({ item, onOpenTrend }: { item: ApcParamItem; onOpenTrend: () => void }) {
  const meta = STATUS_META[item.status]
  const r = item.recommendation
  const uMeta = URGENCY_META[r.urgency]
  const isUp = r.delta > 0
  const cColor = confidenceColor(r.confidence)

  return (
    <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-mes-border bg-gray-50/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm">{OBJECTIVE_ICON[item.objective] || '🔧'}</span>
          <span className="text-sm font-semibold text-mes-text truncate">{item.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-mes-border text-mes-textTertiary shrink-0">
            {item.process} · {item.code}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: meta.color, backgroundColor: meta.bg }}>
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: uMeta.color, backgroundColor: uMeta.bg }}>
            {uMeta.label}
          </span>
          <span className="flex items-center gap-1 text-[11px] text-mes-textSecondary">
            置信度
            <span className="font-semibold" style={{ color: cColor }}>{r.confidence}%</span>
          </span>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
          <div>
            <div className="text-[10px] text-mes-textTertiary mb-0.5">当前设定值</div>
            <div className="text-lg font-bold text-mes-textSecondary">
              {fmt(r.current, item.decimals)}
              {item.unit && <span className="text-[11px] font-normal ml-0.5">{item.unit}</span>}
            </div>
          </div>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center ${isUp ? 'bg-orange-50 text-orange-500' : r.hold ? 'bg-gray-100 text-gray-400' : 'bg-blue-50 text-blue-500'}`}>
            {r.hold
              ? <span className="text-xs">—</span>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  {isUp ? <polyline points="5 12 12 5 19 12" /> : <polyline points="19 12 12 19 5 12" />}
                  <line x1="12" y1="5" x2="12" y2="19" />
                </svg>}
          </div>
          <div>
            <div className="text-[10px] mb-0.5" style={{ color: r.hold ? '#999999' : '#4d6bfe' }}>
              {r.hold ? '建议保持' : '优化建议值'}
            </div>
            <div className="text-lg font-bold" style={{ color: r.hold ? '#6b6b6b' : '#4d6bfe' }}>
              {fmt(r.suggested, item.decimals)}
              {item.unit && <span className="text-[11px] font-normal ml-0.5">{item.unit}</span>}
            </div>
          </div>
          {!r.hold && (
            <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ backgroundColor: isUp ? '#fff7ed' : '#f0fdf4', color: isUp ? '#ea580c' : '#16a34a' }}>
              {isUp ? '↑' : '↓'} {Math.abs(r.delta).toFixed(item.decimals)}{item.unit}
              {r.deltaPct != null ? `（${Math.abs(r.deltaPct)}%）` : ''}
            </span>
          )}
          {r.clampedBy && !r.hold && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
              {r.clampedBy === 'step' ? '已触及单次调整限幅' : r.clampedBy === 'max' ? '受可调上限约束' : '受可调下限约束'}
            </span>
          )}
        </div>

        {/* 关键数据行 */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-mes-border rounded-lg overflow-hidden mb-3">
          <MiniStat label="RTO 理想点" value={fmt(item.optimalTarget, item.decimals)} />
          <MiniStat label="实测均值" value={fmt(item.mean, item.decimals)} />
          <MiniStat label="标准差 σ" value={fmt(item.std, item.decimals)} />
          <MiniStat label="Cpk" value={item.cpk == null ? '—' : String(item.cpk)} />
          <MiniStat label="规格范围" value={`${fmt(item.lsl, item.decimals)} ~ ${fmt(item.usl, item.decimals)}`} />
          <MiniStat label="样本点数" value={String(item.sampleCount)} />
        </div>

        <div className="bg-gray-50 rounded-lg p-2.5">
          <p className="text-xs text-mes-textSecondary leading-relaxed">
            <span className="font-medium text-mes-text">推荐理由：</span>{r.reason}
          </p>
          {r.risk && (
            <p className="text-xs text-amber-700 leading-relaxed mt-1.5">
              <span className="font-medium">风险提示：</span>{r.risk}
            </p>
          )}
          {!r.hold && r.predictedCpk != null && (
            <p className="text-xs text-mes-textTertiary leading-relaxed mt-1.5">
              预计调整后：均值 {fmt(r.predictedMean, item.decimals)}{item.unit}，Cpk {r.predictedCpk}
            </p>
          )}
        </div>

        <div className="flex justify-end mt-2">
          <button
            onClick={onOpenTrend}
            className="text-[11px] text-mes-primary hover:underline"
          >
            查看该参数趋势 →
          </button>
        </div>
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

function ParamDetail({
  param,
  windowMinutes,
  onClose,
}: {
  param: ApcParamItem
  windowMinutes: number
  onClose: () => void
}) {
  const [history, setHistory] = useState<ApcHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr('')
    fetchApcHistory(param.code, { minutes: windowMinutes })
      .then(h => { if (!cancelled) setHistory(h) })
      .catch(e => { if (!cancelled) setErr(e?.message || String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [param.code, windowMinutes])

  const r = param.recommendation
  const meta = STATUS_META[param.status]
  const points = history?.points || param.series

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-[860px] h-full bg-white shadow-2xl overflow-y-auto animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-mes-border px-5 py-3 flex items-center justify-between gap-3 z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm">{OBJECTIVE_ICON[param.objective] || '🔧'}</span>
              <h2 className="text-base font-semibold text-mes-text truncate">{param.name}</h2>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: meta.color, backgroundColor: meta.bg }}>
                {meta.label}
              </span>
            </div>
            <div className="text-[11px] text-mes-textTertiary mt-0.5">
              {param.process}工序 · {param.code} · 影响{param.objectiveLabel}
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
            <div className="text-xs text-mes-textTertiary animate-pulse">正在读取该参数的历史数据列值…</div>
          )}
          {err && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              读取失败：{err}（展示概览窗口数据）
            </div>
          )}

          <ApcTrendChart
            points={points}
            lsl={param.lsl}
            usl={param.usl}
            setpoint={param.setpoint}
            optimalTarget={param.optimalTarget}
            unit={param.unit}
            decimals={param.decimals}
            status={param.status}
            suggested={r.hold ? undefined : r.suggested}
            height={240}
          />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-mes-border rounded-xl overflow-hidden border border-mes-border">
            <MiniStat label="最新实测值" value={`${fmt(param.latest, param.decimals)}${param.unit ? ' ' + param.unit : ''}`} />
            <MiniStat label="窗口均值" value={`${fmt(param.mean, param.decimals)}${param.unit ? ' ' + param.unit : ''}`} />
            <MiniStat label="标准差 σ" value={fmt(param.std, param.decimals)} />
            <MiniStat label="过程能力 Cpk" value={param.cpk == null ? '—' : String(param.cpk)} />
            <MiniStat label="规格下限 LSL" value={fmt(param.lsl, param.decimals)} />
            <MiniStat label="规格上限 USL" value={fmt(param.usl, param.decimals)} />
            <MiniStat label="可调范围" value={`${fmt(param.min, param.decimals)} ~ ${fmt(param.max, param.decimals)}`} />
            <MiniStat label="单次调整上限" value={`±${param.maxStepPct}%`} />
          </div>

          <div className="rounded-xl border border-mes-border overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 border-b border-mes-border flex items-center justify-between">
              <span className="text-sm font-semibold text-mes-text">优化建议</span>
              <span className="text-[11px] text-mes-textTertiary">
                置信度 <span className="font-semibold" style={{ color: confidenceColor(r.confidence) }}>{r.confidence}%</span>
              </span>
            </div>
            <div className="px-4 py-3">
              <div className="flex items-center gap-3 flex-wrap mb-3">
                <span className="text-xs text-mes-textTertiary">当前设定值</span>
                <span className="text-base font-bold text-mes-textSecondary">{fmt(r.current, param.decimals)}{param.unit}</span>
                <span className="text-mes-textTertiary">→</span>
                <span className="text-xs" style={{ color: r.hold ? '#999999' : '#4d6bfe' }}>
                  {r.hold ? '建议保持' : '优化建议值'}
                </span>
                <span className="text-base font-bold" style={{ color: r.hold ? '#6b6b6b' : '#4d6bfe' }}>
                  {fmt(r.suggested, param.decimals)}{param.unit}
                </span>
                {!r.hold && r.deltaPct != null && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText">
                    {r.delta > 0 ? '+' : ''}{r.deltaPct}%
                  </span>
                )}
              </div>
              <p className="text-xs text-mes-textSecondary leading-relaxed">{r.reason}</p>
              {r.risk && <p className="text-xs text-amber-700 leading-relaxed mt-2">{r.risk}</p>}
            </div>
          </div>

          <div className="rounded-xl bg-gray-50 px-4 py-3 text-[11px] text-mes-textTertiary leading-relaxed">
            说明：本页所有过程数据均来自只读数据源的 SELECT 查询，不做任何写库操作；
            设定值建议仅在页面展示，不会自动下发到 DCS/PLC，需由工艺工程师确认后手动执行。
            窗口内共 {param.sampleCount} 个采样点，采样间隔 {history ? Math.round((history.points.length > 1 ? (history.points[history.points.length - 1].t - history.points[0].t) / (history.points.length - 1) : 0) / 1000) : '—'} 秒。
          </div>
        </div>
      </div>
    </div>
  )
}
