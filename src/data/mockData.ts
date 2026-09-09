import type {
  Conversation,
  PresetQuestion,
  MessageContent,
  AnalysisTreeNode,
  KnowledgeGraphData,
} from '../types'

// ===== 预设问题 =====
export const presetQuestions: PresetQuestion[] = [
  {
    icon: '🔍',
    category: '异常分析',
    question: '电芯批量胀气鼓包，帮我分析原因',
    description: '基于历史报告和MES实时数据，生成异常分析决策树',
  },
  {
    icon: '⚙️',
    category: '参数调优',
    question: '化成工序充电倍率与温度参数调优建议',
    description: '结合历史大数据，推荐过程参数和质量标准',
  },
  {
    icon: '📊',
    category: '数据查询',
    question: '今天消费类电池A线OEE和良率是多少？',
    description: '实时查询MES系统生产数据和关键指标',
  },
  {
    icon: '📄',
    category: '知识检索',
    question: '最近有哪些关于锂电池安全技术规范的文档？',
    description: '从知识库检索相关文档，标注出处和关键信息',
  },
]

// ===== 异常分析树 Mock =====
export const mockAnalysisTree: AnalysisTreeNode = {
  id: 'root',
  label: '电芯批量胀气鼓包',
  type: 'problem',
  description: '今日电芯车间检出胀气鼓包216只，不良率1.5%，集中在4.2mm厚度型号',
  children: [
    {
      id: 'c1',
      label: '电芯水分超标',
      type: 'cause',
      description: '注液间露点-25℃（标准≤-40℃），电芯水分320-480ppm（标准≤200ppm）',
      confidence: 92,
      status: 'confirmed',
      source: 'MES注液环境监控数据',
      children: [
        {
          id: 'sc1',
          label: '注液间除湿机组效率下降',
          type: 'rootCause',
          description: '除湿机组滤网堵塞+冷媒不足，露点从-45℃恶化至-25℃',
          confidence: 88,
          status: 'confirmed',
          source: '电芯胀气异常分析报告.docx / 二、原因分析',
          children: [
            {
              id: 'sol1',
              label: '检修除湿机组，恢复露点至≤-40℃',
              type: 'solution',
              description: '预计维修工时6小时，暂停高水分敏感型号注液',
              confidence: 95,
            },
          ],
        },
        {
          id: 'sc2',
          label: '电解液水分含量偏高',
          type: 'subCause',
          description: '电解液来料水分检测130ppm（标准≤80ppm），加速LiPF6水解',
          confidence: 72,
          status: 'suspected',
          source: '来料检验记录',
          children: [
            {
              id: 'sol2',
              label: '加强电解液来料水分抽检，更换不合格批次',
              type: 'solution',
              description: '批次退换货处理，用时约3天',
              confidence: 80,
            },
          ],
        },
      ],
    },
    {
      id: 'c2',
      label: '过充电导致产气',
      type: 'cause',
      description: '部分化成/分容批次充电截止电压达4.48V（标准4.35V）',
      confidence: 55,
      status: 'suspected',
      source: '化成工序充电记录',
      children: [
        {
          id: 'sc3',
          label: '充电设备电压漂移',
          type: 'subCause',
          description: '3台化成柜电压校准超期，实测输出电压偏高0.1-0.13V',
          confidence: 58,
          status: 'suspected',
          children: [
            {
              id: 'sol3',
              label: '充电设备电压重新校准，纳入月度校准计划',
              type: 'solution',
              description: '校准3台化成柜，预计4小时',
              confidence: 85,
            },
          ],
        },
      ],
    },
    {
      id: 'c3',
      label: '封装强度不足',
      type: 'cause',
      description: '封装封头温度168℃（标准180±5℃），封装强度偏低',
      confidence: 30,
      status: 'eliminated',
      source: '封装工序点检记录',
      children: [
        {
          id: 'sc4',
          label: '封头加热元件老化',
          type: 'subCause',
          description: '实际检测封头温差达15℃，边缘温度不足',
          confidence: 25,
          status: 'eliminated',
          children: [
            {
              id: 'sol4',
              label: '更换封头加热元件，温度补偿至180±5℃',
              type: 'solution',
              description: '非紧急，可计划性维护',
              confidence: 60,
            },
          ],
        },
      ],
    },
  ],
}

