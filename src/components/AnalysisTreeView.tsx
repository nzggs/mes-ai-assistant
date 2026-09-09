import { useState } from 'react'
import type { AnalysisTreeNode } from '../types'

interface AnalysisTreeViewProps {
  tree: AnalysisTreeNode
}

const nodeConfig: Record<AnalysisTreeNode['type'], {
  label: string
  color: string
  bg: string
  border: string
  icon: string
}> = {
  problem: { label: '问题', color: '#dc2626', bg: '#fef2f2', border: '#fecaca', icon: '⚠️' },
  cause: { label: '可能原因', color: '#ea580c', bg: '#fff7ed', border: '#fed7aa', icon: '🔍' },
  subCause: { label: '细分原因', color: '#ca8a04', bg: '#fefce8', border: '#fef08a', icon: '📌' },
  rootCause: { label: '根因', color: '#7c3aed', bg: '#faf5ff', border: '#ddd6fe', icon: '🎯' },
  solution: { label: '解决方案', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', icon: '✅' },
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  confirmed: { label: '已确认', color: '#16a34a', bg: '#dcfce7' },
  suspected: { label: '疑似', color: '#ca8a04', bg: '#fef9c3' },
  eliminated: { label: '已排除', color: '#6b7280', bg: '#f3f4f6' },
}

export function AnalysisTreeView({ tree }: AnalysisTreeViewProps) {
  return (
    <div className="my-3 rounded-xl border border-mes-border bg-white p-4 overflow-x-auto animate-slide-up">
      <div className="flex items-center gap-2 mb-4">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-primary">
          <rect x="2" y="2" width="7" height="7" rx="1" />
          <rect x="15" y="2" width="7" height="7" rx="1" />
          <rect x="8" y="15" width="8" height="7" rx="1" />
          <path d="M5.5 9v3a2 2 0 0 0 2 2h4" />
          <path d="M18.5 9v3a2 2 0 0 1-2 2h-4" />
        </svg>
        <span className="text-sm font-semibold text-mes-text">异常分析决策树</span>
        <span className="text-xs text-mes-textTertiary">· 多源数据融合分析</span>
      </div>

      <TreeNode node={tree} depth={0} isLast={true} />
    </div>
  )
}

function TreeNode({ node, depth, isLast }: { node: AnalysisTreeNode; depth: number; isLast: boolean }) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children && node.children.length > 0
  const config = nodeConfig[node.type]
  const status = node.status ? statusConfig[node.status] : null

  return (
    <div className="relative">
      {/* 连接线 */}
      {depth > 0 && (
        <div className="absolute -left-4 top-0 bottom-0 w-4">
          {!isLast && <div className="absolute left-3 top-0 bottom-0 w-px bg-mes-border" />}
          <div className="absolute left-3 top-4 w-3 h-px bg-mes-border" />
          <div className="absolute left-3 top-4 w-px h-4 bg-mes-border" />
        </div>
      )}

      {/* 节点卡片 */}
      <div
        className={`relative rounded-lg border-2 px-3 py-2.5 mb-2 transition-all-smooth ${config.border} ${config.bg}`}
        style={{ marginLeft: depth > 0 ? '16px' : '0' }}
      >
        <div className="flex items-start gap-2">
          {/* 展开/折叠按钮 */}
          {hasChildren && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-white/50 transition-colors"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className={`text-mes-textSecondary transition-transform ${expanded ? 'rotate-90' : ''}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}

          <div className="flex-1 min-w-0">
            {/* 标签行 */}
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span className="text-xs font-medium px-1.5 py-0.5 rounded" style={{ color: config.color, backgroundColor: 'rgba(255,255,255,0.6)' }}>
                {config.icon} {config.label}
              </span>
              {status && (
                <span className="text-xs font-medium px-1.5 py-0.5 rounded" style={{ color: status.color, backgroundColor: status.bg }}>
                  {status.label}
                </span>
              )}
              {node.confidence !== undefined && (
                <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-white/60 text-mes-textSecondary">
                  置信度 {node.confidence}%
                </span>
              )}
            </div>

            {/* 节点标题 */}
            <p className="text-sm font-medium text-mes-text mb-0.5">
              {node.label}
            </p>

            {/* 描述 */}
            {node.description && (
              <p className="text-xs text-mes-textSecondary leading-relaxed">
                {node.description}
              </p>
            )}

            {/* 数据来源 */}
            {node.source && (
              <div className="flex items-center gap-1 mt-1.5 text-xs text-mes-textTertiary">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                  <path d="M3 12h12" />
                  <circle cx="20" cy="12" r="1" fill="currentColor" />
                </svg>
                <span className="italic">来源：{node.source}</span>
              </div>
            )}
          </div>

          {/* 置信度指示器 */}
          {node.confidence !== undefined && (
            <div className="shrink-0 flex flex-col items-center">
              <div className="relative w-9 h-9">
                <svg className="w-9 h-9 -rotate-90" viewBox="0 0 36 36">
                  <circle cx="18" cy="18" r="15" fill="none" stroke="#e5e5e5" strokeWidth="3" />
                  <circle
                    cx="18" cy="18" r="15" fill="none"
                    stroke={node.confidence >= 80 ? '#22c55e' : node.confidence >= 50 ? '#f59e0b' : '#ef4444'}
                    strokeWidth="3"
                    strokeDasharray={`${(node.confidence / 100) * 94.2} 94.2`}
                    strokeLinecap="round"
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-mes-text">
                  {node.confidence}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 子节点 */}
      {hasChildren && expanded && (
        <div className="relative">
          {node.children!.map((child, idx) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              isLast={idx === node.children!.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}
