import type { PresetQuestion } from '../types'
import { ChatInput } from './ChatInput'

interface WelcomeScreenProps {
  presetQuestions: PresetQuestion[]
  onQuestionClick: (question: string) => void
  useKnowledgeBase: boolean
  onToggleKnowledgeBase: () => void
  deepThink: boolean
  onToggleDeepThink: () => void
}

export function WelcomeScreen({
  presetQuestions,
  onQuestionClick,
  useKnowledgeBase,
  onToggleKnowledgeBase,
  deepThink,
  onToggleDeepThink,
}: WelcomeScreenProps) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-4 overflow-y-auto">
      <div className="w-full max-w-3xl flex flex-col items-center animate-slide-up">
        {/* Logo */}
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-mes-primary to-purple-500 flex items-center justify-center mb-6 shadow-lg">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <path d="M16 7L25 12V20L16 25L7 20V12L16 7Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="16" cy="16" r="3" fill="white" />
          </svg>
        </div>

        {/* 标题 */}
        <h1 className="text-2xl font-bold text-mes-text mb-2">
          AI 智能助手
        </h1>
        <p className="text-mes-textSecondary text-sm mb-8 text-center max-w-xl">
          基于 RAG 知识库的智能问答助手
          <br />
          异常分析 · 参数调优 · 数据查询 · 知识检索
        </p>

        {/* 预设问题卡片 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mb-6">
          {presetQuestions.map((preset, idx) => (
            <button
              key={idx}
              onClick={() => onQuestionClick(preset.question)}
              className="group flex flex-col items-start p-4 rounded-xl border border-mes-border bg-white hover:border-mes-primary hover:shadow-md transition-all-smooth text-left"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xl">{preset.icon}</span>
                <span className="text-xs font-medium text-mes-tagText bg-mes-tagBg px-2 py-0.5 rounded-full">
                  {preset.category}
                </span>
              </div>
              <p className="text-sm font-medium text-mes-text mb-1 group-hover:text-mes-primary transition-colors">
                {preset.question}
              </p>
              <p className="text-xs text-mes-textTertiary">
                {preset.description}
              </p>
            </button>
          ))}
        </div>

        {/* 输入框 */}
        <div className="w-full">
          <ChatInput
            onSend={onQuestionClick}
            disabled={false}
            useKnowledgeBase={useKnowledgeBase}
            onToggleKnowledgeBase={onToggleKnowledgeBase}
            deepThink={deepThink}
            onToggleDeepThink={onToggleDeepThink}
          />
        </div>

        {/* 功能提示 */}
        <div className="flex items-center gap-4 mt-4 text-xs text-mes-textTertiary">
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            私有化部署
          </span>
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            数据不出厂
          </span>
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            响应快速
          </span>
        </div>
      </div>
    </div>
  )
}