// ===== 参数调优 Mock =====
export const mockParamRecommendations = [
  {
    paramName: '化成温度',
    currentValue: '25',
    recommendedValue: '35',
    unit: '℃',
    confidence: 88,
    reason: '历史最优批次（2025-02-25 批次B021）在35℃下首效达93%，SEI膜致密均匀，较当前提升SEI质量',
    historicalRef: '批次B021 / 化成工艺参数优化研究报告.pptx',
    category: 'process' as const,
  },
  {
    paramName: '化成充电倍率',
    currentValue: '0.2',
    recommendedValue: '0.1',
    unit: 'C',
    confidence: 82,
    reason: '0.2C成膜较厚且不均匀（内阻35mΩ），降至0.1C后内阻降至28mΩ，SEI膜致密稳定',
    historicalRef: 'DOE实验组B2 / 化成工艺参数优化研究报告.pptx',
    category: 'process' as const,
  },
  {
    paramName: '化成夹具压力',
    currentValue: '10',
    recommendedValue: '15',
    unit: 'kgf',
    confidence: 84,
    reason: '夹具压力不足导致电芯厚度膨胀和极片与隔膜贴合不良，提升至15kgf后厚度膨胀率降至2%',
    historicalRef: '批次B021-B024对比数据',
    category: 'timing' as const,
  },
  {
    paramName: '电芯水分标准',
    currentValue: '≤200ppm',
    recommendedValue: '≤150ppm',
    unit: '',
    confidence: 76,
    reason: '当前标准偏宽，水分超标是胀气鼓包主因，建议收紧水分标准并加强注液间露点管控',
    historicalRef: '质量月报 / 2025年Q1数据',
    category: 'quality' as const,
  },
]

// ===== 来源引用 Mock =====
export const mockSources = [
  {
    docName: '聚合物锂电池电芯胀气异常分析报告.docx',
    docType: 'word' as const,
    page: '第2-4页',
    section: '原因分析与解决方案',
    uploader: '王工',
    uploadDate: '2025-01-18',
    relevance: 95,
    summary: '该报告详细记录了电芯胀气鼓包异常的完整分析过程，包括水分检测、过充排查和封装强度检测数据',
  },
  {
    docName: '便携式电子产品用锂离子电池安全技术规范.pdf',
    docType: 'pdf' as const,
    page: '第8-16页',
    section: '电安全试验与保护电路要求',
    uploader: '王工',
    uploadDate: '2025-04-11',
    relevance: 88,
    summary: '该规范规定了过充电、外部短路、强制放电等安全试验方法及保护电路安全要求',
  },
  {
    docName: '锂离子电池电芯规格书.pdf',
    docType: 'pdf' as const,
    page: '第5-8页',
    section: '电性能与循环特性',
    uploader: '李工',
    uploadDate: '2025-05-20',
    relevance: 80,
    summary: '该规格书提供了电芯容量、电压、内阻、循环寿命等参数标准，与本次水分超标诊断数据一致',
  },
  {
    docName: '消费类聚合物电池化成工艺参数优化研究报告.pptx',
    docType: 'ppt' as const,
    page: '第6-9页',
    section: '化成温度与SEI膜质量',
    uploader: '李工',
    uploadDate: '2025-02-22',
    relevance: 74,
    summary: '该报告指出化成温度偏低会形成不稳定SEI膜，与胀气电芯水分偏高加速产气有一定关联',
  },
  {
    docName: 'MES注液环境监控系统',
    docType: 'mes' as const,
    section: '注液间露点与温湿度记录',
    uploader: '系统自动',
    uploadDate: '2025-08-11',
    relevance: 90,
    summary: 'MES系统记录的注液间露点、温度、湿度今日数据，显示露点超标时段与胀气检出时段高度重合',
  },
]

