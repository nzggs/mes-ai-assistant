// ===== 核心类型定义 =====

/** 消息角色 */
export type MessageRole = 'user' | 'assistant'

/** 消息内容块类型 */
export type ContentType =
  | 'text'           // 普通文本/Markdown
  | 'analysisTree'   // 异常分析树
  | 'paramCard'      // 参数调优卡片
  | 'sourceList'     // 来源引用列表
  | 'mesData'        // MES 实时数据
  | 'thinking'       // 思考过程

/** 来源引用 */
export interface SourceCitation {
  docName: string
  docType: 'word' | 'ppt' | 'excel' | 'pdf' | 'web' | 'mes'
  page?: string
  section?: string
  uploader: string
  uploadDate: string
  relevance: number // 0-100
  summary: string
}

/** 分析树节点 */
export interface AnalysisTreeNode {
  id: string
  label: string
  type: 'problem' | 'cause' | 'subCause' | 'rootCause' | 'solution'
  description?: string
  confidence?: number // 0-100
  status?: 'confirmed' | 'suspected' | 'eliminated'
  children?: AnalysisTreeNode[]
  source?: string
}

/** 参数推荐项 */
export interface ParamRecommendation {
  paramName: string
  currentValue: string
  recommendedValue: string
  unit: string
  confidence: number // 0-100
  reason: string
  historicalRef?: string
  category: 'process' | 'quality' | 'timing'
}

/** MES 数据项 */
export interface MesDataItem {
  label: string
  value: string
  unit?: string
  status: 'normal' | 'warning' | 'danger'
  trend?: 'up' | 'down' | 'stable'
  trendValue?: string
}

/** 消息内容块 */
export interface MessageContent {
  type: ContentType
  // text
  text?: string
  // analysisTree
  tree?: AnalysisTreeNode
  // paramCard
  params?: ParamRecommendation[]
  // sourceList
  sources?: SourceCitation[]
  // mesData
  mesData?: {
    title: string
    items: MesDataItem[]
    queryTime: string
  }
  // thinking
  thinkingSteps?: string[]
}

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: MessageRole
  contents: MessageContent[]
  timestamp: number
  isStreaming?: boolean
}

/** 对话会话 */
export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

/** 知识库文档 */
export interface KnowledgeDoc {
  id: string
  name: string
  type: 'word' | 'ppt' | 'excel' | 'pdf'
  size: string
  uploadDate: string
  uploader: string
  uploaderName?: string // 上传人显示名称
  uploaderDepartment?: string // 上传人部门
  approvedDate?: string // 入库日期（审核通过时记录）
  status: 'pending' | 'approved' | 'rejected'
  keywords: string[]
  background: string
  causeAnalysis: string
  solution: string
  summary: string
  chunks: number
  pages: number
  content: DocPage[]
  pdfUrl?: string // PDF 文件的 URL（仅 pdf 类型）
  fileUrl?: string // 非 PDF 文件的 Object URL（word/ppt/excel）
  textContent?: string // 提取的全文文本（用于AI检索引用）
  aiExtracting?: boolean // AI 正在提取元数据
  aiExtracted?: boolean // AI 已完成提取
  fileType?: 'docx' | 'doc' | 'pptx' | 'ppt' | 'xlsx' | 'xls' | 'pdf' // 详细文件格式
  /** 整表/整文档 AI 总结缓存（map-reduce 生成并持久化；contentHash 用于内容变更失效） */
  tableSummaries?: { [sheetKey: string]: TableSummary }
  /** 总结生成的可检索切片（整表/整文档总结落库时自动切分生成，纳入普通检索，使总结内容可被常规问答召回） */
  summaryChunks?: SummaryChunk[]
}

/** 总结的可检索切片条目 */
export interface SummaryChunk {
  /** 来源范围键：FULL_DOC_SUMMARY_KEY（整篇）或标签页名 */
  sheetKey: string
  /** 检索展示标签，如《文档》标签页「X」AI 总结 */
  label: string
  /** 切片文本 */
  text: string
}

/** 整表/整文档总结缓存条目 */
export interface TableSummary {
  text: string
  updatedAt: number
  /** 生成时文档内容的哈希，内容变更后不匹配即视为过期需重算 */
  contentHash: string
}

/** 知识库操作日志：记录上传/删除/审核/总结的人员与时间 */
export interface DocLog {
  id: string
  /** upload=上传, delete=删除, approve=审核通过, reject=审核拒绝, summary=整篇/整表总结 */
  action: 'upload' | 'delete' | 'approve' | 'reject' | 'summary'
  operator: string // 操作用户名
  operatorName?: string // 操作人姓名
  department?: string // 操作人部门
  target?: string // 操作对象（文档名 / 文档名 · 标签页X）
  detail?: string // 补充说明
  time: string // ISO 时间戳
}

/** 文档页面内容（用于原文阅读） */
export interface DocPage {
  pageNum: number
  title: string
  paragraphs: string[]
}

/** 预设问题 */
export interface PresetQuestion {
  icon: string
  category: string
  question: string
  description: string
}

/** 侧边栏视图 */
export type SidebarView = 'chat' | 'knowledge' | 'usermanagement'

/** 知识图谱节点类型 */
export type GraphNodeType = 'equipment' | 'process' | 'product' | 'quality' | 'personnel' | 'material' | 'document'

/** 知识图谱节点 */
export interface GraphNode {
  id: string
  label: string
  type: GraphNodeType
  description?: string
  properties?: { key: string; value: string }[]
}

/** 知识图谱关系 */
export interface GraphEdge {
  source: string
  target: string
  label: string
  description?: string
}

/** 知识图谱数据 */
export interface KnowledgeGraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}
