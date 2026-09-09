import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KnowledgeBase } from './KnowledgeBase'
import type { KnowledgeDoc } from '../types'

vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(() => Promise.resolve()),
}))

vi.mock('../services/docStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/docStore')>()
  return {
    ...mod,
    getDocLogs: vi.fn(() => Promise.resolve([])),
    saveUploadedDoc: vi.fn(() => Promise.resolve()),
    saveMeta: vi.fn(() => Promise.resolve()),
    removeDoc: vi.fn(() => Promise.resolve()),
    saveTableSummary: vi.fn(() => Promise.resolve({ tableSummaries: {} })),
    appendDocLog: vi.fn(() => Promise.resolve()),
  }
})

describe('KnowledgeBase', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderKB(documents: KnowledgeDoc[] = [], currentUser: any = null) {
    const onDocumentsChange = vi.fn()
    render(
      <KnowledgeBase
        documents={documents}
        currentUser={currentUser}
        onDocumentsChange={onDocumentsChange}
        onRequireLogin={vi.fn()}
      />
    )
    return { onDocumentsChange }
  }

  it('渲染标题', () => {
    renderKB()
    expect(screen.getByText('知识库管理')).toBeInTheDocument()
  })

  it('未登录时显示"请先登录后上传"', () => {
    renderKB([], null)
    expect(screen.getByText('请先登录后上传')).toBeInTheDocument()
  })

  it('登录后显示"上传文档"', () => {
    renderKB([], { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' })
    expect(screen.getByText('上传文档')).toBeInTheDocument()
  })

  it('空文档列表显示空状态', () => {
    renderKB([])
    expect(screen.getByText('未找到匹配的文档')).toBeInTheDocument()
  })

  it('渲染文档列表', () => {
    const docs: KnowledgeDoc[] = [
      { id: 'd1', name: '测试文档.docx', type: 'word', status: 'approved', summary: '摘要', keywords: [], content: [], chunks: 0, tableSummaries: {}, summaryChunks: [], uploadDate: '2026-08-01', uploader: 'admin' } as any,
    ]
    renderKB(docs, { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' })
    expect(screen.getByText('测试文档.docx')).toBeInTheDocument()
  })
})
