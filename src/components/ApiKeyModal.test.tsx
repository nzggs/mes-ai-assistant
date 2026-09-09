import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ApiKeyModal } from './ApiKeyModal'
import * as llmApi from '../services/llmApi'

vi.mock('../services/llmApi', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/llmApi')>()
  return { ...mod, testApiKey: vi.fn(() => Promise.resolve({ valid: true })) }
})

describe('ApiKeyModal', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  function renderModal(props: Partial<Parameters<typeof ApiKeyModal>[0]> = {}) {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const { container } = render(<ApiKeyModal onClose={onClose} onSaved={onSaved} {...props} />)
    return { onClose, onSaved, container }
  }

  it('渲染标题与提供商选择', () => {
    renderModal()
    expect(screen.getByText('配置 AI 模型')).toBeInTheDocument()
    expect(screen.getByText('模型提供商')).toBeInTheDocument()
  })

  it('点击右上角关闭按钮触发 onClose', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('forceOpen 显示提示', () => {
    renderModal({ forceOpen: true })
    expect(screen.getByText(/需要配置 API Key/)).toBeInTheDocument()
  })

  it('Key 过短时保存按钮禁用', () => {
    const { onSaved, onClose, container } = renderModal()
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'short' } })
    expect(screen.getByText('保存').closest('button')).toBeDisabled()
    fireEvent.click(screen.getByText('保存'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('合法 Key 保存触发 onSaved 与 onClose', () => {
    const { onSaved, onClose, container } = renderModal()
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-1234567890' } })
    fireEvent.click(screen.getByText('保存'))
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('切换提供商', () => {
    renderModal()
    // 默认 deepseek 选中，点击其他提供商
    const buttons = screen.getAllByRole('button')
    const minimaxBtn = buttons.find(b => b.textContent?.trim() === 'MiniMax')
    if (minimaxBtn) {
      fireEvent.click(minimaxBtn)
      expect(minimaxBtn.className).toContain('bg-mes-primary')
    }
  })
})
