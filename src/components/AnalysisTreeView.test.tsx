import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnalysisTreeView } from './AnalysisTreeView'
import type { AnalysisTreeNode } from '../types'

const tree: AnalysisTreeNode = {
  id: 'root',
  type: 'problem',
  label: '电芯胀气',
  description: '批量胀气问题',
  confidence: 88,
  status: 'confirmed',
  source: 'MES数据',
  children: [
    { id: 'c1', type: 'cause', label: '水分超标', confidence: 85, status: 'suspected', children: [
      { id: 'rc1', type: 'rootCause', label: '露点超标', confidence: 92, status: 'confirmed' },
    ] },
    { id: 'c2', type: 'solution', label: '检修除湿机', status: 'eliminated' },
  ],
}

describe('AnalysisTreeView', () => {
  it('渲染决策树标题与根节点', () => {
    render(<AnalysisTreeView tree={tree} />)
    expect(screen.getByText('异常分析决策树')).toBeInTheDocument()
    expect(screen.getByText('电芯胀气')).toBeInTheDocument()
  })
  it('渲染节点类型标签与状态', () => {
    render(<AnalysisTreeView tree={tree} />)
    expect(screen.getByText(/⚠️ 问题/)).toBeInTheDocument()
    expect(screen.getByText(/🔍 可能原因/)).toBeInTheDocument()
    expect(screen.getByText(/🎯 根因/)).toBeInTheDocument()
    expect(screen.getAllByText('已确认').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('疑似')).toBeInTheDocument()
    expect(screen.getByText('已排除')).toBeInTheDocument()
  })
  it('渲染置信度与来源', () => {
    render(<AnalysisTreeView tree={tree} />)
    expect(screen.getByText(/置信度 88%/)).toBeInTheDocument()
    expect(screen.getByText(/来源：MES数据/)).toBeInTheDocument()
  })
  it('展开子节点，点击折叠后隐藏子节点', () => {
    render(<AnalysisTreeView tree={tree} />)
    expect(screen.getByText('水分超标')).toBeInTheDocument()
    // 点击根节点折叠按钮
    const btns = screen.getAllByRole('button')
    fireEvent.click(btns[0])
    expect(screen.queryByText('水分超标')).not.toBeInTheDocument()
  })
})
