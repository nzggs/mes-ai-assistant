// 过程参数历史趋势图（零依赖 SVG 折线）
//
// 展示内容：规格上下限带（LSL/USL）、当前设定值、RTO 理想操作点、实测数据列值曲线。
// 用于「APC 和 RTO」页面，让「数据在变、设定值该往哪调」一目了然。

import { useId, useMemo, useState } from 'react'
import type { ApcParamStatus, ApcSeriesPoint } from '../types'

interface ApcTrendChartProps {
  points: ApcSeriesPoint[]
  /** 规格上下限。规格写成列名表达式且取不到值时为空——此时不画规格线，也不参与纵轴缩放 */
  lsl: number | null
  usl: number | null
  setpoint: number | null
  optimalTarget: number | null
  unit: string
  decimals: number
  status: ApcParamStatus
  height?: number
  /** 当前建议值（存在时绘制一条虚线参考） */
  suggested?: number
  /**
   * 横轴口径：auto=时间戳可用时按时间、否则按采样点序号（默认）；
   * time=强制按时间；index=强制按序号等距铺开。
   */
  axisMode?: 'auto' | 'time' | 'index'
  /** 三条参考线的文案（输出结果用默认值；参与参数曲线改成「当前工作点 / 建议值」更贴切） */
  setpointLabel?: string
  targetLabel?: string
  suggestedLabel?: string
}

const W = 720
const PAD = { l: 58, r: 18, t: 16, b: 26 }

const STATUS_COLOR: Record<ApcParamStatus, string> = {
  normal: '#16a34a',
  warning: '#f59e0b',
  danger: '#ef4444',
  unknown: '#94a3b8',
}

function fmt(v: number | null | undefined, decimals: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(decimals)
}

