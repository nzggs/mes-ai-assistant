import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ChangePasswordModal } from './ChangePasswordModal'
import { registerUser, type User } from '../services/userService'

const user: User = { username: 'alice', displayName: '爱丽丝', department: 'IT部', role: 'admin' }

describe('ChangePasswordModal', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function renderModal(force = false) {
    const onClose = vi.fn()
    const onChanged = vi.fn()
    render(<ChangePasswordModal user={user} force={force} onClose={onClose} onChanged={onChanged} />)
    return { onClose, onChanged }
  }

  it('force 模式显示"首次登录请修改密码"且无关闭按钮', () => {
    renderModal(true)
    expect(screen.getByText('首次登录请修改密码')).toBeInTheDocument()
    expect(screen.getByText(/首次登录需修改密码/)).toBeInTheDocument()
  })

  it('非 force 缺原密码报错', () => {
    renderModal(false)
    fireEvent.change(screen.getByPlaceholderText('请输入新密码（至少6位）'), { target: { value: 'abc123' } })
    fireEvent.change(screen.getByPlaceholderText('请再次输入新密码'), { target: { value: 'abc123' } })
    fireEvent.click(screen.getByText('确认修改'))
    expect(screen.getByText('请输入原密码')).toBeInTheDocument()
  })

  it('新密码过短报错', () => {
    renderModal(false)
    fireEvent.change(screen.getByPlaceholderText('请输入当前密码'), { target: { value: 'abc123' } })
    fireEvent.change(screen.getByPlaceholderText('请输入新密码（至少6位）'), { target: { value: '123' } })
    fireEvent.click(screen.getByText('确认修改'))
    expect(screen.getByText('新密码至少 6 位')).toBeInTheDocument()
  })

  it('两次新密码不一致报错', () => {
    renderModal(false)
    fireEvent.change(screen.getByPlaceholderText('请输入当前密码'), { target: { value: 'abc123' } })
    fireEvent.change(screen.getByPlaceholderText('请输入新密码（至少6位）'), { target: { value: 'abc123' } })
    fireEvent.change(screen.getByPlaceholderText('请再次输入新密码'), { target: { value: 'abc999' } })
    fireEvent.click(screen.getByText('确认修改'))
    expect(screen.getByText('两次输入的新密码不一致')).toBeInTheDocument()
  })

  it('force 模式成功改密触发 onChanged', () => {
    registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'admin' })
    const { onChanged } = renderModal(true)
    fireEvent.change(screen.getByPlaceholderText('请输入新密码（至少6位）'), { target: { value: 'xyz789' } })
    fireEvent.change(screen.getByPlaceholderText('请再次输入新密码'), { target: { value: 'xyz789' } })
    fireEvent.click(screen.getByText('确认修改'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(onChanged).toHaveBeenCalled()
  })
})
