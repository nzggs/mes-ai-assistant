import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import type { Conversation, SidebarView, KnowledgeDoc } from '../types'
import type { User } from './AuthModal'

const now = Date.now()
const conversations: Conversation[] = [
  { id: 'c1', title: '胀气分析', updatedAt: now, messages: [] },
  { id: 'c2', title: '历史对话', updatedAt: now - 86400000, messages: [] },
]

const docs: KnowledgeDoc[] = [{ id: 'd1', name: '文档1' } as KnowledgeDoc]

const admin: User = { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' }
const normal: User = { username: 'u', displayName: '用户', department: '生产部', role: 'user' }

function renderSidebar(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const defaults = {
    conversations,
    activeId: null,
    sidebarView: 'chat' as SidebarView,
    sidebarOpen: true,
    user: null,
    documents: docs,
    onNewChat: vi.fn(),
    onSelectConversation: vi.fn(),
    onDeleteConversation: vi.fn(),
    onSwitchView: vi.fn(),
    onToggle: vi.fn(),
    onOpenAuth: vi.fn(),
    onLogout: vi.fn(),
    onRequestChangePassword: vi.fn(),
    onOpenApiSettings: vi.fn(),
  }
  render(<Sidebar {...defaults} {...props} />)
  return defaults
}

describe('Sidebar', () => {
  it('sidebarOpen=false 返回 null', () => {
    const { container } = render(<Sidebar {...{ conversations, activeId: null, sidebarView: 'chat', sidebarOpen: false, user: null, documents: docs, onNewChat: vi.fn(), onSelectConversation: vi.fn(), onDeleteConversation: vi.fn(), onSwitchView: vi.fn(), onToggle: vi.fn(), onOpenAuth: vi.fn(), onLogout: vi.fn(), onRequestChangePassword: vi.fn(), onOpenApiSettings: vi.fn() }} />)
    expect(container.firstChild).toBeNull()
  })

  it('渲染导航菜单与新建对话', () => {
    renderSidebar()
    expect(screen.getByText('智能问答')).toBeInTheDocument()
    expect(screen.getByText('知识库管理')).toBeInTheDocument()
    expect(screen.getByText('新建对话')).toBeInTheDocument()
  })

  it('渲染对话列表（今天/更早分组）', () => {
    renderSidebar()
    expect(screen.getByText('今天')).toBeInTheDocument()
    expect(screen.getByText('更早')).toBeInTheDocument()
    expect(screen.getByText('胀气分析')).toBeInTheDocument()
    expect(screen.getByText('历史对话')).toBeInTheDocument()
  })

  it('无对话显示空状态', () => {
    renderSidebar({ conversations: [] })
    expect(screen.getByText('暂无对话记录')).toBeInTheDocument()
  })

  it('未登录显示登录按钮', () => {
    renderSidebar({ user: null })
    expect(screen.getByText('登录')).toBeInTheDocument()
  })

  it('管理员显示用户管理入口', () => {
    renderSidebar({ user: admin })
    expect(screen.getByText('用户管理')).toBeInTheDocument()
  })

  it('普通用户不显示用户管理入口', () => {
    renderSidebar({ user: normal })
    expect(screen.queryByText('用户管理')).not.toBeInTheDocument()
  })

  it('点击新建对话触发 onNewChat', () => {
    const p = renderSidebar()
    fireEvent.click(screen.getByText('新建对话'))
    expect(p.onNewChat).toHaveBeenCalled()
  })

  it('搜索过滤对话', () => {
    renderSidebar()
    const input = screen.getByPlaceholderText('搜索对话...')
    fireEvent.change(input, { target: { value: '胀气' } })
    expect(screen.getByText('胀气分析')).toBeInTheDocument()
    expect(screen.queryByText('历史对话')).not.toBeInTheDocument()
  })
})
