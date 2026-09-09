import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PdfViewer } from './PdfViewer'

vi.mock('pdfjs-dist', () => {
  throw new Error('pdfjs 模块加载失败')
})

function renderViewer() {
  const props = {
    url: 'http://localhost:3001/api/docs/d1/file',
    searchTerm: '',
    onPageChange: vi.fn(),
    onSearchResults: vi.fn(),
    registerJumpToPage: vi.fn(),
  }
  render(<PdfViewer {...props} />)
  return props
}

describe('PdfViewer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('初始显示加载中', () => {
    renderViewer()
    expect(screen.getByText('正在加载 PDF 文件...')).toBeInTheDocument()
  })
})
