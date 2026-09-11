// 过程参数历史趋势图（零依赖 SVG 折线）
//
// 展示内容：规格上下限带（LSL/USL）、当前设定值、RTO 理想操作点、实测数据列值曲线。
// 用于「APC 和 RTO」页面，让「数据在变、设定值该往哪调」一目了然。

import { useMemo, useState } from 'react'
import type { ApcParamStatus, ApcSeriesPoint } from '../types'

interface ApcTrendChartProps {
  points: ApcSeriesPoint[]
  lsl: number
  usl: number
  setpoint: number
  optimalTarget: number
  unit: string
  decimals: number
  status: ApcParamStatus
  height?: number
  /** 当前建议值（存在时绘制一条虚线参考） */
  suggested?: number
}

const W = 720
const PAD = { l: 58, r: 18, t: 16, b: 26 }

const STATUS_COLOR: Record<ApcParamStatus, string> = {
  normal: '#16a34a',
  warning: '#f59e0b',
  danger: '#ef4444',
  unknown: '#94a3b8',
}

function fmt(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '—'
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
}: ApcTrendChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  const H = height
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b

  const geo = useMemo(() => {
    const values = points.map(p => p.v).filter(v => Number.isFinite(v))
    const refs = [lsl, usl, setpoint, optimalTarget]
    if (values.length === 0) {
      const lo = Math.min(...refs)
      const hi = Math.max(...refs)
      return { lo: lo - (hi - lo || 1) * 0.2, hi: hi + (hi - lo || 1) * 0.2, t0: 0, t1: 1 }
    }
    let lo = Math.min(...values, ...refs)
    let hi = Math.max(...values, ...refs)
    const span = hi - lo || Math.abs(hi) * 0.02 || 1
    lo -= span * 0.12
    hi += span * 0.12
    const t0 = points[0]?.t ?? 0
    const t1 = points[points.length - 1]?.t ?? t0 + 1
    return { lo, hi, t0, t1: t1 > t0 ? t1 : t0 + 1 }
  }, [points, lsl, usl, setpoint, optimalTarget])

  const xOf = (t: number) => PAD.l + ((t - geo.t0) / (geo.t1 - geo.t0)) * innerW
  const yOf = (v: number) => PAD.t + innerH - ((v - geo.lo) / (geo.hi - geo.lo)) * innerH

  const linePath = useMemo(() => {
    if (points.length === 0) return ''
    return points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.t).toFixed(2)},${yOf(p.v).toFixed(2)}`)
      .join(' ')
  }, [points, geo])

  const areaPath = useMemo(() => {
    if (points.length === 0) return ''
    const first = points[0]
    const last = points[points.length - 1]
    return `${linePath} L${xOf(last.t).toFixed(2)},${(PAD.t + innerH).toFixed(2)} L${xOf(first.t).toFixed(2)},${(PAD.t + innerH).toFixed(2)} Z`
  }, [points, linePath, geo])

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
  const inSpec = usl > lsl
  const bandY1 = yOf(usl)
  const bandY2 = yOf(lsl)

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="过程参数历史趋势"
      >
        <defs>
          <linearGradient id="apcAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* 规格带 */}
        {inSpec && bandY2 > bandY1 && (
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

        {/* LSL / USL */}
        {inSpec && (
          <>
            <line x1={PAD.l} y1={bandY1} x2={PAD.l + innerW} y2={bandY1} stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" opacity="0.65" />
            <line x1={PAD.l} y1={bandY2} x2={PAD.l + innerW} y2={bandY2} stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" opacity="0.65" />
            <text x={PAD.l + innerW - 2} y={bandY1 - 4} textAnchor="end" fontSize="9" fill="#ef4444" opacity="0.85">USL {fmt(usl, decimals)}</text>
            <text x={PAD.l + innerW - 2} y={bandY2 + 11} textAnchor="end" fontSize="9" fill="#ef4444" opacity="0.85">LSL {fmt(lsl, decimals)}</text>
          </>
        )}

        {/* 当前设定值 */}
        <line x1={PAD.l} y1={yOf(setpoint)} x2={PAD.l + innerW} y2={yOf(setpoint)} stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="6 4" />
        <text x={PAD.l + 4} y={yOf(setpoint) - 4} fontSize="9" fill="#64748b">设定值 {fmt(setpoint, decimals)}</text>

        {/* RTO 理想操作点 */}
        <line x1={PAD.l} y1={yOf(optimalTarget)} x2={PAD.l + innerW} y2={yOf(optimalTarget)} stroke="#8b5cf6" strokeWidth="1.2" strokeDasharray="2 3" />
        <text x={PAD.l + 4} y={yOf(optimalTarget) + 11} fontSize="9" fill="#8b5cf6">RTO 理想点 {fmt(optimalTarget, decimals)}</text>

        {/* 建议值（若与当前不同） */}
        {typeof suggested === 'number' && Math.abs(suggested - setpoint) > 1e-9 && (
          <>
            <line x1={PAD.l} y1={yOf(suggested)} x2={PAD.l + innerW} y2={yOf(suggested)} stroke="#4d6bfe" strokeWidth="1.2" strokeDasharray="1 3" />
            <text x={PAD.l + innerW - 2} y={yOf(suggested) - 4} textAnchor="end" fontSize="9" fill="#4d6bfe">建议 {fmt(suggested, decimals)}</text>
          </>
        )}

        {/* 曲线 */}
        {points.length > 1 && (
          <>
            <path d={areaPath} fill="url(#apcAreaFill)" />
            <path d={linePath} fill="none" stroke={lineColor} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {points.length === 1 && (
          <circle cx={xOf(points[0].t)} cy={yOf(points[0].v)} r="3" fill={lineColor} />
        )}

        {/* 悬停十字线 */}
        {hoverPoint && (
          <>
            <line x1={xOf(hoverPoint.t)} y1={PAD.t} x2={xOf(hoverPoint.t)} y2={PAD.t + innerH} stroke="#c7c7c7" strokeWidth="1" />
            <circle cx={xOf(hoverPoint.t)} cy={yOf(hoverPoint.v)} r="4" fill="#ffffff" stroke={lineColor} strokeWidth="2" />
          </>
        )}

        {/* x 轴时间 */}
        {points.length > 1 && (
          <>
            <text x={PAD.l} y={H - 8} fontSize="10" fill="#999999">{fmtTime(points[0].t)}</text>
            <text x={PAD.l + innerW / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#999999">
              {fmtTime(points[Math.floor(points.length / 2)].t)}
            </text>
            <text x={PAD.l + innerW} y={H - 8} textAnchor="end" fontSize="10" fill="#999999">
              {fmtTime(points[points.length - 1].t)}
            </text>
          </>
        )}
      </svg>

      {/* 悬停读数 */}
      {hoverPoint && (
        <div
          className="pointer-events-none absolute top-0 px-2 py-1 rounded-md bg-mes-text/85 text-white text-[11px] leading-tight whitespace-nowrap"
          style={{ left: `${(xOf(hoverPoint.t) / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <div>{fmtTime(hoverPoint.t)}</div>
          <div className="font-semibold">{fmt(hoverPoint.v, decimals)}{unit ? ` ${unit}` : ''}</div>
        </div>
      )}
    </div>
  )
}
