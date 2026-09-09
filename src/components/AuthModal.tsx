import { useState, useEffect } from 'react'
import {
  getSession,
  clearSession,
  setSession,
  verifyPassword,
  upgradePasswordToHash,
  type User,
} from '../services/userService'

export type { User } from '../services/userService'
export { getSession, clearSession } from '../services/userService'

interface AuthModalProps {
  onClose: () => void
  onLogin: (user: User) => void
}

export function AuthModal({ onClose, onLogin }: AuthModalProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 登录失败锁定：连续失败 5 次锁定 5 分钟（防暴力破解）
  const ATTEMPT_KEY = 'mes-ai-login-attempts'
  const MAX_ATTEMPTS = 5
  const LOCK_MS = 5 * 60 * 1000

  const readAttempts = (): { count: number; lockedUntil: number } => {
    try {
      return JSON.parse(localStorage.getItem(ATTEMPT_KEY) || '{"count":0,"lockedUntil":0}')
    } catch {
      return { count: 0, lockedUntil: 0 }
    }
  }
  const writeAttempts = (a: { count: number; lockedUntil: number }) => {
    localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a))
  }
  const getRemainingLock = (): number => {
    const a = readAttempts()
    const remain = a.lockedUntil - Date.now()
    return remain > 0 ? remain : 0
  }
  const [lockRemaining, setLockRemaining] = useState<number>(getRemainingLock())

  // 按 Enter 提交
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit()
    }
  }

  const handleSubmit = () => {
    setError('')

    // 锁定期间禁止提交
    if (lockRemaining > 0) {
      setError(`登录失败次数过多，请 ${Math.ceil(lockRemaining / 1000)} 秒后再试`)
      return
    }
    if (!username.trim()) {
      setError('请输入用户名')
      return
    }
    if (!password.trim()) {
      setError('请输入密码')
      return
    }

    setLoading(true)

    // 模拟网络延迟
    setTimeout(() => {
      const users = (() => {
        try {
          return JSON.parse(localStorage.getItem('mes-ai-users') || '{}')
        } catch {
          return {}
        }
      })()
      const stored = users[username.trim()]
      if (!stored) {
        // 记录失败次数
        const a = readAttempts()
        const count = a.count + 1
        writeAttempts(count >= MAX_ATTEMPTS ? { count: 0, lockedUntil: Date.now() + LOCK_MS } : { count, lockedUntil: 0 })
        if (count >= MAX_ATTEMPTS) setLockRemaining(LOCK_MS)
        setError('用户名不存在，请联系管理员开通账号')
        setLoading(false)
        return
      }
      if (!verifyPassword(stored, username.trim(), password)) {
        const a = readAttempts()
        const count = a.count + 1
        writeAttempts(count >= MAX_ATTEMPTS ? { count: 0, lockedUntil: Date.now() + LOCK_MS } : { count, lockedUntil: 0 })
        if (count >= MAX_ATTEMPTS) setLockRemaining(LOCK_MS)
        setError('密码错误')
        setLoading(false)
        return
      }
      // 登录成功：清除失败记录
      localStorage.removeItem(ATTEMPT_KEY)
      setLockRemaining(0)
      // 历史明文密码验证通过后自动升级为哈希存储
      upgradePasswordToHash(username.trim())

      // 登录成功
      const user: User = {
        username: username.trim(),
        displayName: stored.displayName || username.trim(),
        department: stored.department || '技术部',
        role: stored.role || 'user',
        mustChangePassword: !!stored.mustChangePassword,
      }
      setSession(user)
      setLoading(false)
      onLogin(user)
    }, 600)
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 animate-fade-in"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-mes-primary flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
                  <path d="M16 7L25 12V20L16 25L7 20V12L16 7Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
                  <circle cx="16" cy="16" r="3" fill="white" />
                </svg>
              </div>
              <span className="font-semibold text-sm text-mes-text">AI 智能助手</span>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <h2 className="text-lg font-semibold text-mes-text">登录</h2>
          <p className="text-xs text-mes-textTertiary mt-1">请使用管理员分配的账号登录</p>
        </div>

        {/* 表单内容 */}
        <div className="px-6 pb-6 space-y-3">
          {/* 用户名 */}
          <div>
            <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">用户名</label>
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-mes-textTertiary" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <input
                type="text"
                placeholder="请输入用户名"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
              />
            </div>
          </div>

          {/* 密码 */}
          <div>
            <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">密码</label>
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-mes-textTertiary" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <input
                type="password"
                placeholder="请输入密码（至少6位）"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
              />
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 flex items-center gap-2 animate-fade-in">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {error}
            </div>
          )}

          {/* 提交按钮 */}
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full py-2.5 rounded-xl bg-mes-primary text-white text-sm font-medium hover:bg-mes-primaryHover transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                登录中...
              </>
            ) : (
              '登录'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
