// 趋势图横轴口径的回归测试。
//
// 背景：宽表取数曾经漏掉时间戳列，导致整窗口的点共享同一个 Date.now()。
// 那时若仍按时间铺点，所有点会挤在同一个横坐标上，曲线被压成一条直线（现场故障表现）。
// 现在时间戳不可用时自动退化为按采样点序号铺开，并在图上方注明口径。
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApcTrendChart } from './ApcTrendChart'

const BASE = {
  lsl: 24.5,
  usl: 25.5,
  setpoint: 25,
  optimalTarget: 25,
  unit: 'g',
  decimals: 2,
  status: 'warning' as const,
}

/** 时间戳全部相同的点集（模拟时间列未取到） */
const sameTs = (n: number) => Array.from({ length: n }, (_, i) => ({ t: 1789450578823, v: 24.9 + i * 0.01 }))
/** 时间戳正常递增的点集（每 60 秒一个） */
const okTs = (n: number) => Array.from({ length: n }, (_, i) => ({ t: 1789450578000 + i * 60000, v: 24.9 + i * 0.01 }))

describe('ApcTrendChart · 横轴口径', () => {
  it('时间戳全部相同时自动退化为「按序号」并给出提示', () => {
    render(<ApcTrendChart {...BASE} points={sameTs(6)} />)
    expect(screen.getByText(/时间列未取到/)).toBeInTheDocument()
    expect(screen.getByText('第 1 个采样点')).toBeInTheDocument()
    expect(screen.getByText('第 6 个采样点')).toBeInTheDocument()
  })

  it('时间戳正常时按时间显示，不出现降级提示', () => {
    render(<ApcTrendChart {...BASE} points={okTs(6)} />)
    expect(screen.queryByText(/时间列未取到/)).not.toBeInTheDocument()
    expect(screen.queryByText('第 1 个采样点')).not.toBeInTheDocument()
  })

  it('强制 axisMode="index" 时忽略时间戳，一律按序号显示', () => {
    render(<ApcTrendChart {...BASE} points={okTs(6)} axisMode="index" />)
    expect(screen.getByText('第 1 个采样点')).toBeInTheDocument()
    // 强制序号不属于「自动降级」，不应展示告警文案
    expect(screen.queryByText(/时间列未取到/)).not.toBeInTheDocument()
  })

  it('强制 axisMode="time" 时即使时间戳重复也不降级（由使用者自行承担）', () => {
    render(<ApcTrendChart {...BASE} points={sameTs(6)} axisMode="time" />)
    expect(screen.queryByText(/时间列未取到/)).not.toBeInTheDocument()
    expect(screen.queryByText('第 1 个采样点')).not.toBeInTheDocument()
  })

  it('单点也能落在画布内（序号口径居中，不再贴左边缘）', () => {
    const { container } = render(<ApcTrendChart {...BASE} points={sameTs(1)} />)
    const circle = container.querySelector('circle')
    expect(circle).not.toBeNull()
    const cx = Number(circle!.getAttribute('cx'))
    // PAD.l=58，innerW=720-58-18=644，居中 → 58+322=380
    expect(cx).toBeGreaterThan(58)
    expect(cx).toBeLessThan(702)
  })

  it('无数据点时只渲染参考线，不抛错', () => {
    render(<ApcTrendChart {...BASE} points={[]} />)
    expect(screen.getByRole('img', { name: '过程参数历史趋势' })).toBeInTheDocument()
  })
})
