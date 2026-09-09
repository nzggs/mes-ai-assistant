import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import ErrorToasts from './ErrorToasts'
import { reportError } from '../services/errorReporter'

describe('ErrorToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('无错误时渲染 null', () => {
    const { container } = render(<ErrorToasts />)
    expect(container.firstChild).toBeNull()
  })

  it('上报错误后显示卡片', () => {
    render(<ErrorToasts />)
    act(() => { reportError('解析失败：xxx') })
    expect(screen.getByText('解析失败：xxx')).toBeInTheDocument()
  })

  it('点击关闭按钮移除卡片', () => {
    render(<ErrorToasts />)
    act(() => { reportError('一条错误') })
    const btn = screen.getByRole('button', { name: '关闭' })
    fireEvent.click(btn)
    expect(screen.queryByText('一条错误')).not.toBeInTheDocument()
  })

  it('8 秒后自动消失', () => {
    render(<ErrorToasts />)
    act(() => { reportError('自动消失的错误') })
    expect(screen.getByText('自动消失的错误')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(8000) })
    expect(screen.queryByText('自动消失的错误')).not.toBeInTheDocument()
  })

  it('最多同时显示 5 条', () => {
    render(<ErrorToasts />)
    act(() => {
      for (let i = 0; i < 7; i++) reportError(`错误${i}`)
    })
    // 最新 5 条保留，最旧的 2 条被截断
    expect(screen.queryByText('错误0')).not.toBeInTheDocument()
    expect(screen.queryByText('错误1')).not.toBeInTheDocument()
    expect(screen.getByText('错误6')).toBeInTheDocument()
  })
})