function fmtTime(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ApcTrendChart({
  points,
  lsl,
  usl,
  setpoint,
  optimalTarget,
  unit,
  decimals,
  status,
  height = 200,
  suggested,
  axisMode = 'auto',
  setpointLabel = '设定值',
  targetLabel = 'RTO 理想点',
  suggestedLabel = '建议',
}: ApcTrendChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  // 渐变 id 必须每个实例唯一：同页出现多张趋势图时，写死的 id 会让后一张的定义
  // 覆盖前一张，所有曲线共用同一种填充色（图一多就串色），useId 天然隔离。
  const gradId = `apcAreaFill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const H = height
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  // 有效时间戳（有限且互不相同）不足 2 个时，若仍按时间铺点，所有点会挤在同一个横坐标上，
  // 整条曲线被压成一条竖线。此时退化为「按采样点序号等距铺开」：形状仍可读，
  // 并在图上方注明口径，避免看图的人把序号当成时间。
  const usableTimeCount = useMemo(() => {
    const set = new Set<number>()
    for (const p of points) if (Number.isFinite(p.t)) set.add(p.t)
    return set.size
  }, [points])
  const byIndex = axisMode === 'index' || (axisMode === 'auto' && usableTimeCount < 2)
  const degradedToIndex = byIndex && axisMode === 'auto'

  // 规格写成列名表达式时，每个点带各自数据行解析出的 lsl/usl（阶梯规格带）；
  // 固定数字规格则没有逐点值，用参数级 lsl/usl 画一条横线即可。
  const hasPointSpec = useMemo(
    () => points.some(p => Number.isFinite(p.lsl) || Number.isFinite(p.usl)),
    [points]
  )

  const geo = useMemo(() => {
    const values = points.map(p => p.v).filter(v => Number.isFinite(v))
    // 规格可能是 null（表达式取不到值）→ 必须剔除。否则 Math.min/max 会把 null 当 0
    // 参与缩放，曲线会被压成贴着顶端的一条线。
    const refs = [lsl, usl, setpoint, optimalTarget].filter((v): v is number => Number.isFinite(v as number))
    const bandVals: number[] = []
    for (const p of points) {
      if (Number.isFinite(p.lsl)) bandVals.push(p.lsl as number)
      if (Number.isFinite(p.usl)) bandVals.push(p.usl as number)
    }
    const t0 = points[0]?.t ?? 0
    const t1 = points[points.length - 1]?.t ?? t0 + 1
    const span0 = { t0, t1: t1 > t0 ? t1 : t0 + 1 }
    if (values.length === 0) {
      const pool = [...refs, ...bandVals]
      if (pool.length === 0) return { lo: 0, hi: 1, ...span0 }
      const lo = Math.min(...pool)
      const hi = Math.max(...pool)
      return { lo: lo - (hi - lo || 1) * 0.2, hi: hi + (hi - lo || 1) * 0.2, ...span0 }
    }
    let lo = Math.min(...values, ...refs, ...bandVals)
    let hi = Math.max(...values, ...refs, ...bandVals)
    const span = hi - lo || Math.abs(hi) * 0.02 || 1
    lo -= span * 0.12
    hi += span * 0.12
    return { lo, hi, ...span0 }
  }, [points, lsl, usl, setpoint, optimalTarget])

  const yOf = (v: number) => PAD.t + innerH - ((v - geo.lo) / (geo.hi - geo.lo)) * innerH

  /** 每个点的横坐标：序号口径等距铺开；时间口径按真实时间戳插值 */
  const xs = useMemo(() => {
    const n = points.length
    if (byIndex) {
      return points.map((_, i) => (n <= 1 ? PAD.l + innerW / 2 : PAD.l + (i / (n - 1)) * innerW))
    }
    return points.map(p => PAD.l + ((p.t - geo.t0) / (geo.t1 - geo.t0)) * innerW)
  }, [points, geo.t0, geo.t1, byIndex, innerW])

  /**
   * 阶梯规格带：逐点规格（列名表达式）时，规格不再是一条水平线而是一条随行变化的折线。
   * 缺某个点的规格时回落到参数级数值，保证带子不断开。
   */
  const steppedBand = useMemo(() => {
    if (!hasPointSpec || points.length < 2) return null
    const uslAt = (p: ApcSeriesPoint) =>
      Number.isFinite(p.usl) ? (p.usl as number) : (Number.isFinite(usl as number) ? (usl as number) : null)
    const lslAt = (p: ApcSeriesPoint) =>
      Number.isFinite(p.lsl) ? (p.lsl as number) : (Number.isFinite(lsl as number) ? (lsl as number) : null)
    const uslSeg: string[] = []
    const lslSeg: string[] = []
    for (let i = 0; i < points.length; i++) {
      const u = uslAt(points[i])
      const l = lslAt(points[i])
      if (u != null) uslSeg.push(`${uslSeg.length === 0 ? 'M' : 'L'}${xs[i].toFixed(2)},${yOf(u).toFixed(2)}`)
      if (l != null) lslSeg.push(`${lslSeg.length === 0 ? 'M' : 'L'}${xs[i].toFixed(2)},${yOf(l).toFixed(2)}`)
    }
    if (uslSeg.length < 2 && lslSeg.length < 2) return null
    const fill = uslSeg.length >= 2 && lslSeg.length >= 2
      ? `${uslSeg.join(' ')} ${[...lslSeg].reverse().map(s => `L${s.slice(1)}`).join(' ')} Z`
      : ''
    return { uslPath: uslSeg.join(' '), lslPath: lslSeg.join(' '), fill }
  }, [points, xs, geo, hasPointSpec, lsl, usl])

  const linePath = useMemo(() => {
    if (points.length === 0) return ''
    return points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(2)},${yOf(p.v).toFixed(2)}`)
      .join(' ')
  }, [points, xs, geo])

  const areaPath = useMemo(() => {
    if (points.length === 0) return ''
    const bottom = (PAD.t + innerH).toFixed(2)
    return `${linePath} L${xs[xs.length - 1].toFixed(2)},${bottom} L${xs[0].toFixed(2)},${bottom} Z`
  }, [points, linePath, xs, geo])

  const gridLines = useMemo(() => {
    const out: { v: number; y: number }[] = []
    for (let i = 0; i <= 4; i++) {
      const v = geo.lo + ((geo.hi - geo.lo) * i) / 4
      out.push({ v, y: yOf(v) })
    }
    return out
  }, [geo])

  const lineColor = STATUS_COLOR[status] ?? STATUS_COLOR.unknown

  // 悬停命中最近数据点
  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    if (points.length === 0) return
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0) return
    const relX = ((e.clientX - rect.left) / rect.width) * W
    const ratio = (relX - PAD.l) / innerW
    const idx = Math.round(ratio * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, idx)))
  }

  const hoverPoint = hover != null ? points[hover] : null
  const flatLsl = Number.isFinite(lsl as number) ? (lsl as number) : null
  const flatUsl = Number.isFinite(usl as number) ? (usl as number) : null
  const flatSetpoint = Number.isFinite(setpoint as number) ? (setpoint as number) : null
  const flatTarget = Number.isFinite(optimalTarget as number) ? (optimalTarget as number) : null
  const inSpec = flatLsl != null && flatUsl != null && flatUsl > flatLsl
  const bandY1 = flatUsl != null ? yOf(flatUsl) : 0
  const bandY2 = flatLsl != null ? yOf(flatLsl) : 0

  return (
    <div className="relative">
      {degradedToIndex && (
        <div className="mb-1.5 text-[10px] text-amber-700">
          时间列未取到，横轴按采样点序号显示（顺序即数据返回顺序，不代表等时间间隔）
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="过程参数历史趋势"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* 规格带（固定数字规格 → 水平带；列名表达式规格 → 阶梯带，见下方 LSL/USL） */}
        {!steppedBand && inSpec && bandY2 > bandY1 && (
          <rect
            x={PAD.l}
            y={bandY1}
            width={innerW}
            height={bandY2 - bandY1}
            fill="#22c55e"
            opacity="0.07"
          />
        )}

        {/* 网格 + y 轴刻度 */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              y1={g.y}
              x2={PAD.l + innerW}
              y2={g.y}
              stroke="#e5e5e5"
              strokeWidth="1"
            />
            <text
              x={PAD.l - 8}
              y={g.y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="#999999"
            >
              {fmt(g.v, decimals)}
            </text>
          </g>
        ))}

        {/* LSL / USL：固定数字画横线；列名表达式按点画阶梯折线 */}
        {steppedBand && (
          <>
            {steppedBand.fill && <path d={steppedBand.fill} fill="#22c55e" opacity="0.07" />}
            <path d={steppedBand.uslPath} fill="none" stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" opacity="0.65" />
            <path d={steppedBand.lslPath} fill="none" stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" opacity="0.65" />
            {flatUsl != null && (
              <text x={PAD.l + innerW - 2} y={bandY1 - 4} textAnchor="end" fontSize="9" fill="#ef4444" opacity="0.85">USL {fmt(flatUsl, decimals)}</text>
            )}
            {flatLsl != null && (
              <text x={PAD.l + innerW - 2} y={bandY2 + 11} textAnchor="end" fontSize="9" fill="#ef4444" opacity="0.85">LSL {fmt(flatLsl, decimals)}</text>
            )}
          </>
        )}
        {!steppedBand && inSpec && (
          <>
            <line x1={PAD.l} y1={bandY1} x2={PAD.l + innerW} y2={bandY1} stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" opacity="0.65" />
            <line x1={PAD.l} y1={bandY2} x2={PAD.l + innerW} y2={bandY2} stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" opacity="0.65" />
            <text x={PAD.l + innerW - 2} y={bandY1 - 4} textAnchor="end" fontSize="9" fill="#ef4444" opacity="0.85">USL {fmt(flatUsl, decimals)}</text>
            <text x={PAD.l + innerW - 2} y={bandY2 + 11} textAnchor="end" fontSize="9" fill="#ef4444" opacity="0.85">LSL {fmt(flatLsl, decimals)}</text>
          </>
        )}

        {/* 当前设定值（规格取不到时为空 → 不画） */}
        {flatSetpoint != null && (
          <>
            <line x1={PAD.l} y1={yOf(flatSetpoint)} x2={PAD.l + innerW} y2={yOf(flatSetpoint)} stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="6 4" />
            <text x={PAD.l + 4} y={yOf(flatSetpoint) - 4} fontSize="9" fill="#64748b">{setpointLabel} {fmt(flatSetpoint, decimals)}</text>
          </>
        )}

        {/* RTO 理想操作点 */}
        {flatTarget != null && (
          <>
            <line x1={PAD.l} y1={yOf(flatTarget)} x2={PAD.l + innerW} y2={yOf(flatTarget)} stroke="#8b5cf6" strokeWidth="1.2" strokeDasharray="2 3" />
            <text x={PAD.l + 4} y={yOf(flatTarget) + 11} fontSize="9" fill="#8b5cf6">{targetLabel} {fmt(flatTarget, decimals)}</text>
          </>
        )}

        {/* 建议值（若与当前不同） */}
        {typeof suggested === 'number' && flatSetpoint != null && Math.abs(suggested - flatSetpoint) > 1e-9 && (
          <>
            <line x1={PAD.l} y1={yOf(suggested)} x2={PAD.l + innerW} y2={yOf(suggested)} stroke="#4d6bfe" strokeWidth="1.2" strokeDasharray="1 3" />
            <text x={PAD.l + innerW - 2} y={yOf(suggested) - 4} textAnchor="end" fontSize="9" fill="#4d6bfe">{suggestedLabel} {fmt(suggested, decimals)}</text>
          </>
        )}

        {/* 曲线 */}
        {points.length > 1 && (
          <>
            <path d={areaPath} fill={`url(#${gradId})`} />
            <path d={linePath} fill="none" stroke={lineColor} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {points.length === 1 && (
          <circle cx={xs[0]} cy={yOf(points[0].v)} r="3" fill={lineColor} />
        )}

        {/* 偏离点高亮：规格写成列名表达式时逐点判定，超限点标红（固定规格由曲线颜色/状态反映） */}
        {points.map((p, i) =>
          (p.direction === 'high' || p.direction === 'low') ? (
            <circle key={`dev-${i}`} cx={xs[i]} cy={yOf(p.v)} r="2.6" fill="#ef4444" />
          ) : null
        )}

        {/* 悬停十字线 */}
        {hoverPoint && (
          <>
            <line x1={xs[hover as number]} y1={PAD.t} x2={xs[hover as number]} y2={PAD.t + innerH} stroke="#c7c7c7" strokeWidth="1" />
            <circle cx={xs[hover as number]} cy={yOf(hoverPoint.v)} r="4" fill="#ffffff" stroke={lineColor} strokeWidth="2" />
          </>
        )}

        {/* x 轴刻度 */}
        {points.length > 1 && (
          <>
            <text x={PAD.l} y={H - 8} fontSize="10" fill="#999999">
              {byIndex ? '第 1 个采样点' : fmtTime(points[0].t)}
            </text>
            <text x={PAD.l + innerW / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#999999">
              {byIndex ? `第 ${Math.floor(points.length / 2) + 1} 个采样点` : fmtTime(points[Math.floor(points.length / 2)].t)}
            </text>
            <text x={PAD.l + innerW} y={H - 8} textAnchor="end" fontSize="10" fill="#999999">
              {byIndex ? `第 ${points.length} 个采样点` : fmtTime(points[points.length - 1].t)}
            </text>
          </>
        )}
      </svg>

      {/* 悬停读数 */}
      {hoverPoint && (
        <div
          className="pointer-events-none absolute top-0 px-2 py-1 rounded-md bg-mes-text/85 text-white text-[11px] leading-tight whitespace-nowrap"
          style={{ left: `${(xs[hover as number] / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <div>{byIndex ? `第 ${(hover as number) + 1} 个采样点` : fmtTime(hoverPoint.t)}</div>
          <div className="font-semibold">{fmt(hoverPoint.v, decimals)}{unit ? ` ${unit}` : ''}</div>
        </div>
      )}
    </div>
  )
}
