import { mockMesData } from '../data/mockData'

export function MesDataPanel() {
  const equipmentList = [
    { id: 'W-01', name: '卷绕机', status: 'running', oee: 92.3, product: 'PD-CELL' },
    { id: 'L-02', name: '注液机', status: 'running', oee: 88.7, product: 'PD-CELL' },
    { id: 'F-01', name: '分容柜', status: 'idle', oee: 0, product: '-' },
    { id: 'F-03', name: '化成柜', status: 'error', oee: 0, product: 'PD-CELL' },
  ]

  const lineList = [
    { name: 'A线', oee: 85.7, yield: 96.8, output: 18642, status: 'normal' },
    { name: 'B线', oee: 82.1, yield: 95.2, output: 15620, status: 'normal' },
    { name: 'C线', oee: 78.4, yield: 93.6, output: 12840, status: 'warning' },
  ]

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* 页面标题 */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-mes-text mb-1">MES 数据概览</h1>
          <p className="text-sm text-mes-textSecondary">
            实时生产数据 · 设备状态 · 关键指标 · 只读查询模式
          </p>
        </div>

        {/* 概览数据 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {mockMesData.items.slice(0, 8).map((item, idx) => (
            <div key={idx} className="rounded-xl border border-mes-border bg-white p-4">
              <p className="text-xs text-mes-textSecondary mb-1">{item.label}</p>
              <div className="flex items-baseline gap-1">
                <span className={`text-xl font-bold ${
                  item.status === 'normal' ? 'text-mes-text' :
                  item.status === 'warning' ? 'text-mes-warning' : 'text-mes-danger'
                }`}>
                  {item.value}
                </span>
                {item.unit && <span className="text-xs text-mes-textTertiary">{item.unit}</span>}
              </div>
              {item.trendValue && (
                <p className="text-xs text-mes-textTertiary mt-0.5">{item.trendValue}</p>
              )}
            </div>
          ))}
        </div>

        {/* 产线概览 */}
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-mes-text mb-3 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-primary">
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            </svg>
            产线概览
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {lineList.map((line, idx) => (
              <div key={idx} className="rounded-xl border border-mes-border bg-white p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-mes-text">{line.name}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    line.status === 'normal'
                      ? 'bg-green-50 text-mes-success'
                      : 'bg-yellow-50 text-mes-warning'
                  }`}>
                    {line.status === 'normal' ? '运行正常' : '需关注'}
                  </span>
                </div>
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="text-mes-textTertiary">OEE</span>
                      <span className="font-medium text-mes-text">{line.oee}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${line.oee}%`,
                          backgroundColor: line.oee >= 85 ? '#22c55e' : line.oee >= 75 ? '#f59e0b' : '#ef4444'
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="text-mes-textTertiary">良率</span>
                      <span className="font-medium text-mes-text">{line.yield}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${line.yield}%`,
                          backgroundColor: line.yield >= 95 ? '#22c55e' : '#f59e0b'
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs pt-1 border-t border-mes-border">
                    <span className="text-mes-textTertiary">产出</span>
                    <span className="font-medium text-mes-text">{line.output.toLocaleString()} 件</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 设备状态 */}
        <div>
          <h2 className="text-sm font-semibold text-mes-text mb-3 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-primary">
              <rect x="2" y="2" width="20" height="8" rx="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
            设备状态
          </h2>
          <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-mes-border">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-mes-textSecondary">设备编号</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-mes-textSecondary">设备名称</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-mes-textSecondary">状态</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-mes-textSecondary">OEE</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-mes-textSecondary">当前产品</th>
                </tr>
              </thead>
              <tbody>
                {equipmentList.map((eq, idx) => (
                  <tr key={idx} className="border-b border-mes-border last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5 text-mes-text font-mono text-xs">{eq.id}</td>
                    <td className="px-4 py-2.5 text-mes-text">{eq.name}</td>
                    <td className="px-4 py-2.5">
                      <span className={`flex items-center gap-1 text-xs font-medium ${
                        eq.status === 'running' ? 'text-mes-success' :
                        eq.status === 'idle' ? 'text-mes-textTertiary' : 'text-mes-danger'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          eq.status === 'running' ? 'bg-mes-success animate-pulse' :
                          eq.status === 'idle' ? 'bg-gray-400' : 'bg-mes-danger animate-pulse'
                        }`} />
                        {eq.status === 'running' ? '运行中' : eq.status === 'idle' ? '空闲' : '故障'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-mes-text">{eq.oee > 0 ? `${eq.oee}%` : '-'}</td>
                    <td className="px-4 py-2.5 text-mes-textSecondary font-mono text-xs">{eq.product}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 底部提示 */}
        <div className="mt-6 flex items-center gap-2 text-xs text-mes-textTertiary bg-cyan-50 rounded-lg p-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-600 shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>
            数据来源：MES 系统实时数据库 · 仅读取权限 · 所有查询操作记录审计日志 · 不可修改生产数据
          </span>
        </div>
      </div>
    </div>
  )
}
