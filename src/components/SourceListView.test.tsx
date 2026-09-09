import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceListView } from './SourceListView'

const sources = [
  { docName: '安全规范.pdf', docType: 'pdf' as const, page: '第1页', section: '安全试验', uploader: '王工', uploadDate: '2026-01-01', relevance: 97, summary: '安全规范摘要' },
  { docName: '生产记录', docType: 'mes' as const, uploader: '系统', uploadDate: '2026-01-02', relevance: 50, summary: 'MES记录' },
]

describe('SourceListView', () => {
  it('渲染来源列表与计数', () => {
    render(<SourceListView sources={sources} />)
    expect(screen.getByText('数据来源')).toBeInTheDocument()
    expect(screen.getByText(/共 2 条引用/)).toBeInTheDocument()
    expect(screen.getByText('安全规范.pdf')).toBeInTheDocument()
  })
  it('渲染文档类型标签', () => {
    render(<SourceListView sources={sources} />)
    expect(screen.getByText('PDF')).toBeInTheDocument()
    expect(screen.getByText('MES')).toBeInTheDocument()
  })
  it('渲染相关度百分比', () => {
    render(<SourceListView sources={sources} />)
    expect(screen.getByText('97%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })
})
