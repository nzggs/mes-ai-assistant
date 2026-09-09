import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThinkingBlock } from './ThinkingBlock'

describe('ThinkingBlock', () => {
  it('渲染思考步骤', () => {
    render(<ThinkingBlock steps={['解析问题', '检索知识库', '生成结论']} />)
    expect(screen.getByText('深度思考过程')).toBeInTheDocument()
    expect(screen.getByText('· 3 步推理')).toBeInTheDocument()
    expect(screen.getByText('解析问题')).toBeInTheDocument()
  })
  it('默认展开，点击收起', () => {
    render(<ThinkingBlock steps={['步骤1', '步骤2']} />)
    expect(screen.getByText('步骤1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('深度思考过程'))
    expect(screen.queryByText('步骤1')).not.toBeInTheDocument()
  })
  it('最后一步显示 ✓ 标记', () => {
    render(<ThinkingBlock steps={['a', 'b']} />)
    expect(screen.getByText('✓')).toBeInTheDocument()
  })
})
