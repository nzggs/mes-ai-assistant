import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MesDataPanel } from './MesDataPanel'

describe('MesDataPanel', () => {
  it('渲染标题与产线概览', () => {
    render(<MesDataPanel />)
    expect(screen.getByText('MES 数据概览')).toBeInTheDocument()
    expect(screen.getByText('产线概览')).toBeInTheDocument()
    expect(screen.getByText('设备状态')).toBeInTheDocument()
  })
  it('渲染产线名称', () => {
    render(<MesDataPanel />)
    expect(screen.getByText('A线')).toBeInTheDocument()
    expect(screen.getByText('B线')).toBeInTheDocument()
    expect(screen.getByText('C线')).toBeInTheDocument()
  })
  it('渲染设备状态', () => {
    render(<MesDataPanel />)
    expect(screen.getByText('卷绕机')).toBeInTheDocument()
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0)
    expect(screen.getByText('空闲')).toBeInTheDocument()
    expect(screen.getByText('故障')).toBeInTheDocument()
  })
  it('渲染底部数据来源提示', () => {
    render(<MesDataPanel />)
    expect(screen.getByText(/MES 系统实时数据库/)).toBeInTheDocument()
  })
})
