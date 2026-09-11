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
  docType: 'word' | 'ppt' | 'excel' | 'pdf' | 'web' | 'mes' | 'xml'
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
  type: 'word' | 'ppt' | 'excel' | 'pdf' | 'xml'
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
  /**
   * 正文被服务端剥离（超大文档，如 XML 数据导出）：列表接口不下发 content，
   * 仅在需要时由 GET /api/docs/:id/pages 按需取页，问答检索改由服务端倒排索引承担。
   */
  contentOmitted?: boolean
  /** contentOmitted 时的总页数（服务端下发，用于 UI 展示与翻页） */
  pageCount?: number
  aiExtracting?: boolean // AI 正在提取元数据
  aiExtracted?: boolean // AI 已完成提取
  fileType?: 'docx' | 'doc' | 'pptx' | 'ppt' | 'xlsx' | 'xls' | 'pdf' | 'xml' // 详细文件格式
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
export type SidebarView = 'chat' | 'apc' | 'knowledge' | 'usermanagement'

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

// ===== APC / RTO（先进过程控制 与 实时优化）=====

/** 过程参数实时状态 */
export type ApcParamStatus = 'normal' | 'warning' | 'danger' | 'unknown'

/** 窗口内趋势方向 */
export type ApcTrend = 'up' | 'down' | 'stable'

/** 优化建议紧急度 */
export type ApcUrgency = 'high' | 'medium' | 'low' | 'none'

/** 数据源模式：hana=实时读取 HANA 只读库；simulated=内置仿真数据 */
export type ApcSourceMode = 'hana' | 'simulated'

/** 历史数据点（列值 + 时间戳） */
export interface ApcSeriesPoint {
  t: number
  v: number
}

/** 单个过程参数的优化建议 */
export interface ApcRecommendation {
  /** 当前设定值 */
  current: number
  /** 优化后的建议设定值 */
  suggested: number
  /** 建议调整量（建议值 - 当前值） */
  delta: number
  /** 调整幅度（%） */
  deltaPct: number | null
  /** 置信度 0-100 */
  confidence: number
  urgency: ApcUrgency
  /** 是否建议保持（死区内或修正量小于最小调节步长） */
  hold: boolean
  /** 约束来源：min=可调下限 max=可调上限 step=单次调整限幅 */
  clampedBy: 'min' | 'max' | 'step' | null
  /** 预计调整后的均值 */
  predictedMean?: number
  /** 预计调整后的过程能力指数 */
  predictedCpk?: number | null
  /** 中文推荐理由（含量化依据） */
  reason: string
  /** 风险提示 */
  risk?: string
}

/** 过程参数（含统计量与优化建议） */
export interface ApcParamItem {
  code: string
  name: string
  process: string
  unit: string
  decimals: number
  /** 优化目标：quality / energy / yield / stability */
  objective: string
  objectiveLabel: string
  setpoint: number
  optimalTarget: number
  min: number
  max: number
  lsl: number
  usl: number
  maxStepPct: number
  latest: number | null
  mean: number | null
  std: number | null
  min_: number | null
  max_: number | null
  sampleCount: number
  cpk: number | null
  slope: number
  trend: ApcTrend
  status: ApcParamStatus
  series: ApcSeriesPoint[]
  recommendation: ApcRecommendation
}

/** 数据源说明 */
export interface ApcSourceInfo {
  label: string
  note: string
  simulated: boolean
}

/** 参数概览响应（GET /api/apc/overview） */
export interface ApcOverview {
  station: string
  mode: ApcSourceMode
  generatedAt: string
  elapsedMs: number
  windowMinutes: number
  sampleIntervalSec: number
  rowCount: number
  truncated: boolean
  source: ApcSourceInfo
  params: ApcParamItem[]
}

/** 优化建议响应（GET /api/apc/optimize） */
export interface ApcOptimization {
  station: string
  mode: ApcSourceMode
  generatedAt: string
  windowMinutes: number
  source: ApcSourceInfo
  summary: {
    total: number
    actionable: number
    high: number
    medium: number
    danger: number
    avgConfidence: number
  }
  items: ApcParamItem[]
}

/** HANA 只读数据源运行状态 */
export interface ApcHanaStatus {
  configured: boolean
  connected: boolean
  connecting: boolean
  host: string
  port: number
  database: string
  schema: string
  useTLS: boolean
  maxRows: number
  statementTimeoutMs: number
  lastError: string
  lastConnectAt: number | null
  lastQueryAt: number | null
  lastQueryMs: number | null
  queryCount: number
  abortedCount: number
}

/** 功能状态响应（GET /api/apc/status） */
export interface ApcStatusResponse {
  enabled: boolean
  mode: ApcSourceMode | 'unavailable'
  station: string
  paramCount: number
  /** 当前取数模式：long=窄表 / wide=宽表 / null=未配置 */
  queryMode: ApcQueryMode | null
  catalogFile: string
  /** env-file=由 APC_CATALOG_FILE 锁定；saved=种子文件 + 页面保存覆盖 */
  catalogOrigin: 'env-file' | 'saved'
  catalogFileLocked: boolean
  catalogError: string
  /** 运行期配置文件（落在数据卷，不随镜像重建丢失，且不入 git） */
  configFile: string
  configFileExists: boolean
  configFileError: string
  hana: ApcHanaStatus
}

