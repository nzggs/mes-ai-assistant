import { useState, useRef, useEffect } from 'react'

export type MesSource = 'off' | 'db1' | 'db2'

export interface MesSlotInfo {
  id: string
  name: string
  configured: boolean
}

interface ChatInputProps {
  onSend: (text: string) => void
  disabled: boolean
  useKnowledgeBase: boolean
  onToggleKnowledgeBase: () => void
  deepThink: boolean
  onToggleDeepThink: () => void
  /** 问答环节的数据源选择：关闭 / 数据库1 / 数据库2 */
  mesSource?: MesSource
  mesSlots?: MesSlotInfo[]
  onMesSourceChange?: (s: MesSource) => void
}

export function ChatInput({
  onSend,
  disabled,
  useKnowledgeBase,
  onToggleKnowledgeBase,
  deepThink,
  onToggleDeepThink,
  mesSource = 'off',
  mesSlots = [],
  onMesSourceChange,
}: ChatInputProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 自动调整高度
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }, [text])

  const handleSend = () => {
    if (!text.trim() || disabled) return
    onSend(text.trim())
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="relative">
      <div className={`flex flex-col rounded-2xl border bg-white transition-all-smooth ${
        disabled ? 'border-mes-border opacity-60' : 'border-mes-border focus-within:border-mes-primary focus-within:shadow-md'
      }`}>
        {/* 文本输入区域 */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? 'AI 正在回复中...' : '输入您的问题，按 Enter 发送，Shift+Enter 换行'}
          rows={1}
          className="w-full px-4 pt-3.5 pb-2 text-sm resize-none outline-none placeholder:text-mes-textTertiary disabled:cursor-not-allowed"
          style={{ maxHeight: '200px' }}
        />

        {/* 底部工具栏 */}
        <div className="flex items-center justify-between px-3 pb-2.5">
          <div className="flex items-center gap-1">
            {/* 深度思考模式 */}
            <button
              onClick={onToggleDeepThink}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all-smooth ${
                deepThink
                  ? 'bg-mes-tagBg text-mes-primary'
                  : 'text-mes-textSecondary hover:bg-gray-100'
              }`}
              title="深度思考模式：展示 AI 推理过程"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
              </svg>
              深度思考
            </button>

            {/* 知识库检索 */}
            <button
              onClick={onToggleKnowledgeBase}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all-smooth ${
                useKnowledgeBase
                  ? 'bg-mes-tagBg text-mes-primary'
                  : 'text-mes-textSecondary hover:bg-gray-100'
              }`}
              title={useKnowledgeBase ? '已启用知识库检索' : '点击启用知识库检索'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              知识库
            </button>

            {/* MES 数据源选择：关闭 / 数据库1 / 数据库2。
                选择某个数据库后，问答可按「数据源配置」里推荐的 SQL 与硬性要求
                （仅 SELECT、行数上限、连接/语句超时）检索出具体数据。 */}
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all-smooth ${
                mesSource !== 'off' ? 'bg-mes-tagBg text-mes-primary' : 'text-mes-textSecondary hover:bg-gray-100'
              }`}
              title="选择 MES 数据源后，AI 可按只读护栏（仅 SELECT、行数上限、超时限制）检索具体过程数据"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              <select
                value={mesSource}
                onChange={e => onMesSourceChange(e.target.value as MesSource)}
                disabled={disabled}
                className="bg-transparent text-xs font-medium outline-none cursor-pointer disabled:cursor-not-allowed max-w-[110px]"
              >
                <option value="off">数据库关闭</option>
                {mesSlots.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id}{s.configured ? '' : '（未配置）'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 发送按钮 */}
          <button
            onClick={handleSend}
            disabled={!text.trim() || disabled}
            className={`p-2 rounded-lg transition-all-smooth ${
              text.trim() && !disabled
                ? 'bg-mes-primary text-white hover:bg-mes-primaryHover shadow-sm'
                : 'bg-gray-200 text-mes-textTertiary cursor-not-allowed'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
