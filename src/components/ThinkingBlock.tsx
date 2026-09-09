import { useState } from 'react'

interface ThinkingBlockProps {
  steps: string[]
}

export function ThinkingBlock({ steps }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="mb-3 rounded-xl border border-mes-border bg-gray-50 overflow-hidden animate-expand">
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-primary">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
          </svg>
          <span className="text-sm font-medium text-mes-textSecondary">深度思考过程</span>
          <span className="text-xs text-mes-textTertiary">· {steps.length} 步推理</span>
        </div>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-mes-textTertiary transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* 步骤列表 */}
      {expanded && (
        <div className="px-4 pb-3 pt-1 space-y-2 animate-fade-in">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-start gap-2.5">
              <div className="flex flex-col items-center shrink-0 mt-0.5">
                <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                  idx === steps.length - 1
                    ? 'bg-mes-success text-white'
                    : 'bg-mes-primary text-white'
                }`}>
                  {idx === steps.length - 1 ? '✓' : idx + 1}
                </div>
                {idx < steps.length - 1 && (
                  <div className="w-px h-4 bg-mes-border mt-0.5" />
                )}
              </div>
              <p className="text-xs text-mes-textSecondary leading-relaxed pt-0.5">
                {step}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
