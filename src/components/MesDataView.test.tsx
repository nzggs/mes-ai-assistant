import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MesDataView } from './MesDataView'

const data = {
  title: 'A线今日生产数据',
  queryTime: '2026-08-14 10:00',
  items: [
    { label: 'OEE', value: '85.7', unit: '%', status: 'normal' as const, trend: 'up' as const, trendValue: '+1.8%' },
    { label: '良率', value: '96.8', unit: '%', status: 'warning' as const },
    { label: '设备温度', value: '78', unit: '℃', status: 'danger' as const, trend: 'down' as const, trendValue: '-2' },
  ],
}

describe('MesDataView', () => {
  it('渲染标题、查询时间与数据项', () => {
    render(<MesDataView data={data} />)
    expect(screen.getByText('A线今日生产数据')).toBeInTheDocument()
    expect(screen.getByText(/2026-08-14 10:00/)).toBeInTheDocument()
    expect(screen.getByText('OEE')).toBeInTheDocument()
    expect(screen.getByText('85.7')).toBeInTheDocument()
  })
  it('渲染状态标签', () => {
    render(<MesDataView data={data} />)
    expect(screen.getByText('正常')).toBeInTheDocument()
    expect(screen.getByText('预警')).toBeInTheDocument()
    expect(screen.getByText('异常')).toBeInTheDocument()
  })
  it('渲染底部数据来源提示', () => {
    render(<MesDataView data={data} />)
    expect(screen.getByText(/MES 系统实时查询/)).toBeInTheDocument()
  })
})
