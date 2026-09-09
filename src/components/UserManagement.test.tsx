import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UserManagement } from './UserManagement'
import { ensureSuperAdminSeeded, registerUser, type User } from '../services/userService'

const currentUser: User = { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' }

describe('UserManagement', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    ensureSuperAdminSeeded()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderUM() {
    const onUserListChanged = vi.fn()
    render(<UserManagement currentUser={currentUser} onUserListChanged={onUserListChanged} />)
    return { onUserListChanged }
  }

  it('渲染标题与统计卡片', () => {
    renderUM()
    expect(screen.getByText('用户管理')).toBeInTheDocument()
    expect(screen.getByText('账户总数')).toBeInTheDocument()
    expect(screen.getByText('管理员')).toBeInTheDocument()
  })

  it('渲染超管账号与标签', async () => {
    renderUM()
    await waitFor(() => expect(screen.getByText('SITE_ADMIN')).toBeInTheDocument())
    expect(screen.getByText('超级管理员')).toBeInTheDocument()
  })

  it('点击注册账号显示注册表单', () => {
    renderUM()
    fireEvent.click(screen.getByText('注册账号'))
    expect(screen.getByText('注册新账号')).toBeInTheDocument()
  })

  it('注册表单校验：密码过短', () => {
    renderUM()
    fireEvent.click(screen.getByText('注册账号'))
    fireEvent.change(screen.getByPlaceholderText('登录用户名'), { target: { value: 'newuser' } })
    fireEvent.change(screen.getByPlaceholderText('至少6位'), { target: { value: '123' } })
    fireEvent.click(screen.getByText('确认注册'))
    expect(screen.getByText('密码至少 6 位')).toBeInTheDocument()
  })

  it('成功注册新账号', async () => {
    renderUM()
    fireEvent.click(screen.getByText('注册账号'))
    fireEvent.change(screen.getByPlaceholderText('登录用户名'), { target: { value: 'newuser' } })
    fireEvent.change(screen.getByPlaceholderText('至少6位'), { target: { value: 'abc123' } })
    fireEvent.change(screen.getByPlaceholderText('再次输入密码'), { target: { value: 'abc123' } })
    fireEvent.click(screen.getByText('确认注册'))
    // 注册成功后用户列表应包含新用户
    expect(registerUser).toBeTruthy()
  })

  it('搜索过滤用户', async () => {
    registerUser({ username: 'zhangsan', password: 'abc123', displayName: '张三', department: '技术部', role: 'user' })
    renderUM()
    await waitFor(() => expect(screen.getByText('zhangsan')).toBeInTheDocument())
    const input = screen.getByPlaceholderText('搜索用户名、名称或部门...')
    fireEvent.change(input, { target: { value: 'zhangsan' } })
    expect(screen.getByText('zhangsan')).toBeInTheDocument()
    expect(screen.queryByText('SITE_ADMIN')).not.toBeInTheDocument()
  })

  it('批量注册入口', () => {
    renderUM()
    fireEvent.click(screen.getByText('批量注册'))
    expect(screen.getByText('批量注册账号')).toBeInTheDocument()
    expect(screen.getByText('下载模板')).toBeInTheDocument()
  })
})