// ===== MES 实时数据 Mock =====
export const mockMesData = {
  title: '消费类电池A线今日生产数据概览',
  queryTime: '2025-08-11 10:26:40',
  items: [
    { label: 'OEE', value: '85.7', unit: '%', status: 'normal' as const, trend: 'up' as const, trendValue: '+1.8%' },
    { label: '良率', value: '96.8', unit: '%', status: 'normal' as const, trend: 'up' as const, trendValue: '+0.4%' },
    { label: '设备稼动率', value: '89.5', unit: '%', status: 'normal' as const, trend: 'stable' as const, trendValue: '0%' },
    { label: '产出数量', value: '18,642', unit: '只', status: 'normal' as const, trend: 'up' as const, trendValue: '+2.9%' },
    { label: '容量测试合格率', value: '97.2', unit: '%', status: 'normal' as const, trend: 'up' as const, trendValue: '+0.6%' },
    { label: '平均节拍', value: '3.2', unit: 's/只', status: 'normal' as const, trend: 'down' as const, trendValue: '-0.1s' },
    { label: '注液间露点', value: '-41', unit: '℃', status: 'normal' as const, trend: 'down' as const, trendValue: '-2℃' },
    { label: '电芯胀气不良', value: '216', unit: '只', status: 'warning' as const, trend: 'down' as const, trendValue: '-1.5%' },
  ],
}

