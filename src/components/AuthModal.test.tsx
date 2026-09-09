import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AuthModal } from './AuthModal'
import { ensureSuperAdminSeeded, SUPER_ADMIN } from '../services/userService'

describe('AuthModal', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function renderModal() {
    const onClose = vi.fn()
    const onLogin = vi.fn()
    render(<AuthModal onClose={onClose} onLogin={onLogin} />)
    return { onClose, onLogin }
  }

  it('渲染登录表单', () => {
    renderModal()
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('请输入用户名')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/请输入密码/)).toBeInTheDocument()
  })

  it('空用户名报错', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(screen.getByText('请输入用户名')).toBeInTheDocument()
  })

  it('用户名不存在报错', () => {
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('请输入用户名'), { target: { value: 'ghost' } })
    fireEvent.change(screen.getByPlaceholderText(/请输入密码/), { target: { value: 'abc123' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    act(() => { vi.advanceTimersByTime(600) })
    expect(screen.getByText(/用户名不存在/)).toBeInTheDocument()
  })

  it('登录成功触发 onLogin', () => {
    ensureSuperAdminSeeded()
    const { onLogin } = renderModal()
    fireEvent.change(screen.getByPlaceholderText('请输入用户名'), { target: { value: SUPER_ADMIN.username } })
    fireEvent.change(screen.getByPlaceholderText(/请输入密码/), { target: { value: SUPER_ADMIN.password } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    act(() => { vi.advanceTimersByTime(600) })
    expect(onLogin).toHaveBeenCalled()
    expect(onLogin.mock.calls[0][0].username).toBe(SUPER_ADMIN.username)
  })

  it('连续失败锁定', () => {
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('请输入用户名'), { target: { value: 'ghost' } })
    fireEvent.change(screen.getByPlaceholderText(/请输入密码/), { target: { value: 'abc123' } })
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole('button', { name: '登录' }))
      act(() => { vi.advanceTimersByTime(600) })
    }
    // 第 6 次尝试应提示锁定
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(screen.getByText(/登录失败次数过多/)).toBeInTheDocument()
  })
})
