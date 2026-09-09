import type { ParamRecommendation } from '../types'

interface ParamCardViewProps {
  params: ParamRecommendation[]
}

const categoryConfig: Record<ParamRecommendation['category'], { label: string; color: string; bg: string; icon: string }> = {
  process: { label: '过程参数', color: '#2563eb', bg: '#eff6ff', icon: '⚙️' },
  quality: { label: '质量标准', color: '#7c3aed', bg: '#faf5ff', icon: '📋' },
  timing: { label: '卡控时间', color: '#ea580c', bg: '#fff7ed', icon: '⏱️' },
}

export function ParamCardView({ params }: ParamCardViewProps) {
  return (
    <div className="my-3 space-y-3 animate-slide-up">
      <div className="flex items-center gap-2 mb-1">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-primary">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="text-sm font-semibold text-mes-text">参数调优建议</span>
        <span className="text-xs text-mes-textTertiary">· 基于历史最优批次</span>
      </div>

      {params.map((param, idx) => (
        <ParamCard key={idx} param={param} />
      ))}
    </div>
  )
}

function ParamCard({ param }: { param: ParamRecommendation }) {
  const config = categoryConfig[param.category]
  const isIncrease = parseFloat(param.recommendedValue) > parseFloat(param.currentValue)
  const confidenceColor = param.confidence >= 85 ? '#22c55e' : param.confidence >= 70 ? '#f59e0b' : '#ef4444'

  return (
    <div className="rounded-xl border border-mes-border bg-white overflow-hidden hover:shadow-md transition-all-smooth">
      {/* 卡片头部 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-mes-border" style={{ backgroundColor: config.bg }}>
        <div className="flex items-center gap-2">
          <span className="text-sm">{config.icon}</span>
          <span className="text-sm font-medium" style={{ color: config.color }}>{param.paramName}</span>
          <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ color: config.color, backgroundColor: 'rgba(255,255,255,0.7)' }}>
            {config.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-mes-textSecondary">置信度</span>
          <div className="relative w-7 h-7">
            <svg className="w-7 h-7 -rotate-90" viewBox="0 0 28 28">
              <circle cx="14" cy="14" r="11" fill="none" stroke="#e5e5e5" strokeWidth="2.5" />
              <circle
                cx="14" cy="14" r="11" fill="none"
                stroke={confidenceColor}
                strokeWidth="2.5"
                strokeDasharray={`${(param.confidence / 100) * 69.1} 69.1`}
                strokeLinecap="round"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold" style={{ color: confidenceColor }}>
              {param.confidence}
            </span>
          </div>
        </div>
      </div>

      {/* 参数对比 */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-4 mb-3">
          {/* 当前值 */}
          <div className="flex-1 text-center">
            <p className="text-xs text-mes-textTertiary mb-1">当前值</p>
            <p className="text-lg font-bold text-mes-textSecondary">
              {param.currentValue}
              {param.unit && <span className="text-xs font-normal ml-0.5">{param.unit}</span>}
            </p>
          </div>

          {/* 箭头 */}
          <div className="flex flex-col items-center">
            <div className={`flex items-center justify-center w-8 h-8 rounded-full ${
              isIncrease ? 'bg-orange-50' : 'bg-green-50'
            }`}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className={isIncrease ? 'text-orange-500' : 'text-green-500'}
              >
                {isIncrease ? <polyline points="5 12 12 5 19 12" /> : <polyline points="19 12 12 19 5 12" />}
                <line x1="12" y1="5" x2="12" y2="19" />
              </svg>
            </div>
          </div>

          {/* 建议值 */}
          <div className="flex-1 text-center">
            <p className="text-xs text-mes-primary mb-1 font-medium">建议值</p>
            <p className="text-lg font-bold text-mes-primary">
              {param.recommendedValue}
              {param.unit && <span className="text-xs font-normal ml-0.5">{param.unit}</span>}
            </p>
          </div>
        </div>

        {/* 调整幅度 */}
        <div className="flex items-center justify-center gap-1 mb-3">
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: isIncrease ? '#fff7ed' : '#f0fdf4', color: isIncrease ? '#ea580c' : '#16a34a' }}>
            {isIncrease ? '↑' : '↓'} 调整 {
              param.currentValue !== '0' && param.recommendedValue !== '0'
                ? Math.abs(((parseFloat(param.recommendedValue) - parseFloat(param.currentValue)) / parseFloat(param.currentValue)) * 100).toFixed(1)
                : '—'
            }%
          </span>
        </div>

        {/* 推荐理由 */}
        <div className="bg-gray-50 rounded-lg p-2.5 mb-2">
          <p className="text-xs text-mes-textSecondary leading-relaxed">
            <span className="font-medium text-mes-text">推荐理由：</span>
            {param.reason}
          </p>
        </div>

        {/* 历史参考 */}
        {param.historicalRef && (
          <div className="flex items-center gap-1.5 text-xs text-mes-textTertiary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>历史参考：{param.historicalRef}</span>
          </div>
        )}
      </div>
    </div>
  )
}
