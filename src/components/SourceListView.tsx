import type { SourceCitation } from '../types'

interface SourceListViewProps {
  sources: SourceCitation[]
}

const docTypeConfig: Record<SourceCitation['docType'], { label: string; icon: string; color: string; bg: string }> = {
  word: { label: 'Word', icon: '📄', color: '#2563eb', bg: '#eff6ff' },
  ppt: { label: 'PPT', icon: '📊', color: '#ea580c', bg: '#fff7ed' },
  excel: { label: 'Excel', icon: '📈', color: '#16a34a', bg: '#f0fdf4' },
  pdf: { label: 'PDF', icon: '📕', color: '#dc2626', bg: '#fef2f2' },
  web: { label: '网页', icon: '🌐', color: '#7c3aed', bg: '#faf5ff' },
  mes: { label: 'MES', icon: '🗄️', color: '#0891b2', bg: '#ecfeff' },
  xml: { label: 'XML', icon: '🗂️', color: '#7c3aed', bg: '#f5f3ff' },
}

export function SourceListView({ sources }: SourceListViewProps) {
  return (
    <div className="my-3 animate-slide-up">
      <div className="flex items-center gap-2 mb-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-primary">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        <span className="text-sm font-semibold text-mes-text">数据来源</span>
        <span className="text-xs text-mes-textTertiary">· 共 {sources.length} 条引用</span>
      </div>

      <div className="space-y-2">
        {sources.map((source, idx) => (
          <SourceItem key={idx} source={source} index={idx + 1} />
        ))}
      </div>
    </div>
  )
}

function SourceItem({ source, index }: { source: SourceCitation; index: number }) {
  const config = docTypeConfig[source.docType]
  const relevanceColor = source.relevance >= 85 ? '#22c55e' : source.relevance >= 65 ? '#f59e0b' : '#6b7280'

  return (
    <div className="group flex items-start gap-3 p-3 rounded-xl border border-mes-border bg-white hover:border-mes-primary hover:shadow-sm transition-all-smooth cursor-pointer">
      {/* 序号 */}
      <div className="shrink-0 w-6 h-6 rounded-full bg-mes-tagBg flex items-center justify-center text-xs font-bold text-mes-primary">
        {index}
      </div>

      {/* 文档信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm">{config.icon}</span>
          <span className="text-sm font-medium text-mes-text truncate">{source.docName}</span>
          <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: config.color, backgroundColor: config.bg }}>
            {config.label}
          </span>
        </div>

        <p className="text-xs text-mes-textSecondary leading-relaxed mb-1.5">
          {source.summary}
        </p>

        <div className="flex items-center gap-3 text-xs text-mes-textTertiary flex-wrap">
          {source.page && (
            <span className="flex items-center gap-0.5">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              {source.page}
            </span>
          )}
          {source.section && (
            <span className="flex items-center gap-0.5">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              {source.section}
            </span>
          )}
          <span className="flex items-center gap-0.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            {source.uploader}
          </span>
          <span className="flex items-center gap-0.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            {source.uploadDate}
          </span>
        </div>
      </div>

      {/* 相关度 */}
      <div className="shrink-0 flex flex-col items-center">
        <div className="relative w-10 h-10">
          <svg className="w-10 h-10 -rotate-90" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke="#e5e5e5" strokeWidth="3" />
            <circle
              cx="20" cy="20" r="16" fill="none"
              stroke={relevanceColor}
              strokeWidth="3"
              strokeDasharray={`${(source.relevance / 100) * 100.5} 100.5`}
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold" style={{ color: relevanceColor }}>
            {source.relevance}%
          </span>
        </div>
        <span className="text-[10px] text-mes-textTertiary mt-0.5">相关度</span>
      </div>
    </div>
  )
}
