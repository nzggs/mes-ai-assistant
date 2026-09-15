import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { KnowledgeBase } from './KnowledgeBase'
import { fetchAllDocPages } from '../services/docStore'
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
    fetchAllDocPages: vi.fn(() => Promise.resolve([])),
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

  // 回归：超大 XML 的正文不随列表下发（contentOmitted）。此前只有 selectedDoc / readerDoc
  // 会触发按需补全，直接点列表卡片右上角「阅读原文」拿到的是正文被剥离的快照 →
  // 弹窗渲染为空（白板）。此用例锁定「originalDoc 也必须补全」。
  it('超大 XML 文档：直接点卡片「阅读原文」会按需补全正文，不再白板', async () => {
    vi.mocked(fetchAllDocPages).mockResolvedValueOnce([
      { pageNum: 1, title: 'Z_WIDGET · 部件主数据', paragraphs: ['对象编号：Z_WIDGET', '描述：测试记录'] },
    ] as any)

    const xmlDoc: KnowledgeDoc = {
      id: 'x2', name: 'Z_WIDGET_202609101235.xml', type: 'xml', status: 'approved',
      summary: '', keywords: [], content: [], chunks: 0, pages: 1265,
      fileUrl: 'blob:fake-original.xml', contentOmitted: true, pageCount: 1265,
      tableSummaries: {}, summaryChunks: [],
      uploadDate: '2026-09-10', approvedDate: '2026-09-10', uploader: 'admin',
    } as any
    renderKB([xmlDoc], { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' })

    // 不打开详情弹窗，直接点列表卡片上的「阅读原文」
    fireEvent.click(screen.getByText('阅读原文'))

    expect(vi.mocked(fetchAllDocPages)).toHaveBeenCalledWith('x2')
    await waitFor(() => {
      expect(document.body.textContent).toContain('第 1 条 · Z_WIDGET · 部件主数据')
    })
  })

  // .txt 纯文本：解析入库后应与其它格式同等可用——列表带 TXT 标签、可打开原文、可总结
  it('.txt 纯文本：列表显示 TXT 标签，点「阅读原文」直接渲染已解码正文', async () => {
    const txtDoc: KnowledgeDoc = {
      id: 't1', name: '注液工艺说明.txt', type: 'txt', fileType: 'txt', status: 'approved',
      summary: '注液工序参数说明', keywords: ['注液'], content: [
        { pageNum: 1, title: '注液工艺说明.txt - 第1段', paragraphs: ['注液量控制在 3.2±0.1 g。'] },
        { pageNum: 2, title: '注液工艺说明.txt - 第2段', paragraphs: ['静置时间不少于 12 小时。'] },
      ],
      chunks: 3, pages: 2, size: '1.2 KB', fileUrl: 'blob:fake-original.txt',
      tableSummaries: {}, summaryChunks: [],
      uploadDate: '2026-09-15', approvedDate: '2026-09-15', uploader: 'admin',
    } as any
    renderKB([txtDoc], { username: 'admin', displayName: '管理员', department: 'IT部', role: 'admin' })

    expect(screen.getByText('TXT')).toBeInTheDocument()
    expect(screen.getByText('注液工艺说明.txt')).toBeInTheDocument()

    // 直接点卡片右上角「阅读原文」→ 原文弹窗渲染已入库的正文（无需再下载原文件）
    fireEvent.click(screen.getByText('阅读原文'))
    await waitFor(() => {
      expect(document.body.textContent).toContain('注液量控制在 3.2±0.1 g。')
    })
    expect(document.body.textContent).toContain('注液工艺说明.txt - 第2段')
  })
})
