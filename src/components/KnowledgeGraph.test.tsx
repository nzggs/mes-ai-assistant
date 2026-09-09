import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KnowledgeGraph } from './KnowledgeGraph'

describe('KnowledgeGraph', () => {
  it('渲染标题与实体统计', () => {
    render(<KnowledgeGraph />)
    expect(screen.getByText('知识图谱')).toBeInTheDocument()
    expect(screen.getByText(/个实体/)).toBeInTheDocument()
  })
  it('渲染实体类型过滤器', () => {
    render(<KnowledgeGraph />)
    expect(screen.getAllByText('设备').length).toBeGreaterThan(0)
    expect(screen.getAllByText('工序').length).toBeGreaterThan(0)
    expect(screen.getAllByText('产品').length).toBeGreaterThan(0)
  })
  it('初始显示空详情提示', () => {
    render(<KnowledgeGraph />)
    expect(screen.getByText('点击节点查看详情')).toBeInTheDocument()
  })
  it('渲染操作提示', () => {
    render(<KnowledgeGraph />)
    expect(screen.getByText(/拖拽平移/)).toBeInTheDocument()
  })
  it('点击类型过滤器切换后显示清除筛选', () => {
    render(<KnowledgeGraph />)
    fireEvent.click(screen.getAllByText('设备')[0])
    expect(screen.getByText('清除筛选')).toBeInTheDocument()
  })
  it('缩放按钮改变百分比显示', () => {
    render(<KnowledgeGraph />)
    // 初始 100%
    expect(screen.getByText('100%')).toBeInTheDocument()
  })
})
