import { useEffect, useState } from 'react'
import {
  fetchUserMemories, addUserMemory, updateUserMemory, deleteUserMemory,
  type UserMemory, type MemoryLimits,
} from '../services/memoryApi'

interface MemoryManageProps {
  username: string
  onClose: () => void
  /** 记忆发生变化后通知父级（问答注入需使用最新列表） */
  onChanged?: (memories: UserMemory[]) => void
}

/**
 * 记忆管理：当前登录用户对自己记忆（个性化偏好）的增删改查。
 * 记忆会在问答时注入上下文，例如"生成的 SQL 中列名注释要加双引号"，
 * 可让 MES 直查生成的 SQL 符合个人书写习惯、避免数据库语法报错。
 */
export function MemoryManage({ username, onClose, onChanged }: MemoryManageProps) {
  const [memories, setMemories] = useState<UserMemory[]>([])
  const [limits, setLimits] = useState<MemoryLimits>({ maxLen: 500, maxPerUser: 100 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchUserMemories(username)
      .then(r => {
        if (cancelled) return
        // 防御：memories 必须是数组（后端异常时避免非数组进入渲染导致整页崩溃）
        setMemories(Array.isArray(r.memories) ? r.memories : [])
        if (r.limits) setLimits(r.limits)
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [username])

  const notify = (list: UserMemory[]) => {
    const safe = Array.isArray(list) ? list : []
    setMemories(safe)
    onChanged?.(safe)
  }

  const handleAdd = async () => {
    setError('')
    const content = draft.trim()
    if (!content) { setError('记忆内容不能为空'); return }
    if (content.length > limits.maxLen) { setError(`记忆内容不能超过 ${limits.maxLen} 字`); return }
    setSubmitting(true)
    try {
      const r = await addUserMemory(username, content)
      notify(r.memories || [])
      setDraft('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdate = async (id: string) => {
    setError('')
    const content = editDraft.trim()
    if (!content) { setError('记忆内容不能为空'); return }
    if (content.length > limits.maxLen) { setError(`记忆内容不能超过 ${limits.maxLen} 字`); return }
    try {
      const r = await updateUserMemory(username, id, content)
      notify(r.memories || [])
      setEditingId(null)
      setEditDraft('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDelete = async (id: string) => {
    setError('')
    try {
      const r = await deleteUserMemory(username, id)
      notify(r.memories || [])
      setConfirmDeleteId(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 flex-1 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-mes-primary flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                  <line x1="9" y1="21" x2="15" y2="21" />
                </svg>
              </div>
              <span className="font-semibold text-sm text-mes-text">记忆管理</span>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <p className="text-xs text-mes-textTertiary mb-4">
            记住你的使用偏好，问答时会自动遵守。仅对账号「{username}」生效。
          </p>

          {/* 新增 */}
          <div className="mb-4">
            <div className="flex gap-2">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={2}
                maxLength={limits.maxLen}
                placeholder="例如：生成的 SQL 中列名注释要加双引号，如 AS &quot;物料编号&quot;"
                className="flex-1 px-3 py-2 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors resize-none"
              />
              <button
                onClick={handleAdd}
                disabled={submitting || !draft.trim() || memories.length >= limits.maxPerUser}
                className="self-stretch px-4 rounded-xl bg-mes-primary text-white text-sm font-medium hover:bg-mes-primaryHover transition-colors disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
              >
                {submitting ? '保存中…' : '添加'}
              </button>
            </div>
            <p className="text-[11px] text-mes-textTertiary mt-1">
              {draft.length}/{limits.maxLen} 字 · 已存 {memories.length}/{limits.maxPerUser} 条
            </p>
          </div>

          {error && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 animate-fade-in">
              {error}
            </div>
          )}

          {/* 列表 */}
          <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
            {loading ? (
              <div className="py-8 text-center text-sm text-mes-textTertiary">加载中…</div>
            ) : memories.length === 0 ? (
              <div className="py-8 text-center text-sm text-mes-textTertiary">
                还没有记忆。添加一条偏好，AI 会在回答时自动遵守。
              </div>
            ) : (
              memories.map(m => (
                <div key={m.id} className="px-3 py-2.5 rounded-xl border border-mes-border bg-gray-50">
                  {editingId === m.id ? (
                    <>
                      <textarea
                        value={editDraft}
                        onChange={e => setEditDraft(e.target.value)}
                        rows={2}
                        maxLength={limits.maxLen}
                        autoFocus
                        className="w-full px-2 py-1.5 text-sm rounded-lg border border-mes-border bg-white focus:border-mes-primary focus:outline-none resize-none"
                      />
                      <div className="flex justify-end gap-2 mt-2">
                        <button
                          onClick={() => { setEditingId(null); setEditDraft('') }}
                          className="px-3 py-1 rounded-lg text-xs text-mes-textSecondary hover:bg-gray-200 transition-colors"
                        >
                          取消
                        </button>
                        <button
                          onClick={() => handleUpdate(m.id)}
                          className="px-3 py-1 rounded-lg text-xs bg-mes-primary text-white hover:bg-mes-primaryHover transition-colors"
                        >
                          保存
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-mes-text whitespace-pre-wrap break-words">{m.content}</p>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-[11px] text-mes-textTertiary">
                          更新于 {new Date(m.updatedAt).toLocaleString()}
                        </span>
                        <div className="flex items-center gap-1">
                          {confirmDeleteId === m.id ? (
                            <>
                              <span className="text-[11px] text-red-500 mr-1">确认删除？</span>
                              <button
                                onClick={() => handleDelete(m.id)}
                                className="px-2.5 py-1 rounded-lg text-xs bg-red-500 text-white hover:bg-red-600 transition-colors"
                              >
                                删除
                              </button>
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2.5 py-1 rounded-lg text-xs text-mes-textSecondary hover:bg-gray-200 transition-colors"
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => { setEditingId(m.id); setEditDraft(m.content) }}
                                className="px-2.5 py-1 rounded-lg text-xs text-mes-textSecondary hover:bg-gray-200 transition-colors"
                              >
                                编辑
                              </button>
                              <button
                                onClick={() => setConfirmDeleteId(m.id)}
                                className="px-2.5 py-1 rounded-lg text-xs text-red-500 hover:bg-red-50 transition-colors"
                              >
                                删除
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
