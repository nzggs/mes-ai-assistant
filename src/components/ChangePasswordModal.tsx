import { useState } from 'react'
import { changePassword, forceSetPassword, type User } from '../services/userService'

interface ChangePasswordModalProps {
  user: User
  force: boolean // 强制修改（首次登录）
  onClose: () => void
  onChanged: (user: User) => void
}

export function ChangePasswordModal({ user, force, onClose, onChanged }: ChangePasswordModalProps) {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 强制修改时不允许点遮罩关闭
  const handleClose = () => {
    if (force) return
    onClose()
  }

  const handleSubmit = () => {
    setError('')
    if (!force && !oldPassword) {
      setError('请输入原密码')
      return
    }
    if (!newPassword) {
      setError('请输入新密码')
      return
    }
    if (newPassword.length < 6) {
      setError('新密码至少 6 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }

    setLoading(true)
    setTimeout(() => {
      if (force) {
        // 首次登录：直接以哈希方式覆盖密码（绕过原密码校验），不再明文存储
        const res = forceSetPassword(user.username, newPassword)
        if (!res.success) {
          setError(res.error || '修改失败')
          setLoading(false)
          return
        }
      } else {
        const res = changePassword(user.username, oldPassword, newPassword)
        if (!res.success) {
          setError(res.error || '修改失败')
          setLoading(false)
          return
        }
      }
      const updated: User = { ...user, mustChangePassword: false }
      localStorage.setItem('mes-ai-session', JSON.stringify(updated))
      setLoading(false)
      onChanged(updated)
    }, 500)
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-mes-primary flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <span className="font-semibold text-sm text-mes-text">
                {force ? '首次登录请修改密码' : '修改密码'}
              </span>
            </div>
            {!force && (
              <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>

          {force && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700 flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              为保障账户安全，首次登录需修改密码后方可使用系统
            </div>
          )}

          <div className="space-y-3">
            {!force && (
              <div>
                <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">原密码</label>
                <input
                  type="password"
                  placeholder="请输入当前密码"
                  value={oldPassword}
                  onChange={e => setOldPassword(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">新密码</label>
              <input
                type="password"
                placeholder="请输入新密码（至少6位）"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">确认新密码</label>
              <input
                type="password"
                placeholder="请再次输入新密码"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
              />
            </div>

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

            <button
              onClick={handleSubmit}
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-mes-primary text-white text-sm font-medium hover:bg-mes-primaryHover transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  提交中...
                </>
              ) : (
                '确认修改'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
