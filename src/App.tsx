import { useState, useCallback, useRef, useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { KnowledgeBase } from './components/KnowledgeBase'
import { ApcRto } from './components/ApcRto'
import { WelcomeScreen } from './components/WelcomeScreen'
import { ApiKeyModal } from './components/ApiKeyModal'
import { AuthModal, getSession, clearSession, type User } from './components/AuthModal'
import { UserManagement } from './components/UserManagement'
import { DatabaseManage } from './components/DatabaseManage'
import { ChangePasswordModal } from './components/ChangePasswordModal'
import ErrorToasts from './components/ErrorToasts'
import { generateResponse, initialConversations, presetQuestions } from './data/mockData'
import { streamChat, hasApiKey, getProvider, getReasoningModelId, resolveModelId, summarizeHistory, type ChatMessageDto } from './services/llmApi'
import { buildKnowledgeContext, decideRetrievalMode, detectSummaryIntent, getCachedSummary, FULL_DOC_SUMMARY_KEY, summarizeDocumentScope } from './services/knowledgeService'
import { fetchMesGuide, queryMesData } from './services/apcApi'
import type { MesSource, MesSlotInfo } from './components/ChatInput'
import type { MesGuide } from './types'
import { ensureSuperAdminSeeded, syncUsersFromBackend, canAccessUserManagement, canAccessDatabaseManagement } from './services/userService'
import { getAllDocs, restoreDocsFromRecords, syncLocalToBackend, saveTableSummary, fetchAllDocPages } from './services/docStore'
import { resolveServerHits, fetchObjectIndex, fetchDocumentIndex, type ServerSearchHit, type SearchObject, type DocIndexResult } from './services/searchApi'
import { resolveModelProfile, hasSqlIntent } from '../shared/modelProfile.js'
import type { Conversation, ChatMessage, SidebarView, KnowledgeDoc } from './types'
import { APP_VERSION } from './version'

// 安全生成唯一 ID：crypto.randomUUID 仅在「安全上下文」（localhost/https）可用，
// 局域网 IP（http://192.168.x.x）非安全上下文下为 undefined，直接调用会抛 TypeError 导致发消息失败。
// 非安全上下文用 时间戳+随机串 兜底，保证 LAN IP 访问也能正常发消息。
function uid(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`
    }
  } catch { /* 某些环境对 randomUUID 抛错，落到兜底 */ }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ===== 问答中的 MES 数据直查（两轮对话）=====
//
// 问答环节与监测项目的 SQL 模板无关：SQL 由模型从知识库上下文中检索/改写得到
// （知识库里的 SQL/脚本页在检索时已加权）。第一轮注入「硬性要求」（数据库管理页维护的
// 限制），模型如需真实数据，先给出来源行，再输出一个 ```mes-sql 代码块；
// 第二轮：前端提取 SQL → POST /api/mes/query（服务端硬护栏：仅 SELECT / 行数上限 /
// 连接与语句超时，按所选数据库槽位执行）→ 结果回灌给模型，基于真实数据作答。

/** 从模型回答中提取 mes-sql 推荐查询（只取第一个代码块） */
function extractMesSql(text: string): string | null {
  const m = text.match(/```mes-sql\s*([\s\S]*?)```/)
  const sql = m ? m[1].trim() : ''
  return sql || null
}

/** 从 mes-sql 代码块之前的文本里提取「来源：xxx」标注（SQL 取自哪篇文档/哪个脚本） */
function extractMesSource(text: string): string | null {
  const m = text.match(/来源\s*[：:]\s*([^\n`]{1,120})/)
  return m ? m[1].trim() : null
}

/** 构建注入给模型的 MES 直查指引（随所选槽位变化；不注入任何项目 SQL 模板） */
function buildMesInstruction(guide: MesGuide | null, slotId: 'db1' | 'db2', slotName: string): string {
  const limits = guide?.limits
  const lines: string[] = []
  lines.push(`\n\n## MES 数据库直查（${slotName}，HANA 只读）`)
  lines.push(`用户已选择从「${slotName}」检索数据。你可以通过输出**恰好一个** \`\`\`mes-sql 代码块来发起一次只读查询，系统执行后会把真实结果回传给你，届时你再基于真实数据作答。硬性要求（系统强制，违反会被直接拒绝）：`)
  lines.push(`1. 只允许单条 SELECT / WITH 查询语句；任何 INSERT / UPDATE / DELETE / DDL 都会被拦截。`)
  lines.push(`2. 结果行数上限 ${limits?.chatRows ?? 100} 行；请在 SQL 里写好 LIMIT 并合理取数。`)
  lines.push(`3. 不得残留任何 {{...}} 模板占位符——占位符必须代入具体值。`)
  lines.push(`4. 只查询与用户问题相关的数据，不要把所有列全查出来。`)
  lines.push(`SQL 从哪里来：**优先使用上方知识库上下文里出现的 SQL 查询/脚本片段**（包括其表名、列名与过滤写法），按用户问题改写成一条完整 SELECT；知识库中没有可用的 SQL 时，基于上下文里的表结构信息谨慎编写，并明确说明该 SQL 未经现场验证。`)
  lines.push(`输出格式：需要查库时，先用一句话说明查询意图与 **来源**（格式：来源：<文档名/脚本名>；若无来源写 来源：知识库未命中，SQL 为自行编写），然后输出一个 \`\`\`mes-sql 代码块（内含完整 SQL），除此之外**不要编造任何具体数值**；系统会把查询结果回传，你再给出最终回答。无需查库即可回答时，不要输出 mes-sql 代码块。`)
  return lines.join('\n')
}

/** 把查询结果压成模型友好的文本（限制总长度，防止撑爆上下文） */
function formatMesRows(result: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }): string {
  const MAX_CHARS = 12000
  const head = `列名：${result.columns.join(', ')}`
  let body = ''
  let n = 0
  for (const row of result.rows) {
    const line = JSON.stringify(row)
    if (body.length + line.length > MAX_CHARS) break
    body += (body ? '\n' : '') + line
    n++
  }
  const tail = n < result.rows.length ? `\n（仅展示前 ${n} 行，共 ${result.rowCount} 行${result.truncated ? '，已按上限截断' : ''}）` : ''
  return `${head}\n${body}${tail}`
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarView, setSidebarView] = useState<SidebarView>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [apiKeyReady, setApiKeyReady] = useState(hasApiKey())
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)
  const [apiKeyModalForce, setApiKeyModalForce] = useState(false)
  const [user, setUser] = useState<User | null>(getSession())
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [showChangePassword, setShowChangePassword] = useState(false)
  const [forceChangePassword, setForceChangePassword] = useState(false)
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([])
  const [useKnowledgeBase, setUseKnowledgeBase] = useState(true)
  const [deepThink, setDeepThink] = useState(true)
  // 问答环节的 MES 数据源选择：数据库关闭 / 数据库1 / 数据库2（持久化到 localStorage）
  const [mesSource, setMesSource] = useState<MesSource>(() => {    const v = localStorage.getItem('mes-ai-mes-source')
    return v === 'db1' || v === 'db2' ? v : 'off'
  })
  const [mesSlots, setMesSlots] = useState<MesSlotInfo[]>([
    { id: 'db1', name: '数据库系统 1', configured: false },
    { id: 'db2', name: '数据库系统 2', configured: false },
  ])
  const mesGuideRef = useRef<MesGuide | null>(null)
  useEffect(() => { localStorage.setItem('mes-ai-mes-source', mesSource) }, [mesSource])
  // 拉取 MES 直查指引（槽位显示名 / 是否已配置 / 推荐 SQL 模板 / 参数白名单）
  useEffect(() => {
    let cancelled = false
    fetchMesGuide()
      .then(g => {
        if (cancelled) return
        mesGuideRef.current = g
        if (g.slots?.length) {
          setMesSlots(g.slots.map(s => ({ id: s.id, name: s.name, configured: s.configured })))
        }
      })
      .catch(() => { /* 未配置 APC / 服务不可用时静默：下拉仍显示默认槽位名 */ })
    return () => { cancelled = true }
  }, [])
  const handleMesSourceChange = useCallback((s: MesSource) => setMesSource(s), [])

  const chatAreaRef = useRef<HTMLDivElement>(null)
  // 会话列表 ref：让发送回调始终读取最新历史，避免 useCallback 闭包陈旧导致快速连发漏消息
  const conversationsRef = useRef(conversations)
  useEffect(() => { conversationsRef.current = conversations }, [conversations])
  // 整表总结后台生成防重：同一「文档+标签页」只启动一次
  const summaryInflight = useRef<Set<string>>(new Set())
  // 超大文档（contentOmitted，正文未随列表下发）按需补全防重：同一文档只拉一次
  const deferredFilled = useRef<Set<string>>(new Set())

  // 应用启动时确保超级管理员账户存在，并从后端同步用户表（跨浏览器共享）
  useEffect(() => {
    ensureSuperAdminSeeded()
    syncUsersFromBackend().catch(() => {})
  }, [])

  // 从 IndexedDB 恢复上传的知识库文档（含 AI 提取文本，可继续检索引用）
  useEffect(() => {
    let cancelled = false
    getAllDocs()
      .then(records => {
        if (cancelled) return
        const restored = restoreDocsFromRecords(records).filter(d => typeof d.id === 'string' && d.id.startsWith('upload-'))
        if (restored.length > 0) {
          setDocuments(prev => {
            const map = new Map(prev.map(d => [d.id, d]))
            let changed = false
            for (const r of restored) {
              const existing = map.get(r.id)
              if (existing) {
                // 已存在（如内置样例）：用持久化的审核状态更新，保留原有 URL
                if (existing.status !== r.status || existing.approvedDate !== r.approvedDate) {
                  map.set(r.id, { ...r, pdfUrl: r.pdfUrl || existing.pdfUrl, fileUrl: r.fileUrl || existing.fileUrl })
                  changed = true
                }
              } else {
                map.set(r.id, r)
                changed = true
              }
            }
            return changed ? Array.from(map.values()) : prev
          })
        }
      })
      .catch(err => console.error('恢复知识库文档失败', err))
    // 将本地 IndexedDB 文档迁移到后端（外部浏览器可共享），后端不可达时静默跳过
    syncLocalToBackend().catch(() => {})
    return () => { cancelled = true }
  }, [])

  // 若当前会话要求首次修改密码，强制弹出
  useEffect(() => {
    if (user?.mustChangePassword) {
      setForceChangePassword(true)
      setShowChangePassword(true)
    }
  }, [user])

  const activeConversation = conversations.find(c => c.id === activeId) || null

  // 打开 API Key 配置弹窗
  const openApiKeyModal = useCallback((force = false) => {
    setApiKeyModalForce(force)
    setShowApiKeyModal(true)
  }, [])

  // API Key 保存后刷新状态
  const handleApiKeySaved = useCallback(() => {
    setApiKeyReady(hasApiKey())
  }, [])

  // 创建新对话
  const handleNewChat = useCallback(() => {
    setActiveId(null)
    setSidebarView('chat')
  }, [])

  // 选择对话
  const handleSelectConversation = useCallback((id: string) => {
    setActiveId(id)
    setSidebarView('chat')
  }, [])

  // 发送消息
  const handleSendMessage = useCallback(async (text: string) => {
    // 检查 API Key
    if (!hasApiKey()) {
      openApiKeyModal(true)
      return
    }

    let convId = activeId

    // 如果没有活跃对话，创建一个
    if (!convId) {
      convId = uid('conv')
      const newConv: Conversation = {
        id: convId,
        title: text.slice(0, 20) + (text.length > 20 ? '...' : ''),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      setConversations(prev => [newConv, ...prev])
      setActiveId(convId)
    }

    // 安全网：任何同步/异步异常都转换为可见错误，避免永久卡在「正在分析中」
    let aiMsgId = ''

    try {
    // 添加用户消息
    const userMsg: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      contents: [{ type: 'text', text }],
      timestamp: Date.now(),
    }

    aiMsgId = uid('msg')
    const aiMsg: ChatMessage = {
      id: aiMsgId,
      role: 'assistant',
      contents: [],
      timestamp: Date.now() + 1,
      isStreaming: true,
    }

    // 获取当前对话的历史消息（用于 LLM 上下文），用 ref 取最新，避免快速连发时闭包陈旧漏掉上一条
    const currentConv = conversationsRef.current.find(c => c.id === convId)

    setConversations(prev => prev.map(c => {
      if (c.id !== convId) return c
      return {
        ...c,
        title: c.messages.length === 0 ? (text.slice(0, 20) + (text.length > 20 ? '...' : '')) : c.title,
        messages: [...c.messages, userMsg, aiMsg],
        updatedAt: Date.now(),
      }
    }))

    // 构建发送给 LLM 的消息历史
    // 滚动摘要：超出最近 12 条的部分用 LLM 压缩为一段摘要；摘要失败降级为直接截断
    const MAX_HISTORY_MSGS = 12
    const MAX_MSG_CHARS = 2000
    const allHistory = currentConv?.messages || []
    const overflowMsgs = allHistory.length > MAX_HISTORY_MSGS ? allHistory.slice(0, allHistory.length - MAX_HISTORY_MSGS) : []
    const recentMsgs = allHistory.slice(-MAX_HISTORY_MSGS)

    let summaryPrefix: ChatMessageDto[] = []
    if (overflowMsgs.length > 0) {
      const summary = await summarizeHistory(
        overflowMsgs.map(m => ({
          role: m.role,
          content: m.contents.map(c => c.text || '').filter(Boolean).join('\n'),
        }))
      )
      if (summary) {
        summaryPrefix = [{ role: 'system', content: `【早期对话摘要】${summary}` }]
      }
    }

    const historyMessages: ChatMessageDto[] = recentMsgs
      .map(m => ({
        role: m.role,
        content: m.contents.map(c => c.text || '').filter(Boolean).join('\n'),
      }))
      .map(m => ({
        ...m,
        content: m.content.length > MAX_MSG_CHARS
          ? m.content.slice(0, MAX_MSG_CHARS) + '\n[内容过长已截断]'
          : m.content,
      }))
    const llmMessages: ChatMessageDto[] = [
      ...summaryPrefix,
      ...historyMessages,
      { role: 'user' as const, content: text },
    ]

    let hasContent = false
    let hasThinking = false
    let llmFailed = false
    // 累计正文（用于 MES 直查：从第一轮回答里提取 mes-sql 推荐查询）
    let answerAccum = ''

    // 构建知识库上下文（仅当启用知识库检索时，传入用户查询实现智能检索）
    // 三态：
    // 1) 知识库未点亮 -> 不注入任何知识库内容，直接通用/外网知识回答
    // 2) 点亮且检索到内容 -> 注入文档内容，优先从最新知识库检索归纳并注明出处
    // 3) 点亮但未检索到内容 -> 注入"未命中"提示，要求先告知"知识库中未找到相关内容"，再转外部/通用知识
    const kbEnabled = useKnowledgeBase
    // ===== 模型分级预算：云端按各家云端配置，本地按参数量分档 =====
    // 旧实现用「窗口 80%，封顶 160000」这一个公式套所有模型：云端 128k 只注入约 10 万字符（浪费召回），
    // 本地 1.5B 却被灌进 2 万多字符（注意力稀释，并且会直接撞上 Ollama 的 num_ctx 上限报 HTTP 400）。
    // 现改为按模型档位取预算，具体档位与依据见 shared/modelProfile.js。
    const provider = getProvider()
    const profileModelId = resolveModelId(
      deepThink ? (getReasoningModelId() || provider.defaultModel) : provider.defaultModel
    )
    const profile = resolveModelProfile({ providerId: provider.id, modelId: profileModelId, provider })
    // 本次知识库上下文最多注入多少字符（由模型档位决定）
    const kbContextLimit = profile.limit
    // 是否在问 SQL / 查询语句类问题 → 让 query.sql 页提权并优先注入
    const sqlIntent = hasSqlIntent(text)

    // ===== 服务端检索（第二阶段）：超大文档的正文不常驻浏览器，只能由服务端倒排索引检索 =====
    // 结果直接喂给 buildKnowledgeContext（可选参数），索引未就绪时返回空数组 → 自动走本地既有路径。
    // 同时取一份「对象目录」（无正文，很廉价）：XML 文档被剥正文后目录里没有对象名，
    // 模型会拿文档名当表名编造 SQL，必须靠这份清单告诉它库里有哪些对象。
    let serverHits: ServerSearchHit[] = []
    let objectIndex: SearchObject[] = []
    let docIndex: DocIndexResult | null = null
    if (kbEnabled) {
      const [hits, objs, ledger] = await Promise.all([
        resolveServerHits(text, documents, {
          topK: profile.topK,
          perHitChars: profile.perHitChars,
          // 只在问 SQL / 查询语句类问题时裁剪界面大 JSON 并给 SQL 页提权：
          // 问「这个界面有哪些控件」时需要完整结构体，不能被裁掉（保持历史行为）。
          smartTrim: sqlIntent,
          boostSql: sqlIntent,
          structChars: profile.structChars,
          timeoutMs: 5000,
        }),
        fetchObjectIndex(text, {
          limit: profile.objectRows,
          boostSql: sqlIntent,
          timeoutMs: 5000,
        }),
        // 文档台账（权威的文档清单与三态计数）：让「知识库里有几篇文档」按台账真值回答，
        // 而不是让模型去数"有正文可注入的文档"（正文被剥离且本次未命中的 approved 文档会被漏算）。
        // 失败/未就绪返回 null → buildKnowledgeContext 走历史行为，零回归。
        fetchDocumentIndex({ timeoutMs: 5000 }),
      ])
      serverHits = hits
      objectIndex = objs
      docIndex = ledger
    }

    // 兜底：服务端索引不可用（未构建完成 / 旧版本后端）且存在「正文剥离」的超大文档时，
    // 按需把正文拉取回来，使本地检索恢复到改造前的能力（每篇文档仅拉取一次）。
    let docsForContext = documents
    if (kbEnabled && serverHits.length === 0) {
      const deferred = documents.filter(d =>
        d.status === 'approved' && d.contentOmitted && !deferredFilled.current.has(d.id)
      )
      if (deferred.length > 0) {
        try {
          const patches = await Promise.all(deferred.map(async d => {
            // 注意：必须等拉取成功后再标记"已补全"。此前先 add 再 await，
            // 一旦 fetchAllDocPages 抛错，该文档会被永久跳过（内容仍为空），导致文档计数漂移。
            const pages = await fetchAllDocPages(d.id)
            deferredFilled.current.add(d.id)
            return { id: d.id, patch: { ...d, content: pages, contentOmitted: false } }
          }))
          if (patches.length > 0) {
            const map = new Map(patches.map(p => [p.id, p.patch]))
            setDocuments(prev => prev.map(d => map.get(d.id) || d))
            docsForContext = documents.map(d => map.get(d.id) || d)
          }
        } catch (e) {
          // 拉取失败的文档回滚"已补全"标记，允许下次提问重试（否则会永久跳过）
          for (const d of deferred) deferredFilled.current.delete(d.id)
          console.warn('超大文档正文按需补全失败（将继续使用已有内容）:', e)
        }
      }
    }

    // 两步提问法：自动触发，无需手动选择检索模式。
    // 已收窄：只有用户「明确在问知识库里有哪些资料」时才走探索（只列目录、让用户挑一篇）；
    // 其余问题一律走详解——服务端倒排索引已能把相关对象/正文取回来，再让用户先挑文档属于多此一举。
    // （旧逻辑是「没点名文档就走探索」，导致「开发 XX 功能」这类问题只回一串文档名，拿不到正文。）
    const effectiveMode = decideRetrievalMode(text, documents)

    const knowledgeContext = kbEnabled ? buildKnowledgeContext(docsForContext, text, kbContextLimit, effectiveMode, serverHits, objectIndex, docIndex) : ''

    // 项⑤：整体归纳意图自动触发整表总结（优先用已缓存，否则后台生成并持久化）
    // 效果：用户问"总结2026履历/分析整个XX文档"时，自动走 map-reduce 全量总结；
    // 第一次生成后写入知识库，之后刷新/重开/换浏览器都能直接复用，不再每次重新生成。
    // 无缓存时不阻塞本次回答（大文档全量生成需数分钟），改为后台生成；本次靠 buildKnowledgeContext 项⑤注入的整篇/整表缓存（命中时）
    // 与项⑦补充的具体正文切片提供完整内容。注意：缓存命中时不再在此重复注入，避免与 buildKnowledgeContext 项⑤重复。
    let scopeSummaryBlock = ''
    // 探索模式（第一步）只做目录引导，不触发整篇/整表总结生成
    if (kbEnabled && effectiveMode === 'detail') {
      // XML 数据导出不参与整篇总结（与「总结」按钮入口校验保持一致）：
      // 其检索由服务端页级倒排索引直接命中，而上万条记录的 map-reduce 必然撞 25 分钟上限中断，
      // 自动触发只会白烧算力。
      const intentDoc = documents.filter(d => d.status === 'approved' && d.type !== 'xml').find(d => detectSummaryIntent(text, d))
      if (intentDoc) {
        const intent = detectSummaryIntent(text, intentDoc)!
        const cacheKey = intent.full ? FULL_DOC_SUMMARY_KEY : intent.sheetName!
        const cached = getCachedSummary(intentDoc, cacheKey)
        if (!cached) {
          // 无缓存：后台生成并落库，本次不等待（避免提问中止/超时）；同一文档+标签页只启动一次
          const inflightKey = `${intentDoc.id}:${cacheKey}`
          if (!summaryInflight.current.has(inflightKey)) {
            summaryInflight.current.add(inflightKey)
            summarizeDocumentScope({
              doc: intentDoc,
              sheetName: intent.full ? undefined : intent.sheetName,
              instruction: text,
            })
              .then(summaryText => {
                if (!summaryText) return
                saveTableSummary(intentDoc, cacheKey, summaryText)
                  .then(({ tableSummaries }) => {
                    setDocuments(prev => prev.map(d => d.id === intentDoc.id ? { ...d, tableSummaries } : d))
                  })
                  .catch(() => {})
              })
              .catch(() => {})
              .finally(() => { summaryInflight.current.delete(inflightKey) })
          }
        }
      }
    }

    let finalKnowledgeContext = knowledgeContext + scopeSummaryBlock
    const kbMissHint = kbEnabled && !finalKnowledgeContext
      ? '\n\n## 知识库提示\n本次请求未注入知识库文档内容（知识库中未找到与用户问题相关的已入库文档）。请在回答开头明确提示用户："知识库中未找到相关内容"。随后基于你的通用知识（等同于外部检索）继续回答，并说明"以下内容来自外部检索/通用知识，未在知识库中找到"。\n'
      : ''
    finalKnowledgeContext += kbMissHint

    // MES 数据直查指引：问答栏选择了数据库1/数据库2 时，注入推荐 SQL 模板与硬性要求，
    // 允许模型输出一个 ```mes-sql 推荐查询，由系统按只读护栏执行后再回灌真实数据
    const mesActive = mesSource === 'db1' || mesSource === 'db2'
    if (mesActive) {
      const slotName = mesSlots.find(s => s.id === mesSource)?.name || (mesSource === 'db1' ? '数据库系统 1' : '数据库系统 2')
      finalKnowledgeContext += buildMesInstruction(mesGuideRef.current, mesSource, slotName)
    }

    // 深度思考模式：启用推理过程展示，并优先切换到支持推理的模型
    const reasoningModelId = deepThink ? (getReasoningModelId() || getProvider().defaultModel) : getProvider().defaultModel

    // 封装流式请求，便于"仅推理无正文"时自动重试一次；msgs 可指定（MES 第二轮会追加查询结果）
    const runStream = async (msgs: ChatMessageDto[] = llmMessages, useThinking = deepThink): Promise<void> => {
      await streamChat(msgs, {
      onThinking: (chunk) => {
        hasThinking = true
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            messages: c.messages.map(m => {
              if (m.id !== aiMsgId) return m
              const tIdx = m.contents.findIndex(ct => ct.type === 'thinking')
              if (tIdx >= 0) {
                const t = m.contents[tIdx]
                const steps = [...(t.thinkingSteps || [])]
                if (steps.length === 0) steps.push(chunk)
                else steps[steps.length - 1] += chunk
                const newContents = [...m.contents]
                newContents[tIdx] = { ...t, thinkingSteps: steps }
                return { ...m, contents: newContents }
              }
              return { ...m, contents: [{ type: 'thinking' as const, thinkingSteps: [chunk] }, ...m.contents] }
            }),
          }
        }))
      },
      onContent: (chunk) => {
        hasContent = true
        answerAccum += chunk
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            messages: c.messages.map(m => {
              if (m.id !== aiMsgId) return m
              const textBlock = m.contents.find(c => c.type === 'text')
              if (textBlock) {
                return {
                  ...m,
                  contents: m.contents.map(c =>
                    c.type === 'text' ? { ...c, text: (c.text || '') + chunk } : c
                  ),
                }
              }
              return {
                ...m,
                contents: [...m.contents, { type: 'text' as const, text: chunk }],
              }
            }),
          }
        }))
      },
      onError: (error) => {
        llmFailed = true
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            messages: c.messages.map(m => {
              if (m.id !== aiMsgId) return m
              if (hasContent) {
                // 已收到部分正文：保留已有内容，仅追加中断提示
                return {
                  ...m,
                  contents: [
                    ...m.contents,
                    { type: 'text' as const, text: `\n\n> ⚠️ 响应中断: ${error}` },
                  ],
                  isStreaming: false,
                }
              }
              // 无正文：生产环境明确报错不降级 Mock；DEV 环境降级到 Mock 响应
              if (import.meta.env.PROD) {
                return {
                  ...m,
                  contents: [
                    { type: 'text' as const, text: `> ⚠️ LLM 连接异常: ${error}\n> 请检查网络或 API Key 配置后重试。` },
                  ],
                  isStreaming: false,
                }
              }
              const aiContents = generateResponse(text)
              return {
                ...m,
                contents: [
                  { type: 'text' as const, text: `> ⚠️ LLM 连接异常: ${error}\n> 已切换到演示模式，以下为模拟回复。\n\n---\n` },
                  ...aiContents,
                ],
                isStreaming: false,
              }
            }),
          }
        }))
      },
      onDone: () => {
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            messages: c.messages.map(m => {
              if (m.id !== aiMsgId) return m
              return { ...m, isStreaming: false }
            }),
          }
        }))
      },
    }, {
      knowledgeContext: finalKnowledgeContext,
      useThinking,
      modelId: reasoningModelId,
    })
  }

  await runStream()

  // 仅返回推理过程、无正文：自动重试一次（模型首次可能只输出推理而未生成正文）
  if (hasThinking && !hasContent && !llmFailed) {
    hasThinking = false
    hasContent = false
    answerAccum = ''
    // 清空上一轮思考内容，保留等待状态
    setConversations(prev => prev.map(c => {
      if (c.id !== convId) return c
      return {
        ...c,
        messages: c.messages.map(m => m.id === aiMsgId ? { ...m, contents: m.contents.filter(ct => ct.type !== 'thinking'), isStreaming: true } : m),
      }
    }))
    await runStream()
  }

  // ===== MES 数据直查第二轮 =====
  // 模型在第一轮回答里给出了 ```mes-sql 推荐查询：按硬性要求（仅 SELECT / 行数上限 /
  // 连接与语句超时，走所选数据库槽位）执行，把真实结果回灌，让模型基于具体数据作答。
  if (mesActive && hasContent && !llmFailed) {
    const mesSql = extractMesSql(answerAccum)
    if (mesSql) {
      const slotName = mesSlots.find(s => s.id === mesSource)?.name || (mesSource === 'db1' ? '数据库系统 1' : '数据库系统 2')
      const mesSourceNote = extractMesSource(answerAccum.replace(/```mes-sql[\s\S]*?```/, ''))
      // 在回答中留下「已执行查询」的可见标记（含所用 SQL 与来源）
      const marker = `\n\n> 🗄️ 正在按以下 SQL 查询「${slotName}」（只读，服务端强制行数上限与超时）…\n> 来源：${mesSourceNote || '未标注'}\n\n\`\`\`sql\n${mesSql}\n\`\`\`\n`
      setConversations(prev => prev.map(c => {
        if (c.id !== convId) return c
        return {
          ...c,
          messages: c.messages.map(m => {
            if (m.id !== aiMsgId) return m
            const textBlock = m.contents.find(ct => ct.type === 'text')
            if (textBlock) {
              return { ...m, contents: m.contents.map(ct => ct.type === 'text' ? { ...ct, text: (ct.text || '') + marker } : ct) }
            }
            return { ...m, contents: [{ type: 'text' as const, text: marker }] }
          }),
        }
      }))
      try {
        const result = await queryMesData({ slot: mesSource, sql: mesSql })
        const doneNote = `已在「${result.slotName}」执行只读查询（${result.rowCount} 行 / ${result.elapsedMs}ms${result.truncated ? '，已按行数上限截断' : ''}）`
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            messages: c.messages.map(m => {
              if (m.id !== aiMsgId) return m
              return {
                ...m,
                contents: m.contents.map(ct => ct.type === 'text' ? { ...ct, text: (ct.text || '').replace(/> 🗄️ 正在按以下 SQL 查询「[^」]*」（只读，服务端强制行数上限与超时）…/, `> 🗄️ ${doneNote}`) } : ct),
                isStreaming: true,
              }
            }),
          }
        }))
        const followup: ChatMessageDto = {
          role: 'user',
          content:
            `【MES 查询结果】\n已在「${result.slotName}」执行以下只读查询（${result.rowCount} 行，耗时 ${result.elapsedMs}ms${result.truncated ? '，结果已按行数上限截断' : ''}）：\n${result.sql}\n\n查询结果（JSON 行）：\n${formatMesRows(result)}\n\n请基于以上**真实查询数据**回答用户最初的问题：给出具体数值与必要的数据分析，并在回答里注明所用 SQL 与其来源（${mesSourceNote || '未标注'}）；如果数据不足以回答，请明确说明缺什么，不要编造数值。`,
        }
        await runStream(
          [...llmMessages, { role: 'assistant' as const, content: answerAccum }, followup],
          false // 第二轮不再单独输出思考块，直接给出基于数据的回答
        )
      } catch (err: any) {
        const msg = err?.message || String(err)
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            messages: c.messages.map(m => {
              if (m.id !== aiMsgId) return m
              return {
                ...m,
                contents: m.contents.map(ct => ct.type === 'text' ? { ...ct, text: (ct.text || '').replace(/> 🗄️ 正在按以下 SQL 查询「[^」]*」（只读，服务端强制行数上限与超时）…/, `> ⚠️ 查询失败：${msg}`)} : ct),
                isStreaming: false,
              }
            }),
          }
        }))
      }
    }
  }

    // LLM 完全无响应（无正文且无推理过程）且未报错时：生产环境明确报错，DEV 环境降级到 Mock
    if (!hasContent && !hasThinking && !llmFailed) {
      if (import.meta.env.PROD) {
        setConversations(prev => prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            messages: c.messages.map(m => m.id === aiMsgId ? {
              ...m,
              contents: [{ type: 'text' as const, text: '> ⚠️ LLM 无响应，请检查网络或 API Key 配置后重试。' }],
              isStreaming: false,
            } : m),
          }
        }))
      } else {
        const aiContents = generateResponse(text)
        for (let i = 0; i < aiContents.length; i++) {
          await new Promise(resolve => setTimeout(resolve, i === 0 ? 400 : 800))
          setConversations(prev => prev.map(c => {
            if (c.id !== convId) return c
            return {
              ...c,
              messages: c.messages.map(m => {
                if (m.id !== aiMsgId) return m
                return {
                  ...m,
                  contents: aiContents.slice(0, i + 1),
                  isStreaming: i < aiContents.length - 1,
                }
              }),
            }
          }))
        }
      }
    }
    // 仅返回了推理过程、无正文：保留思考内容，追加提示（不要覆盖为欢迎语）
    else if (hasThinking && !hasContent && !llmFailed) {
      setConversations(prev => prev.map(c => {
        if (c.id !== convId) return c
        return {
          ...c,
          messages: c.messages.map(m => {
            if (m.id !== aiMsgId) return m
            return {
              ...m,
              contents: [
                ...m.contents,
                { type: 'text' as const, text: `> ⚠️ 深度思考已结束，但未生成正式回答（模型可能仅返回推理过程或流被截断）。请重试，或关闭"深度思考"后提问。` },
              ],
              isStreaming: false,
            }
          }),
        }
      }))
    }
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (aiMsgId && convId) {
      setConversations(prev => prev.map(c => {
        if (c.id !== convId) return c
        return {
          ...c,
          messages: c.messages.map(m => m.id === aiMsgId ? {
            ...m,
            contents: [{ type: 'text' as const, text: `> ⚠️ 发送失败: ${msg}\n> 请检查配置或网络后重试。` }],
            isStreaming: false,
          } : m),
        }
      }))
    } else {
      console.error('handleSendMessage error:', err)
    }
  }
}, [activeId, openApiKeyModal, useKnowledgeBase, documents, deepThink, mesSource, mesSlots])

  // 删除对话
  const handleDeleteConversation = useCallback((id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeId === id) setActiveId(null)
  }, [activeId])

  // 登录成功
  const handleLogin = useCallback((loggedInUser: User) => {
    setUser(loggedInUser)
    setShowAuthModal(false)
    // 登录后一律回到智能问答主界面，避免残留的上一个账号所处视图（如用户管理）被带入
    setSidebarView('chat')
    if (loggedInUser.mustChangePassword) {
      setForceChangePassword(true)
      setShowChangePassword(true)
    }
  }, [])

  // 退出登录
  const handleLogout = useCallback(() => {
    clearSession()
    setUser(null)
    // 退出后重置导航到智能问答主界面，避免下一个登录的账号继承本视图（权限/越权问题）
    setSidebarView('chat')
    setShowChangePassword(false)
    setForceChangePassword(false)
  }, [])

  // 密码修改成功
  const handlePasswordChanged = useCallback((updated: User) => {
    setUser(updated)
    setShowChangePassword(false)
    setForceChangePassword(false)
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-mes-bg">
      {/* 侧边栏 */}
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        sidebarView={sidebarView}
        sidebarOpen={sidebarOpen}
        user={user}
        documents={documents}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onSwitchView={setSidebarView}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onOpenAuth={() => setShowAuthModal(true)}
        onLogout={handleLogout}
        onRequestChangePassword={() => { setForceChangePassword(false); setShowChangePassword(true) }}
        onOpenApiSettings={() => openApiKeyModal(false)}
      />

      {/* 主内容区域 */}
      <div className="flex-1 flex flex-col overflow-hidden" ref={chatAreaRef}>
        {/* 顶部栏 */}
        <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-mes-border shrink-0">
          <div className="flex items-center gap-3">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            )}
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-mes-primary flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
                  <path d="M16 7L25 12V20L16 25L7 20V12L16 7Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
                  <circle cx="16" cy="16" r="3" fill="white" />
                </svg>
              </div>
              <span className="font-semibold text-mes-text">AI 智能助手</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText font-medium">{APP_VERSION}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* LLM 状态指示器 */}
            {apiKeyReady ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-mes-textTertiary">{getProvider().name}</span>
                <div className="w-2 h-2 rounded-full bg-mes-success animate-pulse" />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-orange-500">未配置 API Key</span>
                <div className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
              </div>
            )}
            {/* API Key 配置按钮 */}
            <button
              onClick={() => openApiKeyModal(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-mes-textSecondary border border-mes-border hover:bg-gray-50 hover:border-mes-primary transition-colors"
              title="配置 AI 模型 API Key"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
              {apiKeyReady ? '已配置' : '配置 Key'}
            </button>
          </div>
        </header>

        {/* 内容区域 */}
        <div className="flex-1 overflow-hidden">
          {sidebarView === 'usermanagement' && canAccessUserManagement(user) ? (
            user ? (
              <UserManagement
                currentUser={user}
                onUserListChanged={() => {}}
              />
            ) : (
              <WelcomeScreen
                presetQuestions={presetQuestions}
                onQuestionClick={handleSendMessage}
                useKnowledgeBase={useKnowledgeBase}
                onToggleKnowledgeBase={() => setUseKnowledgeBase(!useKnowledgeBase)}
                deepThink={deepThink}
                onToggleDeepThink={() => setDeepThink(d => !d)}
              />
            )
          ) : sidebarView === 'dbmanage' && canAccessDatabaseManagement(user) ? (
            <DatabaseManage />
          ) : sidebarView === 'apc' ? (
            <ApcRto />
          ) : sidebarView === 'knowledge' ? (
            <KnowledgeBase
              documents={documents}
              currentUser={user}
              onDocumentsChange={setDocuments}
              onRequireLogin={() => setShowAuthModal(true)}
            />
          ) : !activeConversation ? (
            <WelcomeScreen
              presetQuestions={presetQuestions}
              onQuestionClick={handleSendMessage}
              useKnowledgeBase={useKnowledgeBase}
              onToggleKnowledgeBase={() => setUseKnowledgeBase(!useKnowledgeBase)}
              deepThink={deepThink}
              onToggleDeepThink={() => setDeepThink(d => !d)}
            />
          ) : (
            <ChatArea
              conversation={activeConversation}
              onSendMessage={handleSendMessage}
              useKnowledgeBase={useKnowledgeBase}
              onToggleKnowledgeBase={() => setUseKnowledgeBase(!useKnowledgeBase)}
              currentUser={user}
              deepThink={deepThink}
              onToggleDeepThink={() => setDeepThink(d => !d)}
              mesSource={mesSource}
              mesSlots={mesSlots}
              onMesSourceChange={handleMesSourceChange}
            />
          )}
        </div>
      </div>

      {/* API Key 配置弹窗 */}
      {showApiKeyModal && (
        <ApiKeyModal
          onClose={() => setShowApiKeyModal(false)}
          onSaved={handleApiKeySaved}
          forceOpen={apiKeyModalForce}
        />
      )}

      {/* 登录弹窗（侧边栏仅提供登录，注册由用户管理模块负责） */}
      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onLogin={handleLogin}
        />
      )}

      {/* 修改密码弹窗（首次登录强制 / 主动修改） */}
      {showChangePassword && user && (
        <ChangePasswordModal
          user={user}
          force={forceChangePassword}
          onClose={() => { if (!forceChangePassword) setShowChangePassword(false) }}
          onChanged={handlePasswordChanged}
        />
      )}

      {/* 全局报错报警弹窗：把被静默吞掉的报错（解析失败/日志写入失败/接口异常）呈现给用户 */}
      <ErrorToasts />
    </div>
  )
}
