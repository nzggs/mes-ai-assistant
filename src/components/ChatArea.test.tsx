import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatArea } from './ChatArea'
import type { Conversation } from '../types'

const conversation: Conversation = {
  id: 'c1',
  title: '测试对话',
  messages: [
    { id: 'm1', role: 'user', contents: [{ type: 'text', text: '你好' }], isStreaming: false },
    { id: 'm2', role: 'assistant', contents: [{ type: 'text', text: '你好，有什么可以帮你' }], isStreaming: false },
  ],
}

function renderArea(conv: Conversation = conversation) {
  render(
    <ChatArea
      conversation={conv}
      onSendMessage={vi.fn()}
      useKnowledgeBase={false}
      onToggleKnowledgeBase={vi.fn()}
      currentUser={null}
      deepThink={false}
      onToggleDeepThink={vi.fn()}
    />
  )
}

describe('ChatArea', () => {
  it('渲染消息列表', () => {
    renderArea()
    expect(screen.getByText('你好，有什么可以帮你')).toBeInTheDocument()
  })
  it('流式输出时显示加载指示器', () => {
    const streaming: Conversation = {
      ...conversation,
      messages: [...conversation.messages, { id: 'm3', role: 'assistant', contents: [{ type: 'text', text: '' }], isStreaming: true }],
    }
    renderArea(streaming)
    expect(screen.getByText('正在分析中...')).toBeInTheDocument()
  })
  it('渲染输入框', () => {
    renderArea()
    expect(screen.getByPlaceholderText(/输入您的问题/)).toBeInTheDocument()
  })
})
