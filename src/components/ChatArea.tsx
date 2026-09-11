import { useEffect, useRef } from 'react'
import type { Conversation } from '../types'
import type { User } from '../services/userService'
import { MessageBubble } from './MessageBubble'
import { ChatInput, type MesSource, type MesSlotInfo } from './ChatInput'

interface ChatAreaProps {
  conversation: Conversation
  onSendMessage: (text: string) => void
  useKnowledgeBase: boolean
  onToggleKnowledgeBase: () => void
  currentUser?: User | null
  deepThink: boolean
  onToggleDeepThink: () => void
  mesSource?: MesSource
  mesSlots?: MesSlotInfo[]
  onMesSourceChange?: (s: MesSource) => void
}

export function ChatArea({
  conversation,
  onSendMessage,
  useKnowledgeBase,
  onToggleKnowledgeBase,
  currentUser,
  deepThink,
  onToggleDeepThink,
  mesSource = 'off',
  mesSlots = [],
  onMesSourceChange,
}: ChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isStreaming = conversation.messages.some(m => m.isStreaming)

  // 构建 消息ID -> 上一条用户问题文本 的映射（供导出 Word 文件名使用）
  const userQueryByMsgId: Record<string, string> = {}
  {
    let lastQuery = ''
    for (const m of conversation.messages) {
      if (m.role === 'user') {
        lastQuery = m.contents
          .filter(c => c.type === 'text' && (c.text || '').trim())
          .map(c => c.text)
          .join(' ')
      } else {
        userQueryByMsgId[m.id] = lastQuery
      }
    }
  }

  // 自动滚动到底部
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [conversation.messages])

  return (
    <div className="h-full flex flex-col">
      {/* 消息列表 */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
          {conversation.messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              currentUser={currentUser}
              userQuery={msg.role === 'assistant' ? userQueryByMsgId[msg.id] : undefined}
            />
          ))}

          {/* 流式输出时的加载指示器 */}
          {isStreaming && (
            <div className="flex items-center gap-2 text-mes-textTertiary text-sm pl-12">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-mes-primary animate-pulse" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-mes-primary animate-pulse" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-mes-primary animate-pulse" style={{ animationDelay: '300ms' }} />
              </div>
              <span>正在分析中...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 输入区域 */}
      <div className="shrink-0 px-4 pb-4 pt-2">
        <div className="max-w-3xl mx-auto">
          <ChatInput
            onSend={onSendMessage}
            disabled={isStreaming}
            useKnowledgeBase={useKnowledgeBase}
            onToggleKnowledgeBase={onToggleKnowledgeBase}
            deepThink={deepThink}
            onToggleDeepThink={onToggleDeepThink}
            mesSource={mesSource}
            mesSlots={mesSlots}
            onMesSourceChange={onMesSourceChange}
          />
        </div>
      </div>
    </div>
  )
}
