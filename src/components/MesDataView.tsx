import type { MesDataItem } from '../types'

interface MesDataViewProps {
  data: {
    title: string
    items: MesDataItem[]
    queryTime: string
  }
}

const statusConfig: Record<MesDataItem['status'], { color: string; bg: string; label: string }> = {
  normal: { color: '#16a34a', bg: '#f0fdf4', label: '正常' },
  warning: { color: '#f59e0b', bg: '#fffbeb', label: '预警' },
  danger: { color: '#ef4444', bg: '#fef2f2', label: '异常' },
}

export function MesDataView({ data }: MesDataViewProps) {
  return (
    <div className="my-3 rounded-xl border border-mes-border bg-white overflow-hidden animate-slide-up">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-cyan-50 to-blue-50 border-b border-mes-border">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-600">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          <span className="text-sm font-semibold text-mes-text">{data.title}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-mes-textTertiary">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          查询时间：{data.queryTime}
        </div>
      </div>

      {/* 数据网格 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-mes-border">
        {data.items.map((item, idx) => {
          const config = statusConfig[item.status]
          return (
            <div key={idx} className="bg-white p-3 hover:bg-gray-50 transition-colors">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-mes-textSecondary truncate">{item.label}</span>
                <span
                  className="text-[10px] px-1 py-0.5 rounded font-medium shrink-0"
                  style={{ color: config.color, backgroundColor: config.bg }}
                >
                  {config.label}
                </span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold" style={{ color: item.status === 'normal' ? '#1a1a1a' : config.color }}>
                  {item.value}
                </span>
                {item.unit && <span className="text-xs text-mes-textTertiary">{item.unit}</span>}
              </div>
              {item.trend && (
                <div className="flex items-center gap-0.5 mt-0.5">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className={
                      item.trend === 'up'
                        ? item.status === 'warning' || item.status === 'danger' ? 'text-mes-danger' : 'text-mes-success'
                        : item.trend === 'down'
                        ? item.status === 'warning' || item.status === 'danger' ? 'text-mes-success' : 'text-mes-danger'
                        : 'text-mes-textTertiary'
                    }
                  >
                    {item.trend === 'up' && <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />}
                    {item.trend === 'down' && <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />}
                    {item.trend === 'stable' && <line x1="5" y1="12" x2="19" y2="12" />}
                  </svg>
                  <span className="text-[10px] text-mes-textTertiary">{item.trendValue}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 bg-gray-50 border-t border-mes-border">
        <div className="flex items-center gap-1.5 text-xs text-mes-textTertiary">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          数据来源：MES 系统实时查询 · 仅读取权限 · 不可修改
        </div>
      </div>
    </div>
  )
}