/** 单参数历史响应（GET /api/apc/history） */
export interface ApcHistoryResponse {
  param: {
    code: string
    name: string
    process: string
    unit: string
    decimals: number
    setpoint: number
    optimalTarget: number
    lsl: number
    usl: number
    min: number
    max: number
  }
  mode: ApcSourceMode
  windowMinutes: number
  source: ApcSourceInfo
  stats: {
    n: number
    mean: number | null
    std: number | null
    min: number | null
    max: number | null
    cpk: number | null
    trend: ApcTrend
    status: ApcParamStatus
  }
  points: ApcSeriesPoint[]
}

// ===== APC / RTO 数据源配置（页面上可手工配置）=====

/**
 * 取数模式：
 *  - long（窄表）：一行一个参数值，需要「参数编码列 / 时间戳列 / 数值列」
 *  - wide（宽表）：一行一个时间戳，每个参数各占一列（列名在参数配置里逐个指定）
 */
export type ApcQueryMode = 'long' | 'wide'

/** 取数 SQL 配置 */
export interface ApcQueryConfig {
  mode: ApcQueryMode
  /** SQL 模板，可用占位符：{{minutes}} {{limit}} {{codeFilter}} {{columns}} {{schema}} */
  history: string
  columns: { code?: string; ts?: string; value?: string }
}

/** 参数配置（可编辑的完整定义，与 server/apcCatalog.js 的规范化结果一致） */
export interface ApcParamConfig {
  code: string
  name: string
  process: string
  unit: string
  decimals: number
  setpoint: number
  optimalTarget: number
  lsl: number
  usl: number
  min: number
  max: number
  maxStepPct: number
  deadbandPct: number
  objective: string
  processGain: number
  /** 宽表模式下的取值列名；窄表模式留空 */
  column?: string
  sim?: Record<string, number>
}

/** 目录元信息 */
export interface ApcCatalogMeta {
  station: string
  sampleIntervalSec: number
  defaultWindowMinutes: number
  deadbandPctDefault: number
}

/** 生效的数据库配置（**不含密码原文**） */
export interface ApcDatabaseValues {
  host: string
  port: number
  user: string
  databaseName: string
  schema: string
  useTLS: boolean
  validateCert: boolean
  caFile: string
  connectTimeoutMs: number
  statementTimeoutMs: number
  maxRows: number
  useLimit: boolean
}

/**
 * 数据库配置草稿。password 三态：
 *  - 不传 / 空字符串：保持服务端已保存的密码不变
 *  - null：显式清除密码
 *  - 非空字符串：更新为新密码
 */
export interface ApcDatabaseDraft extends Partial<ApcDatabaseValues> {
  password?: string | null
}

/** 单个数据库槽位（db1 / db2）的生效配置视图（不含密码原文） */
export interface ApcDatabaseSlot {
  id: string
  /** 界面显示名（可手工改） */
  name: string
  /** 生效的连接参数（页面保存 > 环境变量 > 默认） */
  values: ApcDatabaseValues
  /** 服务端是否已存有密码 */
  passwordSet: boolean
  /** 哪些字段来自页面保存（其余来自环境变量/默认值） */
  savedKeys: string[]
  /** 该槽位是否已配置（host + user 齐备） */
  configured: boolean
}

/** 配置读取响应（GET /api/apc/config） */
export interface ApcConfigResponse {
  configFile: string
  configFileExists: boolean
  configFileError: string
  updatedAt: string | null
  /** true 表示由 APC_CATALOG_FILE 指定目录，页面上的目录类保存不生效 */
  catalogFileLocked: boolean
  seedFile: string
  database: {
    /** 当前「正在使用」的数据库槽位 id */
    activeId: string
    /** 两个数据库系统（db1 / db2）的生效配置 */
    slots: ApcDatabaseSlot[]
    envConfigured: boolean
    envValues: Partial<ApcDatabaseValues> & { passwordSet: boolean }
    defaults: Partial<ApcDatabaseValues>
  }
  queries: ApcQueryConfig | null
  params: ApcParamConfig[]
  meta: ApcCatalogMeta | null
  catalogError: string
}

/** 配置保存补丁（按段提交，只提交改动过的段） */
export interface ApcConfigPatch {
  /** 兼容历史单库；新接口请用 databases */
  database?: ApcDatabaseDraft
  /** 按槽位保存的数据库连接（db1 / db2） */
  databases?: Record<string, ApcDatabaseDraft>
  /** 切换「正在使用」的数据库槽位 */
  activeDatabase?: string
  queries?: ApcQueryConfig
  params?: ApcParamConfig[]
  meta?: Partial<ApcCatalogMeta>
}

/** 数据库连接测试结果 */
export interface ApcTestDbResult {
  ok: boolean
  elapsedMs: number
  error?: string
  serverVersion?: string
  target: {
    host: string
    port: number
    user: string
    databaseName: string
    schema: string
    useTLS: boolean
    validateCert: boolean
  }
}

/** 取数 SQL 试运行结果 */
export interface ApcQueryPreview {
  ok: boolean
  mode: ApcQueryMode
  /** 渲染占位符之后、实际执行的 SQL */
  sql: string
  vars: Record<string, string>
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  elapsedMs: number
  warnings: string[]
}
