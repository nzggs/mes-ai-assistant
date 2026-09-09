import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../types'
import type { User } from '../services/userService'
import { exportMarkdownAsWord, sanitizeFilename } from '../utils/exportWord'
import { ThinkingBlock } from './ThinkingBlock'
import { AnalysisTreeView } from './AnalysisTreeView'
import { ParamCardView } from './ParamCardView'
import { SourceListView } from './SourceListView'
import { MesDataView } from './MesDataView'

interface MessageBubbleProps {
  message: ChatMessage
  currentUser?: User | null
  /** 该回答对应的用户问题概述，用于导出文件名（不超过 30 个汉字） */
  userQuery?: string
}

export function MessageBubble({ message, currentUser, userQuery }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  // 用户头像显示登录账号的首个字符，与当前账号保持一致
  const userInitial = (currentUser?.displayName || currentUser?.username || '我')
    .trim()
    .charAt(0)
    .toUpperCase()

  // 导出整条回答（拼接所有 text 内容）为 Word
  const handleExportWord = () => {
    const mdText = message.contents
      .filter(c => c.type === 'text' && (c.text || '').trim())
      .map(c => c.text)
      .join('\n\n')
    if (!mdText) return
    // 用问题概述做文件名；取前 30 个汉字并清理非法字符
    const query = (userQuery || '').trim()
    const filename = query ? sanitizeFilename(query, 30) : `AI回答_${Date.now()}`
    exportMarkdownAsWord(mdText, filename)
  }

  return (
    <div className={`flex gap-3 animate-slide-up ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* 头像 */}
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
        isUser
          ? 'bg-gradient-to-br from-blue-500 to-cyan-500'
          : 'bg-gradient-to-br from-mes-primary to-purple-500'
      }`}>
        {isUser ? (
          <span className="text-white text-xs font-medium">{userInitial}</span>
        ) : (
          <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
            <path d="M16 7L25 12V20L16 25L7 20V12L16 7Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="16" cy="16" r="3" fill="white" />
          </svg>
        )}
      </div>

      {/* 消息内容 */}
      <div className={`flex-1 min-w-0 ${isUser ? 'flex justify-end' : ''}`}>
        <div className={`inline-block max-w-full ${isUser ? '' : 'w-full'}`}>
          {message.contents.map((content, idx) => (
            <ContentRenderer key={idx} content={content} isUser={isUser} isLast={idx === message.contents.length - 1 && !!message.isStreaming} />
          ))}
          {!isUser && !message.isStreaming && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-mes-textTertiary select-none">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              <span>内容为AI生成，仅供参考</span>
              <span className="text-mes-textTertiary/40">·</span>
              <button
                onClick={handleExportWord}
                title="将本条回答导出为 Word 下载到本地"
                className="flex items-center gap-1 hover:text-mes-primary transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                导出 Word
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ContentRenderer({ content, isUser, isLast }: {
  content: ChatMessage['contents'][0]
  isUser: boolean
  isLast: boolean
}) {
  switch (content.type) {
    case 'text':
      if (isUser) {
        return (
          <div className="px-4 py-2.5 rounded-2xl rounded-tr-md bg-mes-primary text-white text-sm">
            {content.text}
          </div>
        )
      }
      return (
        <div className="markdown-content text-mes-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content.text || ''}
          </ReactMarkdown>
          {isLast && <span className="typing-cursor" />}
        </div>
      )

    case 'thinking':
      return <ThinkingBlock steps={content.thinkingSteps || []} />

    case 'analysisTree':
      return content.tree ? <AnalysisTreeView tree={content.tree} /> : null

    case 'paramCard':
      return <ParamCardView params={content.params || []} />

    case 'sourceList':
      return <SourceListView sources={content.sources || []} />

    case 'mesData':
      return content.mesData ? <MesDataView data={content.mesData} /> : null

    default:
      return null
  }
}
