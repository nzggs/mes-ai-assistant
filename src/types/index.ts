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
  docType: 'word' | 'ppt' | 'excel' | 'pdf' | 'web' | 'mes' | 'xml' | 'txt' | 'md' | 'csv'
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
  type: 'word' | 'ppt' | 'excel' | 'pdf' | 'xml' | 'txt' | 'md' | 'csv'
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
  fileType?: 'docx' | 'doc' | 'pptx' | 'ppt' | 'xlsx' | 'xls' | 'pdf' | 'xml' | 'txt' | 'md' | 'csv' // 详细文件格式
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
export type SidebarView = 'chat' | 'apc' | 'knowledge' | 'usermanagement' | 'dbmanage'

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

/** 数据源模式：hana=实时读取 HANA 只读库；unconfigured=未配置数据源（不展示任何数据） */
export type ApcSourceMode = 'hana' | 'unconfigured'

/** 历史数据点（列值 + 时间戳） */
export interface ApcSeriesPoint {
  t: number
  v: number
  /**
   * 该点所在数据行解析出的规格上下限。**仅当规格写成列名表达式时才有值**
   * （规格是固定数字时用参数级的 lsl/usl 画横线即可，无需逐点重复下发）。
   */
  lsl?: number
  usl?: number
  /** 该点相对其所在行规格的偏离方向（仅表达式规格时下发，用于前端高亮） */
  direction?: 'in' | 'low' | 'high' | 'unknown'
}

/** 规格表达式的解析情况 */
export interface ApcSpecResolved {
  /** 6 个规格字段是否都求值成功；false 时页面按「未知」展示并给出 errors */
  ok: boolean
  errors: string[]
  /** 写成表达式的字段 → 原始表达式文本（如 { usl: 'USL_COL - 1' }） */
  expressions: Record<string, string>
  /** 表达式引用到的列名（宽表会自动并入取数列） */
  columns: string[]
}

/** 点级超规格摘要（基于**全量**数据点统计，不受趋势图降采样影响） */
export interface ApcPointDeviation {
  n: number
  outOfSpec: number
  outLow: number
  outHigh: number
  worst: {
    t: number
    v: number
    lsl?: number
    usl?: number
    deviation: number
    direction: 'low' | 'high'
  } | null
}

/**
 * 影响系数 k = ∂CV/∂MVᵢ（输出结果随该参数变化的灵敏度）。
 * 缺省 value = 0 ＝「尚未标定」：运行期该参数被排除出求解集并明确提示，但**不阻断保存**
 * （现场通常要先跑起来拿到数据，才谈得上标定）。
 * 手工填写与自动标定共用同一字段，`mode` 只记录来源，`calibrated` 留档供回溯。
 */
export interface ApcGain {
  mode: 'manual' | 'calibrated'
  value: number
  calibrated?: { value: number; r2: number; n: number; at: string; method: string }
}

/** 规格类字段：数字，或**取数结果列名表达式**（如 `USL_COL - 1`，逐行求值） */
export type ApcSpecValue = number | string

/** 输出结果 CV 的规格 */
export interface ApcOutputSpec {
  lsl: ApcSpecValue
  usl: ApcSpecValue
  /** RTO 理想操作点；缺省时运行期取 (lsl+usl)/2 */
  target: ApcSpecValue | null
}

/** 输出结果 CV —— 多对 1 调优里唯一的被控量 */
export interface ApcItemOutput {
  code: string
  name: string
  unit: string
  decimals: number
  /** 取数 SQL 结果中承载 CV 实测值的列名（宽表下取值的唯一依据） */
  column: string
  /** 优化目标：quality / energy / yield / stability */
  objective: string
  spec: ApcOutputSpec
}

/** 参与参数 MV —— 与 CV 同一行的各自一列；量程与单位由界面手动配置 */
export interface ApcItemParam {
  code: string
  name: string
  process: string
  unit: string
  decimals: number
  /** 取数 SQL 结果中承载该参数值的列名 */
  column: string
  min: ApcSpecValue
  max: ApcSpecValue
  /** 当前设定值；留空（null）时运行期退回该参数窗口内的实测均值作为工作点 */
  setpoint: number | null
  /** 单次调整幅度上限（%） */
  maxStepPct: number
  /** 调整阻力 w：越大越不愿意动（易损件 / 影响其它指标 / 能耗敏感），量纲由求解器归一 */
  weight: number
  /** 停用后不参与调优 */
  enabled: boolean
  k: ApcGain
}

/**
 * 调优策略。
 * `deadbandPct` **不可删**：偏差落在死区内且过程能力正常时，调整收益低于扰动成本，
 * 「不动」本身就是最优决策——这是 RTO 与「自动追目标」的分界线。
 */
