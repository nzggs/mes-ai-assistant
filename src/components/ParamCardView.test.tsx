import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ParamCardView } from './ParamCardView'

const params = [
  { category: 'process' as const, paramName: '充电倍率', currentValue: '0.5', recommendedValue: '0.8', unit: 'C', confidence: 90, reason: '提升效率', historicalRef: 'B021批次' },
  { category: 'quality' as const, paramName: '内阻', currentValue: '35', recommendedValue: '28', unit: 'mΩ', confidence: 60, reason: '降低内阻' },
]

describe('ParamCardView', () => {
  it('渲染参数调优建议标题', () => {
    render(<ParamCardView params={params} />)
    expect(screen.getByText('参数调优建议')).toBeInTheDocument()
  })
  it('渲染参数名与类别标签', () => {
    render(<ParamCardView params={params} />)
    expect(screen.getByText('充电倍率')).toBeInTheDocument()
    expect(screen.getByText('过程参数')).toBeInTheDocument()
    expect(screen.getByText('内阻')).toBeInTheDocument()
    expect(screen.getByText('质量标准')).toBeInTheDocument()
  })
  it('渲染推荐理由', () => {
    render(<ParamCardView params={params} />)
    expect(screen.getByText(/提升效率/)).toBeInTheDocument()
  })
  it('渲染历史参考', () => {
    render(<ParamCardView params={params} />)
    expect(screen.getByText(/B021批次/)).toBeInTheDocument()
  })
})
