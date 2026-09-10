import { useState, useCallback, useRef, useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { KnowledgeBase } from './components/KnowledgeBase'
import { WelcomeScreen } from './components/WelcomeScreen'
import { ApiKeyModal } from './components/ApiKeyModal'
import { AuthModal, getSession, clearSession, type User } from './components/AuthModal'
import { UserManagement } from './components/UserManagement'
import { ChangePasswordModal } from './components/ChangePasswordModal'
import ErrorToasts from './components/ErrorToasts'
import { generateResponse, initialConversations, presetQuestions } from './data/mockData'
import { streamChat, hasApiKey, getProvider, getReasoningModelId, summarizeHistory, type ChatMessageDto } from './services/llmApi'
import { buildKnowledgeContext, decideRetrievalMode, detectSummaryIntent, getCachedSummary, FULL_DOC_SUMMARY_KEY, summarizeDocumentScope } from './services/knowledgeService'
import { ensureSuperAdminSeeded, syncUsersFromBackend, canAccessUserManagement } from './services/userService'
import { getAllDocs, restoreDocsFromRecords, syncLocalToBackend, saveTableSummary, fetchAllDocPages } from './services/docStore'
import { resolveServerHits, type ServerSearchHit } from './services/searchApi'
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

    // 构建知识库上下文（仅当启用知识库检索时，传入用户查询实现智能检索）
    // 三态：
    // 1) 知识库未点亮 -> 不注入任何知识库内容，直接通用/外网知识回答
    // 2) 点亮且检索到内容 -> 注入文档内容，优先从最新知识库检索归纳并注明出处
    // 3) 点亮但未检索到内容 -> 注入"未命中"提示，要求先告知"知识库中未找到相关内容"，再转外部/通用知识
    const kbEnabled = useKnowledgeBase
    // 知识库注入上限：按当前模型上下文窗口的 80%（封顶 160000），给长 SQL 完整语句注入留足空间。
    // 模型输出仍占窗口，但系统提示/历史消息不通过本限值注入，80% 是安全上界（minimax 200k→160k、deepseek 64k→52k）
    const kbContextLimit = Math.min(160000, Math.round((getProvider().contextWindow || 65536) * 0.8))

    // ===== 服务端检索（第二阶段）：超大文档的正文不常驻浏览器，只能由服务端倒排索引检索 =====
    // 结果直接喂给 buildKnowledgeContext（可选参数），索引未就绪时返回空数组 → 自动走本地既有路径。
    let serverHits: ServerSearchHit[] = []
    if (kbEnabled) {
      serverHits = await resolveServerHits(text, documents, {
        topK: kbContextLimit >= 80000 ? 30 : 15,
        perHitChars: 6000,
        timeoutMs: 5000,
      })
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
            deferredFilled.current.add(d.id)
            const pages = await fetchAllDocPages(d.id)
            return { id: d.id, patch: { ...d, content: pages, contentOmitted: false } }
          }))
          if (patches.length > 0) {
            const map = new Map(patches.map(p => [p.id, p.patch]))
            setDocuments(prev => prev.map(d => map.get(d.id) || d))
            docsForContext = documents.map(d => map.get(d.id) || d)
          }
        } catch (e) {
          console.warn('超大文档正文按需补全失败（将继续使用已有内容）:', e)
        }
      }
    }

    // 两步提问法：自动触发，无需手动选择检索模式。
    // 已收窄：只有用户「明确在问知识库里有哪些资料」时才走探索（只列目录、让用户挑一篇）；
    // 其余问题一律走详解——服务端倒排索引已能把相关对象/正文取回来，再让用户先挑文档属于多此一举。
    // （旧逻辑是「没点名文档就走探索」，导致「开发 XX 功能」这类问题只回一串文档名，拿不到正文。）
    const effectiveMode = decideRetrievalMode(text, documents)

    const knowledgeContext = kbEnabled ? buildKnowledgeContext(docsForContext, text, kbContextLimit, effectiveMode, serverHits) : ''

    // 项⑤：整体归纳意图自动触发整表总结（优先用已缓存，否则后台生成并持久化）
    // 效果：用户问"总结2026履历/分析整个XX文档"时，自动走 map-reduce 全量总结；
    // 第一次生成后写入知识库，之后刷新/重开/换浏览器都能直接复用，不再每次重新生成。
    // 无缓存时不阻塞本次回答（大文档全量生成需数分钟），改为后台生成；本次靠 buildKnowledgeContext 项⑤注入的整篇/整表缓存（命中时）
    // 与项⑦补充的具体正文切片提供完整内容。注意：缓存命中时不再在此重复注入，避免与 buildKnowledgeContext 项⑤重复。
    let scopeSummaryBlock = ''
    // 探索模式（第一步）只做目录引导，不触发整篇/整表总结生成
    if (kbEnabled && effectiveMode === 'detail') {
      const intentDoc = documents.filter(d => d.status === 'approved').find(d => detectSummaryIntent(text, d))
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

    // 深度思考模式：启用推理过程展示，并优先切换到支持推理的模型
    const reasoningModelId = deepThink ? (getReasoningModelId() || getProvider().defaultModel) : getProvider().defaultModel

    // 封装流式请求，便于"仅推理无正文"时自动重试一次
    const runStream = async (): Promise<void> => {
      await streamChat(llmMessages, {
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
      useThinking: deepThink,
      modelId: reasoningModelId,
    })
  }

  await runStream()

  // 仅返回推理过程、无正文：自动重试一次（模型首次可能只输出推理而未生成正文）
  if (hasThinking && !hasContent && !llmFailed) {
    hasThinking = false
    hasContent = false
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
}, [activeId, openApiKeyModal, useKnowledgeBase, documents, deepThink])

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