export interface ApcItemTuning {
  deadbandPct: number
  /** 约束重新分摊的最大轮数 */
  maxRounds: number
  /** 残余偏差容忍度（占原偏差百分比），超过则在风险提示里说明 */
  residualTolerancePct: number
}

/**
 * 监测项 —— 多对 1 调优的基本单位。
 * 一条取数 SQL 把 CV 与全部 MV 从**同一行的不同列**取回，因此取数模式只有宽表。
 */
export interface ApcMonitorItem {
  id: string
  name: string
  description: string
  query: ApcQueryConfig
  output: ApcItemOutput
  params: ApcItemParam[]
  tuning: ApcItemTuning
  /** 由老配置（queries + params）在内存合成、尚未落盘 */
  migrated?: boolean
}

/** 单个参与参数的求解结果行（无论是否参与本次求解都会返回） */
export interface ApcMove {
  code: string
  name: string
  unit: string
  decimals: number
  /** 工作点：配置了「当前设定值」时用它，否则用窗口实测均值 */
  current: number | null
  suggested: number | null
  delta: number
  deltaPct: number | null
  min: ApcSpecValue
  max: ApcSpecValue
  span: number
  weight: number
  k: number
  kMode: 'manual' | 'calibrated'
  /** 杠杆份额 kᵢ²·sᵢ²/wᵢ，决定谁承担更多调整量 */
  leverage: number
  /** 该参数实际承担的偏差比例（0~1） */
  share: number
  /** 约束来源：min=可调下限 max=可调上限 step=单次调整限幅 */
  clampedBy: 'min' | 'max' | 'step' | null
  /** 是否参与本次求解 */
  participating: boolean
  /** 未参与时的原因（停用 / 无数据 / k 未标定） */
  excludedReason: string
}

/** 多对 1 加权求解后的整体建议 */
export interface ApcItemRecommendation {
  cv: {
    /** CV 窗口实测均值 */
    current: number | null
    /** RTO 理想操作点（或规格中值） */
    target: number | null
    /** target − current */
    delta: number | null
  }
  /** 实际需要动的参数（delta ≠ 0） */
  moves: ApcMove[]
  /** 预计调整后的 CV 均值 */
  predictedCV: number | null
  /** 受约束后仍未消除的偏差 */
  residual: number | null
  residualPct: number | null
  /** 置信度 0-100 */
  confidence: number
  urgency: ApcUrgency
  /** 是否建议保持（死区内 / 无可用参数 / 修正量小于最小调节步长） */
  hold: boolean
  /** 迭代分摊轮数 */
  rounds: number
  /** 生效过的约束集合（逗号分隔） */
  clampedBy: string | null
  /** 中文推荐理由（含量化依据） */
  reason: string
  /** 风险提示 */
  risk: string
}

/**
 * 输出结果 CV 的完整运行结果（服务端 optimizeItem 的返回）。
 * 规格无法确定时不做任何判定：target/lsl/usl/cpk 为 null、status 为 unknown、hold 为 true。
 */
export interface ApcCvResult {
  code: string
  name: string
  unit: string
  decimals: number
  objective: string
  objectiveLabel: string
  latest: number | null
  mean: number | null
  std: number | null
  min_: number | null
  max_: number | null
  sampleCount: number
  slope: number
  trend: ApcTrend
  /** 按最新一行解析后的 RTO 理想操作点 */
  target: number | null
  lsl: number | null
  usl: number | null
  cpk: number | null
  status: ApcParamStatus
  specResolved?: ApcSpecResolved
  pointDeviation?: ApcPointDeviation
  series: ApcSeriesPoint[]
  tuning: ApcItemTuning
  /** 全部参与参数的求解行（含未参与的） */
  moves: ApcMove[]
  recommendation: ApcItemRecommendation
}

/** 数据源说明 */
export interface ApcSourceInfo {
  label: string
  note: string
  /** 数据源是否就绪（true=可实时取数；false=未配置，页面按空态引导展示） */
  ready: boolean
  /** 未就绪原因：no-project / no-template / no-connection */
  reason?: string
  /** 取数可继续、但结果有隐患时的告警（如时间戳列未被 SELECT 出来 → 趋势图只能按序号铺点） */
  warnings?: string[]
}

/** 数据源未就绪的原因 */
export type ApcReadinessReason = 'no-project' | 'no-item' | 'no-template' | 'no-connection'

/** 监测项就绪情况 */
export interface ApcReadiness {
  ready: boolean
  reason: ApcReadinessReason | ''
  itemId?: string
}

