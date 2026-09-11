import { useState } from 'react'
import type { Conversation, SidebarView, KnowledgeDoc } from '../types'
import type { User } from './AuthModal'
import { canAccessUserManagement, canAccessDatabaseManagement } from '../services/userService'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  sidebarView: SidebarView
  sidebarOpen: boolean
  user: User | null
  documents: KnowledgeDoc[]
  onNewChat: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onSwitchView: (view: SidebarView) => void
  onToggle: () => void
  onOpenAuth: () => void
  onLogout: () => void
  onRequestChangePassword: () => void
  onOpenApiSettings: () => void
}

export function Sidebar({
  conversations,
  activeId,
  sidebarView,
  sidebarOpen,
  user,
  documents,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onSwitchView,
  onToggle,
  onOpenAuth,
  onLogout,
  onRequestChangePassword,
  onOpenApiSettings,
}: SidebarProps) {
  const [searchTerm, setSearchTerm] = useState('')

  const filteredConversations = conversations.filter(c =>
    c.title.toLowerCase().includes(searchTerm.toLowerCase())
  )

  // 按时间分组
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayConvs = filteredConversations.filter(c => c.updatedAt >= today.getTime())
  const earlierConvs = filteredConversations.filter(c => c.updatedAt < today.getTime())

  if (!sidebarOpen) return null

  return (
    <aside className="w-64 h-full bg-mes-sidebar border-r border-mes-border flex flex-col shrink-0 animate-fade-in">
      {/* Logo + 折叠按钮 */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-mes-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-mes-primary flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
              <path d="M16 7L25 12V20L16 25L7 20V12L16 7Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="16" cy="16" r="3" fill="white" />
            </svg>
          </div>
          <span className="font-semibold text-sm text-mes-text">AI 智能助手</span>
        </div>
        <button
          onClick={onToggle}
          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-mes-textSecondary"
          title="折叠侧边栏"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      </div>

      {/* 新建对话按钮 */}
      <div className="p-3">
        <button
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-mes-primary text-white font-medium text-sm hover:bg-mes-primaryHover transition-all-smooth shadow-sm hover:shadow-md"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          新建对话
        </button>
      </div>

      {/* 导航菜单 */}
      <div className="px-3 pb-2 space-y-0.5">
        <NavButton
          active={sidebarView === 'chat'}
          onClick={() => onSwitchView('chat')}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          }
          label="智能问答"
        />
        <NavButton
          active={sidebarView === 'apc'}
          onClick={() => onSwitchView('apc')}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v18h18" />
              <path d="M7 15l3.5-4.5 3 2.5L20 6" />
              <circle cx="7" cy="15" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="20" cy="6" r="1.4" fill="currentColor" stroke="none" />
            </svg>
          }
          label="APC和RTO"
        />
        <NavButton
          active={sidebarView === 'knowledge'}
          onClick={() => onSwitchView('knowledge')}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          }
          label="知识库管理"
          badge={String(documents.length)}
        />
        {/* 用户管理（仅 IT 部管理员可见） */}
        {canAccessUserManagement(user) && (
          <NavButton
            active={sidebarView === 'usermanagement'}
            onClick={() => onSwitchView('usermanagement')}
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            }
            label="用户管理"
          />
        )}
      </div>

      {/* 搜索框 */}
      <div className="px-3 pb-2">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mes-textTertiary" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="搜索对话..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
          />
        </div>
      </div>

      {/* 对话列表 */}
      <div className="flex-1 overflow-y-auto px-2">
        {filteredConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-mes-textTertiary">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-40">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-xs">暂无对话记录</p>
            <p className="text-xs mt-1">点击"新建对话"开始</p>
          </div>
        ) : (
          <>
            {todayConvs.length > 0 && (
              <div className="mb-2">
                <p className="px-2 py-1 text-xs font-medium text-mes-textTertiary">今天</p>
                {todayConvs.map(conv => (
                  <ConversationItem
                    key={conv.id}
                    conv={conv}
                    active={conv.id === activeId && sidebarView === 'chat'}
                    onClick={() => onSelectConversation(conv.id)}
                    onDelete={() => onDeleteConversation(conv.id)}
                  />
                ))}
              </div>
            )}
            {earlierConvs.length > 0 && (
              <div className="mb-2">
                <p className="px-2 py-1 text-xs font-medium text-mes-textTertiary">更早</p>
                {earlierConvs.map(conv => (
                  <ConversationItem
                    key={conv.id}
                    conv={conv}
                    active={conv.id === activeId && sidebarView === 'chat'}
                    onClick={() => onSelectConversation(conv.id)}
                    onDelete={() => onDeleteConversation(conv.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部用户信息 */}
      <div className="border-t border-mes-border p-3">
        {user ? (
          <UserMenu user={user} onLogout={onLogout} onRequestChangePassword={onRequestChangePassword} onOpenApiSettings={onOpenApiSettings} />
        ) : (
          <button
            onClick={onOpenAuth}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-mes-tagBg text-mes-primary text-sm font-medium hover:bg-mes-primary hover:text-white transition-all-smooth"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <polyline points="10 17 15 12 10 7" />
              <line x1="15" y1="12" x2="3" y2="12" />
            </svg>
            登录
          </button>
        )}
      </div>
    </aside>
  )
}

function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  badge?: string
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all-smooth ${
        active
          ? 'bg-mes-tagBg text-mes-primary'
          : 'text-mes-textSecondary hover:bg-gray-100 hover:text-mes-text'
      }`}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {badge && (
        <span className="text-xs px-1.5 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText">
          {badge}
        </span>
      )}
    </button>
  )
}

function ConversationItem({
  conv,
  active,
  onClick,
  onDelete,
}: {
  conv: Conversation
  active: boolean
  onClick: () => void
  onDelete: () => void
}) {
  const [showDelete, setShowDelete] = useState(false)

  return (
    <div
      onMouseEnter={() => setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
      className={`group relative rounded-lg transition-all-smooth ${
        active ? 'bg-mes-tagBg' : 'hover:bg-gray-100'
      }`}
    >
      <button
        onClick={onClick}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`shrink-0 ${active ? 'text-mes-primary' : 'text-mes-textTertiary'}`}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className={`flex-1 text-sm truncate ${active ? 'text-mes-primary font-medium' : 'text-mes-text'}`}>
          {conv.title}
        </span>
      </button>
      {showDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-red-50 text-mes-textTertiary hover:text-mes-danger transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}
    </div>
  )
}

function UserMenu({ user, onLogout, onRequestChangePassword, onOpenApiSettings }: { user: User; onLogout: () => void; onRequestChangePassword: () => void; onOpenApiSettings: () => void }) {
  const [showMenu, setShowMenu] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const avatarChar = (user.displayName || user.username).charAt(0).toUpperCase()

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="w-full flex items-center gap-2 p-1.5 rounded-xl hover:bg-gray-100 transition-colors"
      >
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-mes-primary to-purple-500 flex items-center justify-center text-white text-sm font-medium shrink-0">
          {avatarChar}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium text-mes-text truncate">{user.displayName}</p>
          <p className="text-xs text-mes-textTertiary truncate">{user.department}</p>
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-mes-textTertiary transition-transform ${showMenu ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* 下拉菜单 */}
      {showMenu && (
        <>
          {/* 点击空白关闭 */}
          <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
          <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-mes-border bg-white shadow-lg py-1 z-20 animate-fade-in">
            {/* 用户信息 */}
            <div className="px-3 py-2 border-b border-mes-border">
              <p className="text-xs text-mes-textTertiary">当前登录</p>
              <p className="text-sm font-medium text-mes-text truncate">{user.username}</p>
            </div>
            {/* 菜单项 */}
            <button
              onClick={() => { setShowMenu(false); onRequestChangePassword() }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-mes-textSecondary hover:bg-gray-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              修改密码
            </button>
            <button
              onClick={() => { setShowMenu(false); setShowInfo(true) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-mes-textSecondary hover:bg-gray-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              个人信息
            </button>
            <button
              onClick={() => { setShowMenu(false); setShowSettings(true) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-mes-textSecondary hover:bg-gray-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              设置
            </button>
            <div className="border-t border-mes-border my-1" />
            <button
              onClick={() => { setShowMenu(false); onLogout() }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              退出登录
            </button>
          </div>
        </>
      )}

      {/* 个人信息弹窗 */}
      {showInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowInfo(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-[340px] max-w-[92vw] p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-mes-primary to-purple-500 flex items-center justify-center text-white text-xl font-medium shrink-0">
                {avatarChar}
              </div>
              <div className="min-w-0">
                <p className="text-base font-semibold text-mes-text truncate">{user.displayName}</p>
                <p className="text-xs text-mes-textTertiary truncate">@{user.username}</p>
              </div>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-3 border-b border-mes-border pb-2">
                <span className="text-mes-textTertiary">用户名</span>
                <span className="text-mes-text font-medium truncate">{user.username}</span>
              </div>
              <div className="flex justify-between gap-3 border-b border-mes-border pb-2">
                <span className="text-mes-textTertiary">姓名</span>
                <span className="text-mes-text font-medium truncate">{user.displayName}</span>
              </div>
              <div className="flex justify-between gap-3 border-b border-mes-border pb-2">
                <span className="text-mes-textTertiary">部门</span>
                <span className="text-mes-text font-medium truncate">{user.department || '—'}</span>
              </div>
              <div className="flex justify-between gap-3 border-b border-mes-border pb-2">
                <span className="text-mes-textTertiary">角色</span>
                <span className={`font-medium ${user.role === 'admin' ? 'text-purple-600' : 'text-mes-text'}`}>
                  {user.role === 'admin' ? '管理员' : '用户'}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-mes-textTertiary">密码状态</span>
                <span className={`font-medium ${user.mustChangePassword ? 'text-amber-600' : 'text-green-600'}`}>
                  {user.mustChangePassword ? '需修改' : '正常'}
                </span>
              </div>
            </div>
            <button
              onClick={() => setShowInfo(false)}
              className="mt-6 w-full py-2 rounded-lg bg-mes-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 设置弹窗 */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowSettings(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-[360px] max-w-[92vw] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-mes-text mb-4">设置</h3>
            <div className="space-y-2">
              <button
                onClick={() => { setShowSettings(false); onOpenApiSettings() }}
                className="w-full flex items-center justify-between px-3 py-3 rounded-lg border border-mes-border hover:bg-gray-50 transition-colors text-left"
              >
                <span>
                  <span className="block text-sm font-medium text-mes-text">模型与 API 配置</span>
                  <span className="block text-xs text-mes-textTertiary">设置 API Key、提供商与自定义模型 ID</span>
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-textTertiary shrink-0">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <button
                onClick={() => { setShowSettings(false); setShowInfo(true) }}
                className="w-full flex items-center justify-between px-3 py-3 rounded-lg border border-mes-border hover:bg-gray-50 transition-colors text-left"
              >
                <span>
                  <span className="block text-sm font-medium text-mes-text">账户信息</span>
                  <span className="block text-xs text-mes-textTertiary">查看当前登录用户的资料</span>
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-textTertiary shrink-0">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
            <div className="mt-4 p-3 rounded-lg bg-gray-50 text-xs text-mes-textTertiary leading-relaxed">
              提示：API Key 仅保存在本机浏览器，不会上传服务器。修改密码、退出登录请在上方菜单操作。
            </div>
            <button
              onClick={() => setShowSettings(false)}
              className="mt-5 w-full py-2 rounded-lg bg-mes-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