// ===== 知识图谱数据 =====
export const mockKnowledgeGraph: KnowledgeGraphData = {
  nodes: [
    // 设备
    { id: 'eq-formation', label: '化成柜', type: 'equipment', description: '电芯化成充放电设备，64通道', properties: [
      { key: '设备编号', value: 'F-03' },
      { key: '通道数', value: '64' },
      { key: '电压精度', value: '±1mV' },
      { key: '当前状态', value: '运行中' },
    ]},
    { id: 'eq-filling', label: '注液机', type: 'equipment', description: '电芯自动注液设备，带露点控制', properties: [
      { key: '设备编号', value: 'L-02' },
      { key: '注液精度', value: '±0.05g' },
      { key: '当前状态', value: '运行中' },
    ]},
    { id: 'eq-winding', label: '卷绕机', type: 'equipment', description: '极片自动卷绕设备', properties: [
      { key: '设备编号', value: 'W-01' },
      { key: '卷绕速度', value: '1800mm/s' },
      { key: '当前状态', value: '运行中' },
    ]},
    // 工序
    { id: 'pr-mix', label: '搅拌工序', type: 'process', description: '正负极浆料搅拌混合' },
    { id: 'pr-coat', label: '涂布工序', type: 'process', description: '浆料涂布与干燥' },
    { id: 'pr-roll', label: '辊压分切', type: 'process', description: '极片辊压与分切' },
    { id: 'pr-winding', label: '卷绕工序', type: 'process', description: '正负极与隔膜卷绕' },
    { id: 'pr-filling', label: '注液工序', type: 'process', description: '电解液注入' },
    { id: 'pr-formation', label: '化成工序', type: 'process', description: '首次充放电与SEI膜形成' },
    { id: 'pr-grading', label: '分容工序', type: 'process', description: '容量分选与内阻测试' },
    // 产品
    { id: 'pd-cell', label: '聚合物电芯', type: 'product', description: '消费类聚合物锂离子电芯（4.2mm）' },
    { id: 'pd-pack', label: '电池组', type: 'product', description: '手机/平板/穿戴设备电池组' },
    // 质量
    { id: 'qa-swelling', label: '电芯胀气', type: 'quality', description: '电芯鼓包胀气不良', properties: [
      { key: '不良率', value: '1.5%→0.25%' },
      { key: '根因', value: '水分超标+过充电+封装不良' },
    ]},
    { id: 'qa-capacity', label: '容量衰减', type: 'quality', description: '循环容量保持率偏低', properties: [
      { key: '500次保持率', value: '82.5%（加速组）' },
      { key: '根因', value: '高倍率循环+析锂+电解液消耗' },
    ]},
    { id: 'qa-impedance', label: '内阻超标', type: 'quality', description: '电芯内阻偏高', properties: [
      { key: '内阻', value: '35mΩ（标准≤30）' },
      { key: '根因', value: 'SEI膜成膜不均+水分偏高' },
    ]},
    // 人员
    { id: 'p-wang', label: '王工', type: 'personnel', description: '电芯工艺工程师', properties: [
      { key: '职责', value: '电芯工艺与品质改善' },
      { key: '上传文档', value: '3篇' },
    ]},
    { id: 'p-li', label: '李工', type: 'personnel', description: '化成工艺工程师', properties: [
      { key: '职责', value: '化成与分容工艺优化' },
      { key: '上传文档', value: '2篇' },
    ]},
    { id: 'p-chen', label: '陈工', type: 'personnel', description: '品质工程师', properties: [
      { key: '职责', value: '电芯可靠性测试' },
      { key: '上传文档', value: '1篇' },
    ]},
    // 物料/原材料
    { id: 'm-electrolyte', label: '电解液', type: 'material', description: 'LiPF6电解液，水分≤80ppm', properties: [
      { key: '水分标准', value: '≤80ppm' },
      { key: '来料水分', value: '130ppm（异常）' },
    ]},
    { id: 'm-separator', label: '隔膜', type: 'material', description: '陶瓷涂覆隔膜，厚度12μm' },
    { id: 'm-ncm', label: 'NCM正极材料', type: 'material', description: '高镍三元正极材料' },
    { id: 'm-graphite', label: '石墨负极', type: 'material', description: '人造石墨负极材料' },
    // 文档
    { id: 'd-swelling', label: '胀气分析报告', type: 'document', description: '聚合物锂电池电芯胀气异常分析报告.docx' },
    { id: 'd-formation', label: '化成优化报告', type: 'document', description: '化成工艺参数优化研究报告.pptx' },
    { id: 'd-safety', label: '安全技术规范', type: 'document', description: '便携式电子产品用锂离子电池安全技术规范.pdf' },
    { id: 'd-spec', label: '电芯规格书', type: 'document', description: '锂离子电池电芯规格书.pdf' },
  ],
  edges: [
    // 设备 → 工序
    { source: 'eq-winding', target: 'pr-winding', label: '执行', description: '卷绕机执行卷绕工序' },
    { source: 'eq-filling', target: 'pr-filling', label: '执行', description: '注液机执行注液工序' },
    { source: 'eq-formation', target: 'pr-formation', label: '执行', description: '化成柜执行化成工序' },
    // 工序 → 产品
    { source: 'pr-coat', target: 'pd-cell', label: '生产极片' },
    { source: 'pr-winding', target: 'pd-cell', label: '卷绕' },
    { source: 'pr-formation', target: 'pd-cell', label: '化成' },
    { source: 'pr-grading', target: 'pd-cell', label: '分容' },
    { source: 'pr-filling', target: 'pd-cell', label: '注液' },
    // 工序 → 质量问题
    { source: 'pr-filling', target: 'qa-swelling', label: '存在异常', description: '注液工序露点超标导致电芯水分偏高' },
    { source: 'pr-formation', target: 'qa-capacity', label: '存在异常', description: '化成参数不当影响循环寿命' },
    { source: 'pr-formation', target: 'qa-impedance', label: '存在异常', description: '化成SEI膜成膜不均导致内阻偏高' },
    // 设备 → 质量问题
    { source: 'eq-filling', target: 'qa-swelling', label: '发生', description: '注液机所在注液间露点超标' },
    { source: 'eq-formation', target: 'qa-impedance', label: '发生', description: '化成柜电压漂移影响化成质量' },
    // 物料 → 质量问题
    { source: 'm-electrolyte', target: 'qa-swelling', label: '导致', description: '电解液水分超标导致胀气产气' },
    // 物料 → 设备
    { source: 'm-electrolyte', target: 'eq-filling', label: '注入于', description: '电解液经注液机注入电芯' },
    { source: 'm-separator', target: 'eq-winding', label: '上料于', description: '隔膜上料至卷绕机' },
    // 人员 → 文档
    { source: 'p-wang', target: 'd-swelling', label: '上传' },
    { source: 'p-wang', target: 'd-safety', label: '上传' },
    { source: 'p-li', target: 'd-formation', label: '上传' },
    { source: 'p-li', target: 'd-spec', label: '上传' },
    // 人员 → 设备
    { source: 'p-li', target: 'eq-formation', label: '负责维护' },
    { source: 'p-chen', target: 'eq-filling', label: '负责监控' },
    // 文档 → 质量问题
    { source: 'd-swelling', target: 'qa-swelling', label: '记录分析' },
    { source: 'd-safety', target: 'qa-swelling', label: '提供试验标准' },
    { source: 'd-formation', target: 'qa-impedance', label: '提供方法' },
    { source: 'd-spec', target: 'qa-capacity', label: '提供标准' },
    // 文档 → 物料
    { source: 'd-spec', target: 'm-electrolyte', label: '涵盖' },
    { source: 'd-safety', target: 'm-separator', label: '安全要求' },
  ],
}