/** 监测项概览响应（GET /api/apc/overview）：1 个输出结果 CV + N 个参与参数的建议 */
export interface ApcOverview {
  project?: string
  projectName?: string
  /** 本次实际使用的监测项 */
  item?: { id: string; name: string; description?: string } | null
  /** 供前端渲染监测项选择器 */
  items?: Array<{ id: string; name: string }>
  station: string
  mode: ApcSourceMode
  /** 数据源是否就绪；未就绪时 output 为 null、页面显示空态引导 */
  ready: boolean
  reason?: ApcReadinessReason | ''
  readiness?: ApcReadiness
  generatedAt: string
  elapsedMs: number
  windowMinutes: number
  sampleIntervalSec: number
  rowCount: number
  truncated: boolean
  source: ApcSourceInfo
  warnings?: string[]
  /** 输出结果 CV 的实时值、统计、趋势与多对 1 建议 */
  output: ApcCvResult | null
}

/** 优化建议响应（GET /api/apc/optimize）：复用概览数据，把建议提到顶层 */
export interface ApcOptimization {
  project?: string
  projectName?: string
  item?: { id: string; name: string; description?: string } | null
  items?: Array<{ id: string; name: string }>
  station: string
  mode: ApcSourceMode
  ready: boolean
  reason?: ApcReadinessReason | ''
  generatedAt: string
  windowMinutes: number
  source: ApcSourceInfo
  warnings?: string[]
  output: ApcCvResult | null
  recommendation: ApcItemRecommendation | null
  /** 与 recommendation.moves 相同（便利字段） */
  moves: ApcMove[]
}

/** 单个数据库槽位的只读数据源运行状态 */
export interface ApcHanaSlotStatus {
  id: string
  name?: string
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
  /** 最近一次错误的发生时间（毫秒）；无错误时为 null */
  lastErrorAt?: number | null
  lastConnectAt: number | null
  lastQueryAt: number | null
  lastQueryMs: number | null
  queryCount: number
  abortedCount: number
}

/** HANA 只读数据源运行状态（按槽位分别给出） */
export interface ApcHanaStatus {
  configured: boolean
  slots: ApcHanaSlotStatus[]
}

/** 功能状态响应（GET /api/apc/status） */
export interface ApcStatusResponse {
  enabled: boolean
  mode: ApcSourceMode | 'unavailable'
  /** 数据源是否就绪（项目存在 + 已配 SQL 模板 + 数据库已配连接） */
  ready: boolean
  reason?: string
  station: string
  paramCount: number
  /** 当前取数模式：宽表（唯一模式）/ null=未配置 */
  queryMode: ApcQueryMode | null
  catalogFile: string
  /** env-file=由 APC_CATALOG_FILE 锁定；saved=种子文件 + 页面保存覆盖 */
  catalogOrigin: 'env-file' | 'saved'
  catalogFileLocked: boolean
  catalogError: string
  /** 监测项目摘要列表 */
  projects: ApcProjectSummary[]
  /** 运行期配置文件（落在数据卷，不随镜像重建丢失，且不入 git） */
  configFile: string
  configFileExists: boolean
  configFileError: string
  hana: ApcHanaStatus
}

/** 单条曲线历史响应（GET /api/apc/history；code 可为输出结果 CV 或任一参与参数） */
export interface ApcHistoryResponse {
  ready: boolean
  mode: ApcSourceMode
  reason?: ApcReadinessReason | ''
  item?: { id: string; name: string } | null
  windowMinutes: number
  source?: ApcSourceInfo
  warnings?: string[]
  /** true=这条曲线是输出结果 CV（有规格带与 Cpk）；false=参与参数 */
  isOutput?: boolean
  param: {
    code: string
    name: string
    unit: string
    decimals: number
    /** 仅输出结果 CV 有值：RTO 理想操作点 */
    target: number | null
    lsl: number | null
    usl: number | null
    /** 仅参与参数有值：可调范围 */
    min: number | null
    max: number | null
  } | null
  specResolved?: ApcSpecResolved
  pointDeviation?: ApcPointDeviation
  stats: {
    n: number
    mean: number | null
    std: number | null
    min: number | null
    max: number | null
    cpk: number | null
    trend: ApcTrend
    status: ApcParamStatus
  } | null
  points: ApcSeriesPoint[]
}

// ===== APC / RTO 数据源配置（页面上可手工配置）=====

/**
 * 取数模式：**只有宽表**。
 * 一个监测项的 CV 与全部 MV 必须来自查询结果**同一行的不同列**，
 * 窄表（long：一行一个参数值、靠编码分组）无法满足，已物理移除。
 */
export type ApcQueryMode = 'wide'

/** 取数 SQL 配置（每个监测项各有一条） */
export interface ApcQueryConfig {
  mode: ApcQueryMode
  /** SQL 模板，可用占位符：{{minutes}} {{limit}} {{columns}} {{schema}} */
  history: string
  /** 字段映射。宽表下只需时间戳列；code/value 为窄表时代遗留，恒不再使用 */
  columns: { code?: string; ts?: string; value?: string }
}

