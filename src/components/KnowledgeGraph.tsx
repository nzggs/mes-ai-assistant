import { useState, useMemo, useRef } from 'react'
import { mockKnowledgeGraph } from '../data/mockData'
import type { GraphNode, GraphNodeType, KnowledgeDoc } from '../types'

// 节点类型配置
const nodeTypeConfig: Record<GraphNodeType, { label: string; color: string; bg: string; icon: string }> = {
  equipment: { label: '设备', color: '#0891b2', bg: '#ecfeff', icon: '🔧' },
  process: { label: '工序', color: '#2563eb', bg: '#eff6ff', icon: '⚙️' },
  product: { label: '产品', color: '#7c3aed', bg: '#faf5ff', icon: '📦' },
  quality: { label: '质量问题', color: '#dc2626', bg: '#fef2f2', icon: '⚠️' },
  personnel: { label: '人员', color: '#ea580c', bg: '#fff7ed', icon: '👤' },
  material: { label: '物料/零部件', color: '#16a34a', bg: '#f0fdf4', icon: '🔩' },
  document: { label: '文档', color: '#6b7280', bg: '#f9fafb', icon: '📄' },
}

// 预计算节点位置（分层布局）
const nodePositions: Record<string, { x: number; y: number }> = {
  // 设备 (x=100)
  'eq-winding': { x: 100, y: 100 },
  'eq-filling': { x: 100, y: 260 },
  'eq-formation': { x: 100, y: 420 },
  // 工序 (x=320)
  'pr-mix': { x: 320, y: 40 },
  'pr-coat': { x: 320, y: 140 },
  'pr-roll': { x: 320, y: 240 },
  'pr-winding': { x: 320, y: 340 },
  'pr-filling': { x: 320, y: 440 },
  'pr-formation': { x: 320, y: 540 },
  'pr-grading': { x: 320, y: 640 },
  // 产品 (x=540)
  'pd-cell': { x: 540, y: 300 },
  'pd-pack': { x: 540, y: 460 },
  // 质量问题 (x=760)
  'qa-swelling': { x: 760, y: 120 },
  'qa-capacity': { x: 760, y: 280 },
  'qa-impedance': { x: 760, y: 440 },
  // 物料 (x=540, 偏下)
  'm-electrolyte': { x: 540, y: 140 },
  'm-separator': { x: 540, y: 200 },
  'm-ncm': { x: 540, y: 240 },
  'm-graphite': { x: 540, y: 280 },
  // 人员 (x=980)
  'p-wang': { x: 980, y: 100 },
  'p-li': { x: 980, y: 240 },
  'p-chen': { x: 980, y: 380 },
  // 文档 (x=980, 偏下) - 预设位置
  'd-swelling': { x: 980, y: 150 },
  'd-formation': { x: 980, y: 260 },
  'd-safety': { x: 980, y: 370 },
  'd-spec': { x: 980, y: 480 },
}

// mock 文档名到图谱节点 ID 的映射
const docNameToNodeId: Record<string, string> = {
  '聚合物锂电池电芯胀气异常分析报告.docx': 'd-swelling',
  '消费类聚合物电池化成工艺参数优化研究报告.pptx': 'd-formation',
  '便携式电子产品用锂离子电池安全技术规范.pdf': 'd-safety',
  '锂离子电池电芯规格书.pdf': 'd-spec',
}

interface KnowledgeGraphProps {
  documents?: KnowledgeDoc[]
}

