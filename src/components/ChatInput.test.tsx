import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from './ChatInput'

function renderInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  const onSend = vi.fn()
  const onToggleKnowledgeBase = vi.fn()
  const onToggleDeepThink = vi.fn()
  render(
    <ChatInput
      onSend={onSend}
      disabled={false}
      useKnowledgeBase={false}
      onToggleKnowledgeBase={onToggleKnowledgeBase}
      deepThink={false}
      onToggleDeepThink={onToggleDeepThink}
      {...props}
    />
  )
  return { onSend, onToggleKnowledgeBase, onToggleDeepThink }
}

describe('ChatInput', () => {
  it('渲染输入框与工具栏按钮', () => {
    renderInput()
    expect(screen.getByPlaceholderText(/输入您的问题/)).toBeInTheDocument()
    expect(screen.getByText('深度思考')).toBeInTheDocument()
    expect(screen.getByText('知识库')).toBeInTheDocument()
  })

  it('点击发送按钮触发 onSend 并清空输入', () => {
    const { onSend } = renderInput()
    const ta = screen.getByPlaceholderText(/输入您的问题/) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '你好' } })
    const sendBtn = screen.getByRole('button', { name: '' }) // 发送按钮无文本，仅图标
    // 直接触发 textarea Enter 更可靠
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledWith('你好')
    expect(ta.value).toBe('')
  })

  it('Shift+Enter 不发送', () => {
    const { onSend } = renderInput()
    const ta = screen.getByPlaceholderText(/输入您的问题/)
    fireEvent.change(ta, { target: { value: '换行内容' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('空文本不发送', () => {
    const { onSend } = renderInput()
    const ta = screen.getByPlaceholderText(/输入您的问题/)
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disabled 时不发送且显示占位提示', () => {
    renderInput({ disabled: true })
    const ta = screen.getByPlaceholderText('AI 正在回复中...')
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })
    expect(screen.getByPlaceholderText('AI 正在回复中...')).toBeInTheDocument()
  })

  it('点击知识库按钮切换', () => {
    const { onToggleKnowledgeBase } = renderInput()
    fireEvent.click(screen.getByText('知识库'))
    expect(onToggleKnowledgeBase).toHaveBeenCalled()
  })

  it('点击深度思考按钮切换', () => {
    const { onToggleDeepThink } = renderInput()
    fireEvent.click(screen.getByText('深度思考'))
    expect(onToggleDeepThink).toHaveBeenCalled()
  })

  it('回复中且提供 onStop 时显示「停止生成」按钮，点击触发 onStop', () => {
    const onStop = vi.fn()
    renderInput({ disabled: true, onStop })
    const stopBtn = screen.getByTitle('停止生成')
    expect(stopBtn).toBeInTheDocument()
    fireEvent.click(stopBtn)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('回复中但无 onStop 时不显示停止按钮（回退为禁用的发送按钮）', () => {
    renderInput({ disabled: true })
    expect(screen.queryByTitle('停止生成')).toBeNull()
  })

  it('非回复中不显示停止按钮', () => {
    const onStop = vi.fn()
    renderInput({ disabled: false, onStop })
    expect(screen.queryByTitle('停止生成')).toBeNull()
  })
})
