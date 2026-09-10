import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

  it('XML 数据导出：点击「总结整个文档」被拦截，不会发起总结任务', () => {
    const xmlDoc: KnowledgeDoc = {
      id: 'x1', name: 'Z_LOGIC_202609101240.xml', type: 'xml', status: 'approved',
      summary: '', keywords: [], content: [], chunks: 0, pages: 2035,
      tableSummaries: {}, summaryChunks: [],
      uploadDate: '2026-09-10', approvedDate: '2026-09-10', uploader: 'admin',
    } as any
    renderKB([xmlDoc], { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' })

    // 打开详情面板：面板内已有「无需总结」的说明
    fireEvent.click(screen.getByText('Z_LOGIC_202609101240.xml'))
    expect(screen.getAllByText(/无需进行 AI 总结/)).toHaveLength(1)

    // 点击总结按钮 → 校验拦下：弹窗给出拒绝说明，且没有调用 /api/summary/start
    fireEvent.click(screen.getByText(/总结整个文档/))
    expect(screen.getAllByText(/无需进行 AI 总结/).length).toBeGreaterThan(1)
    expect(screen.getByText('可复制以上总结内容使用')).toBeInTheDocument()
    const calls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0] ?? ''))
    expect(calls.some(u => u.includes('/api/summary/start'))).toBe(false)
  })

  it('普通文档（非 XML）不受该校验影响：仍会发起总结请求', () => {
    const pdfDoc: KnowledgeDoc = {
      id: 'p1', name: '手册.pdf', type: 'pdf', status: 'approved',
      summary: '', keywords: [], content: [], chunks: 0, pages: 10,
      tableSummaries: {}, summaryChunks: [],
      uploadDate: '2026-09-10', approvedDate: '2026-09-10', uploader: 'admin',
    } as any
    renderKB([pdfDoc], { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' })

    fireEvent.click(screen.getByText('手册.pdf'))
    fireEvent.click(screen.getByText(/总结整个文档/))
    // 无 API Key 时走既有的「请先配置 API Key」分支，不应出现 XML 提示
    expect(screen.getByText(/请先在设置中配置 API Key/)).toBeInTheDocument()
    expect(screen.queryByText(/无需进行 AI 总结/)).not.toBeInTheDocument()
  })
})
