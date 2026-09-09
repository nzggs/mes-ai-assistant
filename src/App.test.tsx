import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import App from './App'

vi.mock('./services/docStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./services/docStore')>()
  return {
    ...mod,
    getAllDocs: vi.fn(() => Promise.resolve([])),
    syncLocalToBackend: vi.fn(() => Promise.resolve()),
    saveTableSummary: vi.fn(),
    restoreDocsFromRecords: (records: unknown[]) => [],
  }
})

vi.mock('./services/llmApi', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./services/llmApi')>()
  return {
    ...mod,
    streamChat: vi.fn(),
    summarizeHistory: vi.fn(() => Promise.resolve(null)),
  }
})

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('渲染标题与版本号', () => {
    render(<App />)
    expect(screen.getAllByText('AI 智能助手').length).toBeGreaterThan(0)
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
  })

  it('渲染侧边栏导航', () => {
    render(<App />)
    expect(screen.getByText('智能问答')).toBeInTheDocument()
    expect(screen.getByText('知识库管理')).toBeInTheDocument()
  })

  it('未配置 API Key 时显示状态提示', () => {
    render(<App />)
    expect(screen.getByText('未配置 API Key')).toBeInTheDocument()
  })

  it('点击配置 Key 打开弹窗', () => {
    render(<App />)
    fireEvent.click(screen.getByText('配置 Key'))
    expect(screen.getByText('配置 AI 模型')).toBeInTheDocument()
  })

  it('未登录时默认显示欢迎页', () => {
    render(<App />)
    expect(screen.getByText(/RAG 知识库/)).toBeInTheDocument()
  })
})