// ===== 思考过程 Mock =====
export const mockThinkingSteps = [
  '解析用户问题：电芯批量胀气鼓包的异常分析请求',
  '调用MES系统API → 查询注液间露点、化成记录和今日不良数据',
  'MES数据返回：今日检出胀气216只，注液间露点超标时段与检出时段重合',
  'RAG检索 → 从知识库匹配"电芯胀气/水分超标/过充电"相关文档',
  '命中文档：聚合物锂电池电芯胀气异常分析报告.docx（相关度95%）',
  '命中文档：便携式电子产品用锂离子电池安全技术规范.pdf（相关度88%）',
  '命中文档：锂离子电池电芯规格书.pdf（相关度80%）',
  '知识图谱追溯 → 注液工序→电解液水分→电芯胀气→鼓包不良',
  '融合分析：注液间露点超标导致水分超标为根因（置信度88%），过充电和封装不良为次要因素',
  '生成异常分析决策树并标注每个节点的数据来源',
]

// ===== AI 回复生成器 =====
export function generateResponse(query: string): MessageContent[] {
  const lowerQuery = query.toLowerCase()

  // 异常分析场景
  if (query.includes('胀气') || query.includes('鼓包') || query.includes('异常') || query.includes('故障')) {
    return [
      {
        type: 'thinking',
        thinkingSteps: mockThinkingSteps,
      },
      {
        type: 'text',
        text: `## 异常分析报告：电芯批量胀气鼓包

根据MES系统实时数据和知识库历史报告的综合分析，电芯批量胀气鼓包的**根本原因**已定位。

### 问题概述
- **对象**：聚合物锂离子电芯（4.2mm厚度型号）
- **现象**：今日检出胀气鼓包 **216只**，不良率 **1.5%**
- **直接影响**：产出减少约 2,400 只，预估损失 ¥115,000

### 分析结论
通过多源数据融合分析（MES注液环境监控 + 胀气分析报告 + 知识图谱追溯），定位到以下根因：

1. **电芯水分超标**（置信度 88%）— 主要根因（注液间露点超标导致）
2. **过充电产气**（置信度 55%）— 次要因素
3. **封装强度不足**（置信度 30%）— 次要因素

以下为完整的异常分析决策树：`,
      },
      {
        type: 'analysisTree',
        tree: mockAnalysisTree,
      },
      {
        type: 'text',
        text: `### 改善建议

| 优先级 | 措施 | 预计工时 | 备注 |
|--------|------|----------|------|
| 🔴 紧急 | 检修注液间除湿机组，恢复露点≤-40℃ | 6h | 暂停高水分敏感型号注液 |
| 🟡 重要 | 充电设备电压重新校准至4.35V | 4h | 覆盖3台化成柜 |
| 🟡 重要 | 更换不合格电解液批次，加强来料水分抽检 | 3天 | 来料水分≤80ppm |
| 🟢 计划 | 更换封装封头加热元件，温度补偿至180±5℃ | 3h | 非紧急，可安排计划性维护 |

> ⚠️ 建议立即检修除湿机组并暂停敏感型号注液，避免水分超标持续产生胀气。预计综合处理后不良率可恢复至 **≤0.3%**。`,
      },
      {
        type: 'sourceList',
        sources: mockSources,
      },
    ]
  }

  // 参数调优场景
  if (query.includes('参数') || query.includes('调优') || query.includes('化成') || query.includes('倍率')) {
    return [
      {
        type: 'thinking',
        thinkingSteps: [
          '解析用户问题：化成工序充电倍率与温度参数调优建议',
          'RAG检索 → 匹配"化成工艺参数优化研究报告.pptx"',
          'MES数据查询 → 获取最近30批次化成生产记录和电芯检测数据',
          '历史最优批次识别 → 批次B021首效93%为最优',
          '对比当前参数与最优批次参数，计算置信度和改善预期',
          '生成参数调优建议卡片',
        ],
      },
      {
        type: 'text',
        text: `## 化成工序参数调优建议

基于知识库中的**化成工艺参数优化研究报告**和MES系统近30批次生产数据，为您提供以下参数调优建议。

### 分析方法
- **数据来源**：化成工艺参数优化研究报告 + MES生产记录（30批次）
- **分析方法**：历史最优批次对比 + DOE实验数据回归
- **最优参考批次**：B021（2025-02-25，首效93%）

以下为具体参数建议：`,
      },
      {
        type: 'paramCard',
        params: mockParamRecommendations,
      },
      {
        type: 'text',
        text: `### 预期效果

调优后预计可实现：
- 电芯首效从 **88%** → **93%**（+5%）
- 内阻从 35mΩ → **28mΩ**（-20%）
- 循环500次容量保持率提升至 **92%**
- 厚度膨胀率控制在 **≤2%**

> 💡 建议先在A线进行小批量试产验证（3-5批次），确认效果后再全面推广。试产期间需增加首效和内阻检测频次至每批次5只。`,
      },
      {
        type: 'sourceList',
        sources: [
          {
            docName: '消费类聚合物电池化成工艺参数优化研究报告.pptx',
            docType: 'ppt',
            page: '第7-11页',
            section: 'DOE实验结果与参数优化',
            uploader: '李工',
            uploadDate: '2025-02-22',
            relevance: 98,
            summary: '该报告详细记录了化成工艺参数DOE实验过程，包含化成温度、充电倍率、夹具压力对首效和内阻的影响',
          },
          {
            docName: 'MES生产数据库',
            docType: 'mes',
            section: '化成工序近30批次记录',
            uploader: '系统自动',
            uploadDate: '2025-08-11',
            relevance: 85,
            summary: 'MES系统记录的化成工序近30批次生产数据，包含工艺参数、首效和内阻检测数据',
          },
        ],
      },
    ]
  }

  // MES 数据查询场景
  if (query.includes('OEE') || query.includes('良率') || query.includes('数据') || query.includes('产线')) {
    return [
      {
        type: 'thinking',
        thinkingSteps: [
          '解析用户问题：查询消费类电池A线OEE和良率',
          '调用MES系统API → 查询A线今日生产数据',
          'MES数据返回：OEE 85.7%，良率 96.8%',
          '对比历史趋势 → OEE环比+1.8%，良率环比+0.4%',
          '生成数据概览卡片',
        ],
      },
      {
        type: 'text',
        text: `## 消费类电池A线今日生产数据概览

已从MES系统获取A线今日（2025-08-11）的实时生产数据：`,
      },
      {
        type: 'mesData',
        mesData: mockMesData,
      },
      {
        type: 'text',
        text: `### 数据分析

- **OEE 85.7%**：表现良好，环比提升1.8%，主要得益于化成柜稼动率提升
- **良率 96.8%**：达标（目标≥95%），环比小幅提升0.4%
- ✅ **注液间露点 -41℃**：处于正常范围（标准≤-40℃），水分风险受控
- ⚠️ **电芯胀气不良 216只**：仍高于目标，建议结合异常分析功能跟踪注液工序

> 📊 如需查看详细的不良帕累托图或历史趋势分析，请告诉我。`,
      },
    ]
  }

  // 知识检索场景
  if (query.includes('报告') || query.includes('文档') || query.includes('检索') || query.includes('安全')) {
    return [
      {
        type: 'thinking',
        thinkingSteps: [
          '解析用户问题：检索锂电池安全技术规范相关文档',
          'RAG检索 → 关键词匹配"锂电池安全"',
          '向量检索 → 从知识库匹配语义相似文档',
          '命中2篇高相关度文档，提取元数据和摘要',
        ],
      },
      {
        type: 'text',
        text: `## 知识检索结果：锂电池安全技术规范相关文档

从知识库中检索到以下与"锂电池安全技术规范"相关的文档：`,
      },
      {
        type: 'sourceList',
        sources: [
          {
            docName: '便携式电子产品用锂离子电池安全技术规范.pdf',
            docType: 'pdf',
            page: '第1-37页',
            section: '安全试验与保护电路要求',
            uploader: '王工',
            uploadDate: '2025-04-11',
            relevance: 97,
            summary: '规定了便携式电子产品用锂离子电池和电池组的安全技术规范，涵盖电安全、环境安全、机械安全试验及保护电路要求',
          },
          {
            docName: '锂离子电池电芯规格书.pdf',
            docType: 'pdf',
            page: '第6-9页',
            section: '安全性能与储存要求',
            uploader: '李工',
            uploadDate: '2025-05-20',
            relevance: 82,
            summary: '电芯规格书中明确了过充、过放、短路保护参数及储存、运输、安全警告要求',
          },
        ],
      },
      {
        type: 'text',
        text: `### 关键信息摘要

**锂离子电池安全管控要点**：
- **主要危险**：热失控引发的起火、爆炸、漏液、过热
- **核心防护**：过充/过放/短路/过流保护电路 + 安全材料选型
- **关键试验**：高温外部短路、过充电、强制放电、温度循环、振动、跌落、挤压、热滥用
- **执行标准**：GB 31241、GB/T 46732 等国家/行业标准

> 💡 如需查看完整的安全技术规范内容，或需要我进一步分析当前电芯的安全试验数据，请告诉我。`,
      },
    ]
  }

  // 默认回复
  return [
    {
      type: 'text',
      text: `您好！我是 **AI 智能助手**，可以帮您：

1. 🔍 **异常分析** — 分析生产过程异常，生成决策树并标注数据来源
2. ⚙️ **参数调优** — 基于历史大数据推荐工艺参数和质量标准
3. 📊 **数据查询** — 实时查询OEE、良率、设备状态等数据
4. 📄 **知识检索** — 从知识库检索相关文档，自动提取关键信息

您可以尝试以下预设问题，或直接输入您的问题：`,
    },
  ]
}

// ===== 初始对话列表 =====
export const initialConversations: Conversation[] = []