export function KnowledgeGraph({ documents }: KnowledgeGraphProps) {
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [hoveredNode, setSelectedHovered] = useState<string | null>(null)
  const [activeTypes, setActiveTypes] = useState<Set<GraphNodeType>>(new Set())
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const svgRef = useRef<SVGSVGElement>(null)
  const isDragging = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })

  // 基于当前文档列表动态构建图谱数据
  const { nodes, edges, dynamicPositions } = useMemo(() => {
    const baseNodes = mockKnowledgeGraph.nodes
    const baseEdges = mockKnowledgeGraph.edges

    // 非文档节点始终保留
    const nonDocNodes = baseNodes.filter(n => n.type !== 'document')
    const docNodes = baseNodes.filter(n => n.type === 'document')

    // 确定哪些文档节点应该显示
    const visibleDocNodes: GraphNode[] = []
    const dynamicPos: Record<string, { x: number; y: number }> = {}

    if (documents && documents.length > 0) {
      // 按文档列表过滤：预设文档节点 + 上传的新文档
      let docY = 220
      documents.forEach(doc => {
        const presetNodeId = docNameToNodeId[doc.name]
        if (presetNodeId) {
          // 预设文档节点，使用预设位置
          const existingNode = docNodes.find(n => n.id === presetNodeId)
          if (existingNode) {
            visibleDocNodes.push(existingNode)
            dynamicPos[presetNodeId] = nodePositions[presetNodeId]
          }
        } else {
          // 新上传的文档，生成动态节点
          const nodeId = `d-upload-${doc.id}`
          const shortName = doc.name.length > 8 ? doc.name.slice(0, 7) + '…' : doc.name
          visibleDocNodes.push({
            id: nodeId,
            label: shortName,
            type: 'document',
            description: doc.name,
          })
          // 动态位置：x=980, y 从 520 开始递增
          dynamicPos[nodeId] = { x: 980, y: docY + 60 }
          docY += 55
        }
      })
    } else {
      // 没有传入 documents，使用全部预设文档节点
      docNodes.forEach(n => {
        visibleDocNodes.push(n)
        dynamicPos[n.id] = nodePositions[n.id]
      })
    }

    const allNodes = [...nonDocNodes, ...visibleDocNodes]
    const visibleNodeIds = new Set(allNodes.map(n => n.id))

    // 过滤边：只保留两端节点都存在的边
    const visibleEdges = baseEdges.filter(
      e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    )

    // 为非文档节点添加预设位置
    nonDocNodes.forEach(n => {
      if (nodePositions[n.id]) {
        dynamicPos[n.id] = nodePositions[n.id]
      }
    })

    return { nodes: allNodes, edges: visibleEdges, dynamicPositions: dynamicPos }
  }, [documents])

  // 动态计算 SVG 高度（确保所有节点可见）
  const svgHeight = useMemo(() => {
    let maxY = 580
    Object.values(dynamicPositions).forEach(pos => {
      if (pos.y > maxY - 30) maxY = pos.y + 60
    })
    return Math.max(580, maxY)
  }, [dynamicPositions])

  // 过滤节点
  const visibleNodes = useMemo(() => {
    if (activeTypes.size === 0) return nodes
    return nodes.filter(n => activeTypes.has(n.type))
  }, [nodes, activeTypes])

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map(n => n.id)), [visibleNodes])

  // 过滤边
  const visibleEdges = useMemo(() => {
    return edges.filter(e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target))
  }, [edges, visibleNodeIds])

  // 选中节点的关联边
  const highlightedEdges = useMemo(() => {
    if (!selectedNode && !hoveredNode) return new Set<string>()
    const targetId = hoveredNode || selectedNode?.id
    if (!targetId) return new Set<string>()
    const result = new Set<string>()
    edges.forEach((e, idx) => {
      if (e.source === targetId || e.target === targetId) {
        result.add(`${idx}`)
      }
    })
    return result
  }, [edges, selectedNode, hoveredNode])

  const toggleType = (type: GraphNodeType) => {
    setActiveTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // 拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return
    const dx = e.clientX - lastMouse.current.x
    const dy = e.clientY - lastMouse.current.y
    setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }))
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }

  const handleMouseUp = () => {
    isDragging.current = false
  }

  // 缩放
  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setZoom(prev => Math.max(0.5, Math.min(2, prev + delta)))
  }

  // 统计
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    nodes.forEach(n => {
      counts[n.type] = (counts[n.type] || 0) + 1
    })
    return counts
  }, [nodes])

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div className="shrink-0 px-6 py-3 border-b border-mes-border bg-white">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-mes-text">知识图谱</h1>
            <p className="text-xs text-mes-textSecondary">
              {nodes.length} 个实体 · {edges.length} 条关系 · 设备-工序-产品-质量-人员-物料-文档关联网络
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* 缩放控制 */}
            <button
              onClick={() => setZoom(prev => Math.min(2, prev + 0.2))}
              className="p-1.5 rounded-lg border border-mes-border hover:bg-gray-50 text-mes-textSecondary"
              title="放大"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
            <span className="text-xs text-mes-textTertiary w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom(prev => Math.max(0.5, prev - 0.2))}
              className="p-1.5 rounded-lg border border-mes-border hover:bg-gray-50 text-mes-textSecondary"
              title="缩小"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
            <div className="w-px h-5 bg-mes-border mx-1" />
            <button
              onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}
              className="px-2.5 py-1.5 rounded-lg border border-mes-border hover:bg-gray-50 text-xs text-mes-textSecondary font-medium"
              title="重置视图"
            >
              重置
            </button>
          </div>
        </div>

        {/* 类型过滤器 */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-mes-textTertiary">实体类型：</span>
          {(Object.keys(nodeTypeConfig) as GraphNodeType[]).map(type => {
            const config = nodeTypeConfig[type]
            const isActive = activeTypes.size === 0 || activeTypes.has(type)
            const count = typeCounts[type] || 0
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all-smooth ${
                  isActive
                    ? 'border-2'
                    : 'border border-mes-border opacity-40 hover:opacity-70'
                }`}
                style={{
                  borderColor: isActive ? config.color : undefined,
                  backgroundColor: isActive ? config.bg : undefined,
                  color: isActive ? config.color : undefined,
                }}
              >
                <span>{config.icon}</span>
                {config.label}
                <span className="text-[10px] opacity-60">({count})</span>
              </button>
            )
          })}
          {activeTypes.size > 0 && (
            <button
              onClick={() => setActiveTypes(new Set())}
              className="text-xs text-mes-primary hover:underline ml-1"
            >
              清除筛选
            </button>
          )}
        </div>
      </div>

      {/* 图谱画布 + 详情面板 */}
      <div className="flex-1 flex overflow-hidden">
        {/* SVG 画布 */}
        <div
          className="flex-1 overflow-hidden bg-gray-50 relative cursor-grab active:cursor-grabbing"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <svg
            ref={svgRef}
            className="w-full h-full"
            viewBox={`0 0 1100 ${svgHeight}`}
            onWheel={handleWheel}
            style={{ transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`, transformOrigin: 'center center' }}
          >
            {/* 定义箭头标记 */}
            <defs>
              <marker
                id="arrowhead"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#cbd5e1" />
              </marker>
              <marker
                id="arrowhead-active"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#4d6bfe" />
              </marker>
            </defs>

            {/* 绘制边 */}
            {visibleEdges.map((edge, idx) => {
              const sourcePos = dynamicPositions[edge.source]
              const targetPos = dynamicPositions[edge.target]
              if (!sourcePos || !targetPos) return null

              const isActive = highlightedEdges.has(`${idx}`)
              const midX = (sourcePos.x + targetPos.x) / 2
              const midY = (sourcePos.y + targetPos.y) / 2

              // 计算偏移以避免箭头被节点遮挡
              const dx = targetPos.x - sourcePos.x
              const dy = targetPos.y - sourcePos.y
              const len = Math.sqrt(dx * dx + dy * dy)
              const offset = 32
              const targetX = targetPos.x - (dx / len) * offset
              const targetY = targetPos.y - (dy / len) * offset
              const sourceX = sourcePos.x + (dx / len) * offset
              const sourceY = sourcePos.y + (dy / len) * offset

              return (
                <g key={idx}>
                  <line
                    x1={sourceX}
                    y1={sourceY}
                    x2={targetX}
                    y2={targetY}
                    stroke={isActive ? '#4d6bfe' : '#cbd5e1'}
                    strokeWidth={isActive ? 2 : 1}
                    strokeDasharray={isActive ? 'none' : '4 2'}
                    markerEnd={`url(#${isActive ? 'arrowhead-active' : 'arrowhead'})`}
                    className="transition-all"
                  />
                  {(isActive || zoom > 1.2) && (
                    <text
                      x={midX}
                      y={midY - 4}
                      textAnchor="middle"
                      className="text-[9px] fill-mes-textSecondary pointer-events-none"
                      style={{ fontSize: '9px', fill: isActive ? '#4d6bfe' : '#94a3b8' }}
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              )
            })}

            {/* 绘制节点 */}
            {visibleNodes.map(node => {
              const pos = dynamicPositions[node.id]
              if (!pos) return null
              const config = nodeTypeConfig[node.type]
              const isSelected = selectedNode?.id === node.id
              const isHovered = hoveredNode === node.id
              const isHighlighted = hoveredNode === node.id ||
                (hoveredNode && edges.some(e =>
                  (e.source === hoveredNode && e.target === node.id) ||
                  (e.target === hoveredNode && e.source === node.id)
                )) ||
                (selectedNode && edges.some(e =>
                  (e.source === selectedNode.id && e.target === node.id) ||
                  (e.target === selectedNode.id && e.source === node.id)
                ))

              const radius = isSelected ? 26 : isHovered ? 24 : 22
              const opacity = (selectedNode || hoveredNode) && !isHighlighted && !isSelected ? 0.3 : 1

              return (
                <g
                  key={node.id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  className="cursor-pointer transition-all"
                  style={{ opacity }}
                  onClick={() => setSelectedNode(isSelected ? null : node)}
                  onMouseEnter={() => setSelectedHovered(node.id)}
                  onMouseLeave={() => setSelectedHovered(null)}
                >
                  {/* 外圈光晕（选中/悬停时） */}
                  {(isSelected || isHovered) && (
                    <circle
                      r={radius + 6}
                      fill={config.color}
                      opacity={0.15}
                    />
                  )}
                  {/* 节点圆形 */}
                  <circle
                    r={radius}
                    fill={config.bg}
                    stroke={config.color}
                    strokeWidth={isSelected ? 3 : 2}
                  />
                  {/* 节点图标 */}
                  <text
                    textAnchor="middle"
                    dy="2"
                    style={{ fontSize: '16px' }}
                  >
                    {config.icon}
                  </text>
                  {/* 节点标签 */}
                  <text
                    textAnchor="middle"
                    y={radius + 14}
                    style={{
                      fontSize: '10px',
                      fontWeight: isSelected ? '600' : '400',
                      fill: isSelected ? config.color : '#475569',
                    }}
                  >
                    {node.label}
                  </text>
                </g>
              )
            })}
          </svg>

          {/* 图例 */}
          <div className="absolute bottom-3 left-3 bg-white/90 backdrop-blur rounded-lg border border-mes-border p-2.5 shadow-sm">
            <p className="text-xs font-medium text-mes-textSecondary mb-1.5">实体类型</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {(Object.keys(nodeTypeConfig) as GraphNodeType[]).map(type => {
                const config = nodeTypeConfig[type]
                return (
                  <div key={type} className="flex items-center gap-1.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: config.color }}
                    />
                    <span className="text-[10px] text-mes-textSecondary">{config.label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 操作提示 */}
          <div className="absolute bottom-3 right-3 bg-white/90 backdrop-blur rounded-lg border border-mes-border px-3 py-1.5 shadow-sm">
            <p className="text-[10px] text-mes-textTertiary">
              拖拽平移 · 滚轮缩放 · 点击节点查看详情
            </p>
          </div>
        </div>

        {/* 右侧详情面板 */}
        {selectedNode ? (
          <div className="w-80 shrink-0 border-l border-mes-border bg-white overflow-y-auto animate-fade-in">
            <NodeDetailPanel
              node={selectedNode}
              edges={edges}
              nodes={nodes}
              onSelectNode={(n) => setSelectedNode(n)}
              onClose={() => setSelectedNode(null)}
            />
          </div>
        ) : (
          <div className="w-80 shrink-0 border-l border-mes-border bg-white flex flex-col items-center justify-center text-center p-6">
            <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-3">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-mes-textTertiary">
                <circle cx="12" cy="12" r="2" />
                <circle cx="5" cy="5" r="2" />
                <circle cx="19" cy="5" r="2" />
                <circle cx="5" cy="19" r="2" />
                <circle cx="19" cy="19" r="2" />
                <line x1="6.5" y1="6.5" x2="10.5" y2="10.5" />
                <line x1="17.5" y1="6.5" x2="13.5" y2="10.5" />
                <line x1="6.5" y1="17.5" x2="10.5" y2="13.5" />
                <line x1="17.5" y1="17.5" x2="13.5" y2="13.5" />
              </svg>
            </div>
            <p className="text-sm font-medium text-mes-textSecondary mb-1">点击节点查看详情</p>
            <p className="text-xs text-mes-textTertiary">
              选择图谱中的任意节点，查看实体属性和关联关系
            </p>
            <div className="mt-6 w-full space-y-2">
              <div className="rounded-lg bg-gradient-to-br from-blue-50 to-purple-50 p-3">
                <p className="text-xs font-medium text-purple-700 mb-1">💡 知识图谱能力</p>
                <p className="text-[11px] text-mes-textSecondary leading-relaxed">
                  支持跨系统根因追溯：设备 → 工序 → 质量 → 物料 → 文档，实现多维度关联分析
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// 节点详情面板
function NodeDetailPanel({
  node,
  edges,
  nodes,
  onSelectNode,
  onClose,
}: {
  node: GraphNode
  edges: { source: string; target: string; label: string; description?: string }[]
  nodes: GraphNode[]
  onSelectNode: (node: GraphNode) => void
  onClose: () => void
}) {
  const config = nodeTypeConfig[node.type]

  // 关联节点
  const relations = edges
    .filter(e => e.source === node.id || e.target === node.id)
    .map(e => {
      const otherId = e.source === node.id ? e.target : e.source
      const otherNode = nodes.find(n => n.id === otherId)
      const direction = e.source === node.id ? 'out' : 'in'
      return { ...e, otherNode, direction }
    })
    .filter(r => r.otherNode)

  return (
    <div className="p-5">
      {/* 头部 */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
            style={{ backgroundColor: config.bg, border: `2px solid ${config.color}` }}
          >
            {config.icon}
          </div>
          <div>
            <h2 className="text-base font-bold text-mes-text">{node.label}</h2>
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ color: config.color, backgroundColor: config.bg }}
            >
              {config.label}
            </span>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 描述 */}
      {node.description && (
        <div className="mb-4 p-3 rounded-lg bg-gray-50">
          <p className="text-sm text-mes-textSecondary leading-relaxed">{node.description}</p>
        </div>
      )}

      {/* 属性 */}
      {node.properties && node.properties.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-mes-textSecondary mb-2 flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            实体属性
          </h3>
          <div className="space-y-1.5">
            {node.properties.map((prop, idx) => (
              <div key={idx} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-gray-50">
                <span className="text-xs text-mes-textTertiary">{prop.key}</span>
                <span className="text-xs font-medium text-mes-text">{prop.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 关联关系 */}
      <div>
        <h3 className="text-xs font-semibold text-mes-textSecondary mb-2 flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 6v12m0-12l-4 4m4-4l4 4" transform="rotate(90 12 12)" />
          </svg>
          关联关系 ({relations.length})
        </h3>
        <div className="space-y-2">
          {relations.map((rel, idx) => {
            if (!rel.otherNode) return null
            const otherConfig = nodeTypeConfig[rel.otherNode.type]
            return (
              <button
                key={idx}
                onClick={() => onSelectNode(rel.otherNode!)}
                className="w-full flex items-center gap-2 p-2.5 rounded-lg border border-mes-border hover:border-mes-primary hover:bg-mes-tagBg/30 transition-all-smooth text-left group"
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0"
                  style={{ backgroundColor: otherConfig.bg }}
                >
                  {otherConfig.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-medium text-mes-text truncate">{rel.otherNode.label}</span>
                    <span className="text-[10px] text-mes-textTertiary shrink-0">{otherConfig.label}</span>
                  </div>
                  <span className="text-[10px] text-mes-textTertiary">
                    {rel.direction === 'out' ? '→' : '←'} {rel.label}
                  </span>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-textTertiary group-hover:text-mes-primary shrink-0">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
