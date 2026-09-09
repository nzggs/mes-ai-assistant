import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageBubble } from './MessageBubble'
import type { ChatMessage } from '../types'
import { mockAnalysisTree, mockParamRecommendations, mockSources, mockMesData } from '../data/mockData'

vi.mock('../utils/exportWord', () => ({
  exportMarkdownAsWord: vi.fn(),
  sanitizeFilename: (s: string) => s,
  markdownToHtml: (s: string) => s,
}))

function msg(contents: ChatMessage['contents'], role: 'user' | 'assistant' = 'assistant', isStreaming = false): ChatMessage {
  return { id: '1', role, contents, isStreaming } as ChatMessage
}

describe('MessageBubble', () => {
  it('渲染用户文本消息（头像首字符）', () => {
    render(<MessageBubble message={msg([{ type: 'text', text: '我的问题' }], 'user')} currentUser={{ username: 'alice', displayName: '爱丽丝', department: 'IT部', role: 'user' }} />)
    expect(screen.getByText('我的问题')).toBeInTheDocument()
    expect(screen.getByText('爱')).toBeInTheDocument()
  })
  it('渲染助手 Markdown 文本与免责声明', () => {
    render(<MessageBubble message={msg([{ type: 'text', text: '# 标题' }])} />)
    expect(screen.getByText('内容为AI生成，仅供参考')).toBeInTheDocument()
  })
  it('渲染 thinking 块', () => {
    render(<MessageBubble message={msg([{ type: 'thinking', thinkingSteps: ['步骤1'] }])} />)
    expect(screen.getByText('深度思考过程')).toBeInTheDocument()
  })
  it('渲染分析树', () => {
    render(<MessageBubble message={msg([{ type: 'analysisTree', tree: mockAnalysisTree }])} />)
    expect(screen.getByText('异常分析决策树')).toBeInTheDocument()
  })
  it('渲染参数卡片', () => {
    render(<MessageBubble message={msg([{ type: 'paramCard', params: mockParamRecommendations }])} />)
    expect(document.body.textContent).toContain(mockParamRecommendations[0]?.name || '')
  })
  it('渲染来源列表', () => {
    render(<MessageBubble message={msg([{ type: 'sourceList', sources: mockSources }])} />)
    expect(screen.getByText('数据来源')).toBeInTheDocument()
  })
  it('渲染 MES 数据', () => {
    render(<MessageBubble message={msg([{ type: 'mesData', mesData: mockMesData }])} />)
    expect(screen.getByText(mockMesData.title)).toBeInTheDocument()
  })
  it('流式消息不显示导出按钮', () => {
    render(<MessageBubble message={msg([{ type: 'text', text: 'x' }], 'assistant', true)} />)
    expect(screen.queryByText('导出 Word')).not.toBeInTheDocument()
  })
  it('导出 Word 按钮调用导出', async () => {
    const { exportMarkdownAsWord } = await import('../utils/exportWord')
    render(<MessageBubble message={msg([{ type: 'text', text: '回答内容' }])} userQuery="问题概述" />)
    fireEvent.click(screen.getByText('导出 Word'))
    expect(exportMarkdownAsWord).toHaveBeenCalled()
  })
})
