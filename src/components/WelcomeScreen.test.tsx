import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WelcomeScreen } from './WelcomeScreen'

const presets = [
  { icon: '🔍', category: '异常分析', question: '电芯批量胀气', description: '生成决策树' },
  { icon: '📊', category: '数据查询', question: '今天OEE多少', description: '查询MES数据' },
]

function renderWelcome() {
  const onQuestionClick = vi.fn()
  render(
    <WelcomeScreen
      presetQuestions={presets}
      onQuestionClick={onQuestionClick}
      useKnowledgeBase={false}
      onToggleKnowledgeBase={vi.fn()}
      deepThink={false}
      onToggleDeepThink={vi.fn()}
    />
  )
  return { onQuestionClick }
}

describe('WelcomeScreen', () => {
  it('渲染标题与副标题', () => {
    renderWelcome()
    expect(screen.getByText('AI 智能助手')).toBeInTheDocument()
    expect(screen.getByText(/RAG 知识库/)).toBeInTheDocument()
  })

  it('渲染所有预设问题', () => {
    renderWelcome()
    expect(screen.getByText('电芯批量胀气')).toBeInTheDocument()
    expect(screen.getByText('今天OEE多少')).toBeInTheDocument()
  })

  it('点击预设问题触发 onQuestionClick', () => {
    const { onQuestionClick } = renderWelcome()
    fireEvent.click(screen.getByText('电芯批量胀气'))
    expect(onQuestionClick).toHaveBeenCalledWith('电芯批量胀气')
  })

  it('渲染功能提示', () => {
    renderWelcome()
    expect(screen.getByText('私有化部署')).toBeInTheDocument()
    expect(screen.getByText('数据不出厂')).toBeInTheDocument()
  })
})