/**
 * 参数配置（可编辑的完整定义，与 server/apcCatalog.js 的规范化结果一致）。
 * 6 个规格字段既可以是数字，也可以写成**取数结果列名表达式**（如 `USL_COL - 1`），
 * 运行期按每个数据行求值——现场型号多、规格随行变化时无需逐型号维护数字。
 */
export interface ApcParamConfig {
  code: string
  name: string
  process: string
  unit: string
  decimals: number
  setpoint: number | string
  optimalTarget: number | string
  lsl: number | string
  usl: number | string
  min: number | string
  max: number | string
  maxStepPct: number
  deadbandPct: number
  objective: string
  processGain: number
  /** 宽表模式下的取值列名；窄表模式留空 */
  column?: string
  /** 该参数的数据取自哪个数据库系统（db1 / db2），缺省 db1 */
  dbSlot?: 'db1' | 'db2'
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
    /** 连接按槽位保存（公用配置，在「数据库管理」页维护） */
    slots: ApcDatabaseSlot[]
    envConfigured: boolean
    envValues: Partial<ApcDatabaseValues> & { passwordSet: boolean }
    defaults: Partial<ApcDatabaseValues>
  }
  /** 问答直查公用限制（数据库管理页维护） */
  limits: { chatRows: number }
  /** 监测项目摘要列表 */
  projects: ApcProjectSummary[]
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
  /** @deprecated 全局「正在使用」开关已废弃，改由每个参数项各自绑定 dbSlot */
  activeDatabase?: string
  queries?: ApcQueryConfig
  params?: ApcParamConfig[]
  meta?: Partial<ApcCatalogMeta>
}

/** 监测项目摘要（列表/卡片用，不含监测项全文） */
export interface ApcProjectSummary {
  id: string
  name: string
  description: string
  /** 项目绑定的数据库槽位（db1 / db2） */
  dbSlot: string
  /** 项目下的监测项数量 */
  itemCount: number
  /** @deprecated 老结构（queries+params）里的参数个数；新结构请用 itemCount */
  paramCount?: number
  /** 是否至少有一个监测项配好了取数 SQL 模板 */
  hasQueries: boolean
  createdAt: string | null
  updatedAt: string | null
}

/** 监测项目完整定义（项目编辑器用） */
export interface ApcProjectFull extends ApcProjectSummary {
  /** 老结构遗留；迁移到 items 后为 null */
  queries: ApcQueryConfig | null
  /** 老结构遗留；迁移到 items 后为空数组 */
  params: ApcParamConfig[]
  /** 监测项（多对 1 调优的基本单位） */
  items: ApcMonitorItem[]
  /** true=该项目仍是老结构，items 是服务端在内存里合成出来的（保存一次后落盘） */
  synthesizedFromLegacy?: boolean
  legacyMigrated?: boolean
}

/** 项目创建/更新草稿（只提交传入的字段） */
export interface ApcProjectDraft {
  name?: string
  description?: string
  dbSlot?: string
  /** @deprecated 老结构；请改用 items */
  queries?: ApcQueryConfig | null
  /** @deprecated 老结构；请改用 items */
  params?: ApcParamConfig[]
  /** 监测项列表（一旦提交，服务端即视为迁移完成并清空老结构） */
  items?: ApcMonitorItem[]
}

/** MES 直查指引（GET /api/mes/guide，不含任何凭据；与项目 SQL 模板无关，SQL 从知识库检索） */
export interface MesGuide {
  slots: Array<{ id: string; name: string; configured: boolean }>
  limits: { maxRows: number; chatRows: number }
}

/** MES 直查结果（POST /api/mes/query） */
export interface MesQueryResult {
  ok: boolean
  slot: string
  slotName: string
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  elapsedMs: number
  sql: string
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
  /** 规格表达式引用的列是否出现在结果列里（试算时提前暴露「规格判定不了」） */
  specColumns?: Array<{
    code: string
    expressions: Record<string, string>
    columns: Array<{ name: string; present: boolean }>
  }>
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  elapsedMs: number
  warnings: string[]
}

/**
 * 按监测项试运行取数 SQL 的结果（POST /api/apc/projects/:id/items/preview-query）。
 * 比老接口多一个 `columnCheck`：逐列核对「页面要用的每一列是否真的被 SELECT 出来」——
 * 列写在 ORDER BY 里并不等于出现在结果里，这类问题只看 SQL 文本看不出来。
 */
export interface ApcItemPreview {
  ok: boolean
  mode: ApcQueryMode
  /** 渲染占位符之后、实际执行的 SQL */
  sql: string
  vars: Record<string, string>
  columns: string[]
  /** 输出结果与全部参与参数的列名核对（present=null 表示查询没返回行，无法判断） */
  columnCheck: Array<{
    role: 'output' | 'param'
    code: string
    column: string
    present: boolean | null
  }>
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  elapsedMs: number
  warnings: string[]
}
