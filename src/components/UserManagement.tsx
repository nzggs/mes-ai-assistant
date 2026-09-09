import { useState, useMemo, useEffect } from 'react'
import * as XLSX from 'xlsx'
import {
  getRegisteredUsers,
  registerUser,
  deleteUser,
  resetPassword,
  syncUsersFromBackend,
  SUPER_ADMIN,
  DEPARTMENTS,
  type User,
  type UserRole,
  type StoredUser,
} from '../services/userService'
import { validateBatchRow } from '../services/userValidation'

// 以下纯校验逻辑已抽到 services/userValidation.ts（可单测复用），本组件仅引用：
//   validateBatchRow / ALLOWED_ROLES / DEPARTMENTS(来自 userService)

interface UserManagementProps {
  currentUser: User
  onUserListChanged: () => void
}

interface UserRow extends StoredUser {
  username: string
  isSelf: boolean
  isSuperAdmin: boolean
}

export function UserManagement({ currentUser, onUserListChanged }: UserManagementProps) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [showRegister, setShowRegister] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  // 注册表单
  const [regUsername, setRegUsername] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regConfirm, setRegConfirm] = useState('')
  const [regDisplayName, setRegDisplayName] = useState('')
  const [regDepartment, setRegDepartment] = useState('技术部')
  const [regRole, setRegRole] = useState<UserRole>('user')
  const [regError, setRegError] = useState('')

  // 密码重置
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null)
  const [resetNewPwd, setResetNewPwd] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [resetError, setResetError] = useState('')

  // 注销确认
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null)
  const [deleteError, setDeleteError] = useState('')

  // 批量注册（Excel 导入）
  const [showBatch, setShowBatch] = useState(false)
  const [batchResult, setBatchResult] = useState<{ success: number; failures: string[] } | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchError, setBatchError] = useState('')

  const handleDownloadTemplate = () => {
    const aoa = [
      ['用户名', '显示名称', '部门', '用户组', '密码'],
      ['zhangsan', '张三', '技术部', '用户', 'Abc12345'],
      ['lisi', '李四', '质量部', '管理员', 'Xyz67890'],
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '批量注册模板')
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const blob = new Blob([buf], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '批量注册模板.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleBatchFile = async (file: File) => {
    setBatchError('')
    setBatchResult(null)
    setBatchBusy(true)
    try {
      // 文件防护：体积（Excel 模板通常极小，超 5MB 直接拒绝以防异常文件）
      if (file.size > 5 * 1024 * 1024) { setBatchError('文件过大，请上传不超过 5MB 的 Excel'); return }
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws) { setBatchError('Excel 中未找到工作表'); return }
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]
      if (rows.length < 2) { setBatchError('文件中没有数据行（第 1 行为表头，需至少 1 行数据）'); return }

      const existing = getRegisteredUsers()
      const existingLower = new Set(Object.keys(existing).map(k => k.toLowerCase()))
      const registeredThisBatch = new Set<string>() // 本次已成功注册（小写）用户名，防止文件内重复
      let success = 0
      const failures: string[] = []

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]
        const cells = (r || []).map(c =>
          c == null ? '' : (typeof c === 'string' ? c : String(c)).trim()
        )
        // 整行全空：静默跳过（不计入失败）
        if (cells.every(c => c === '')) continue

        const rowLabel = `第 ${i + 1} 行`
        const v = validateBatchRow(
          {
            username: cells[0],
            displayName: cells[1],
            department: cells[2],
            roleRaw: cells[3],
            password: cells[4] ?? '',
          },
          DEPARTMENTS,
          existingLower,
          registeredThisBatch,
        )
        if (!v.ok) { failures.push(`${rowLabel}${v.username ? `（${v.username}）` : ''}：${v.error}`); continue }

        const res = registerUser({
          username: v.username,
          password: cells[4] ?? '',
          displayName: v.displayName,
          department: v.department,
          role: v.role!,
          mustChangePassword: true,
        })
        if (res.success) { success++; registeredThisBatch.add(v.username.toLowerCase()) }
        else failures.push(`${rowLabel}（${v.username}）：${res.error}`)
      }
      setBatchResult({ success, failures })
      loadUsers()
    } catch (e: unknown) {
      setBatchError('解析 Excel 失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBatchBusy(false)
    }
  }

  const loadUsers = () => {
    const map = getRegisteredUsers()
    const rows: UserRow[] = Object.entries(map).map(([username, u]) => ({
      ...u,
      username,
      isSelf: username === currentUser.username,
      isSuperAdmin: username === SUPER_ADMIN.username,
    }))
    rows.sort((a, b) => {
      // 超级管理员置顶
      if (a.isSuperAdmin !== b.isSuperAdmin) return a.isSuperAdmin ? -1 : 1
      if (a.department !== b.department) return a.department.localeCompare(b.department, 'zh')
      return a.username.localeCompare(b.username)
    })
    setUsers(rows)
    onUserListChanged()
  }

  useEffect(() => {
    // 打开用户管理时先从后端拉取最新用户表（后端为唯一真相源），再渲染，保证跨浏览器增删改可见
    syncUsersFromBackend().finally(() => loadUsers())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filteredUsers = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return users
    return users.filter(u =>
      u.username.toLowerCase().includes(q) ||
      u.displayName.toLowerCase().includes(q) ||
      u.department.toLowerCase().includes(q)
    )
  }, [users, searchTerm])

  const handleRegister = async () => {
    setRegError('')
    if (!regUsername.trim()) { setRegError('请输入用户名'); return }
    if (regPassword.length < 6) { setRegError('密码至少 6 位'); return }
    if (regPassword !== regConfirm) { setRegError('两次输入的密码不一致'); return }

    // 写操作前先拉最新后端表，避免覆盖他人在其他浏览器的增删改
    await syncUsersFromBackend()
    const res = registerUser({
      username: regUsername.trim(),
      password: regPassword,
      displayName: regDisplayName.trim(),
      department: regDepartment,
      role: regRole,
      mustChangePassword: true, // 管理员创建的账户，首次登录需修改密码
    })
    if (!res.success) {
      setRegError(res.error || '注册失败')
      return
    }
    // 重置表单
    setRegUsername('')
    setRegPassword('')
    setRegConfirm('')
    setRegDisplayName('')
    setRegDepartment('技术部')
    setRegRole('user')
    setShowRegister(false)
    loadUsers()
  }

  const handleReset = async () => {
    setResetError('')
    if (resetNewPwd.length < 6) { setResetError('新密码至少 6 位'); return }
    if (resetNewPwd !== resetConfirm) { setResetError('两次输入的新密码不一致'); return }
    // 写操作前先拉最新后端表，避免覆盖他人在其他浏览器的增删改
    await syncUsersFromBackend()
    const res = resetPassword(resetTarget!.username, resetNewPwd)
    if (!res.success) {
      setResetError(res.error || '重置失败')
      return
    }
    setResetNewPwd('')
    setResetConfirm('')
    setResetTarget(null)
    loadUsers()
  }

  const handleDelete = async () => {
    // 写操作前先拉最新后端表，避免覆盖他人在其他浏览器的增删改
    await syncUsersFromBackend()
    const res = deleteUser(deleteTarget!.username)
    if (res.success) {
      setDeleteTarget(null)
      setDeleteError('')
      loadUsers()
    } else {
      // 并发下账户可能已被其他浏览器删除：提示错误并刷新列表，不静默吞掉
      setDeleteError(res.error || '注销失败')
      loadUsers()
    }
  }

  const stats = {
    total: users.length,
    admin: users.filter(u => u.role === 'admin').length,
    pendingPwd: users.filter(u => u.mustChangePassword).length,
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* 页面标题 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-mes-text mb-1">用户管理</h1>
            <p className="text-sm text-mes-textSecondary">
              账号注册 · 注销 · 密码重置（IT 部管理员专用）
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setRegError(''); setShowRegister(!showRegister) }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-mes-primary text-white text-sm font-medium hover:bg-mes-primaryHover transition-all-smooth shadow-sm"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
              注册账号
            </button>
            <button
              onClick={() => { setBatchError(''); setBatchResult(null); setShowBatch(!showBatch) }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-mes-primary text-mes-primary text-sm font-medium hover:bg-mes-tagBg transition-all-smooth shadow-sm"
              title="通过 Excel 模板批量导入注册"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              批量注册
            </button>
          </div>
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <StatCard label="账户总数" value={stats.total} icon="👤" color="#4d6bfe" />
          <StatCard label="管理员" value={stats.admin} icon="🛡️" color="#7c3aed" />
          <StatCard label="待修改密码" value={stats.pendingPwd} icon="🔑" color="#f59e0b" />
        </div>

        {/* 注册表单 */}
        {showRegister && (
          <div className="mb-6 rounded-xl border border-mes-border bg-white p-5 animate-expand">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-mes-text">注册新账号</h3>
              <button onClick={() => setShowRegister(false)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">用户名</label>
                <input
                  type="text"
                  placeholder="登录用户名"
                  value={regUsername}
                  onChange={e => setRegUsername(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">显示名称</label>
                <input
                  type="text"
                  placeholder="可选，默认同用户名"
                  value={regDisplayName}
                  onChange={e => setRegDisplayName(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">部门</label>
                <select
                  value={regDepartment}
                  onChange={e => setRegDepartment(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                >
                  {DEPARTMENTS.map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">用户组</label>
                <div className="grid grid-cols-2 gap-2">
                  <RoleOption active={regRole === 'user'} onClick={() => setRegRole('user')} title="用户" desc="无审核权限" />
                  <RoleOption active={regRole === 'admin'} onClick={() => setRegRole('admin')} title="管理员" desc="可审核本部门文档" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">初始密码</label>
                <input
                  type="password"
                  placeholder="至少6位"
                  value={regPassword}
                  onChange={e => setRegPassword(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">确认密码</label>
                <input
                  type="password"
                  placeholder="再次输入密码"
                  value={regConfirm}
                  onChange={e => setRegConfirm(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                />
              </div>
            </div>

            {regError && (
              <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {regError}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowRegister(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-mes-textSecondary border border-mes-border hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleRegister}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-mes-primary hover:bg-mes-primaryHover transition-colors shadow-sm"
              >
                确认注册
              </button>
            </div>
          </div>
        )}

        {/* 批量注册（Excel 导入） */}
        {showBatch && (
          <div className="mb-6 rounded-xl border border-mes-border bg-white p-5 animate-expand">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-mes-text">批量注册账号</h3>
              <button onClick={() => setShowBatch(false)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <p className="text-xs text-mes-textSecondary mb-3">
              下载模板，按列填写（用户名 / 显示名称 / 部门 / 用户组 / 密码）后导入 Excel，系统将自动逐个校验并注册。
              用户名仅限字母/数字/中文及 <code className="px-1 rounded bg-gray-100">._@-</code>（2-20 位）；
              部门须为 {DEPARTMENTS.join(' / ')} 之一；
              用户组填「用户」或「管理员」；
              密码 6-20 位且须同时含字母与数字、不可含空格。校验不通过的行会列出原因、不影响其余行。
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleDownloadTemplate}
                className="px-4 py-2 rounded-lg text-sm font-medium text-mes-primary border border-mes-primary hover:bg-mes-tagBg transition-colors"
              >
                下载模板
              </button>
              <label className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-mes-primary hover:bg-mes-primaryHover transition-colors cursor-pointer">
                选择 Excel 文件
                <input
                  type="file"
                  accept=".xls,.xlsx"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleBatchFile(f); e.currentTarget.value = '' }}
                />
              </label>
              {batchBusy && <span className="text-xs text-mes-textSecondary">导入中…</span>}
            </div>

            {batchError && (
              <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {batchError}
              </div>
            )}

            {batchResult && (
              <div className="mt-3 px-3 py-2 rounded-lg bg-gray-50 border border-mes-border text-sm text-mes-text">
                成功注册 <b className="text-green-600">{batchResult.success}</b> 个账号
                {batchResult.failures.length > 0 && <>，失败 <b className="text-red-600">{batchResult.failures.length}</b> 个</>}
                {batchResult.failures.length > 0 && (
                  <ul className="mt-2 max-h-40 overflow-y-auto list-disc pl-5 space-y-0.5 text-xs text-red-600">
                    {batchResult.failures.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* 搜索框 */}
        <div className="mb-4 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-mes-textTertiary" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="搜索用户名、名称或部门..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-mes-border bg-white focus:border-mes-primary focus:outline-none transition-colors"
          />
        </div>

        {/* 用户列表 */}
        <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-mes-border text-mes-textSecondary">
                <th className="text-left font-medium px-4 py-3">用户名</th>
                <th className="text-left font-medium px-4 py-3">显示名称</th>
                <th className="text-left font-medium px-4 py-3">部门</th>
                <th className="text-left font-medium px-4 py-3">用户组</th>
                <th className="text-left font-medium px-4 py-3">状态</th>
                <th className="text-right font-medium px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-mes-textTertiary py-10 text-sm">未找到匹配的用户</td>
                </tr>
              ) : (
                filteredUsers.map(u => (
                  <tr key={u.username} className="border-b border-mes-border last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-mes-text">{u.username}</span>
                        {u.isSuperAdmin && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 font-medium">超级管理员</span>
                        )}
                        {u.isSelf && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-mes-tagBg text-mes-tagText font-medium">当前账号</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-mes-text">{u.displayName}</td>
                    <td className="px-4 py-3 text-mes-textSecondary">{u.department}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        u.role === 'admin' ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-mes-textSecondary'
                      }`}>
                        {u.role === 'admin' ? '管理员' : '用户'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {u.mustChangePassword ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-600 font-medium">需修改密码</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-600 font-medium">正常</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => { setResetError(''); setResetNewPwd(''); setResetConfirm(''); setResetTarget(u) }}
                          disabled={u.isSuperAdmin && !u.isSelf}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-mes-primary bg-mes-tagBg hover:bg-mes-primary hover:text-white transition-all-smooth disabled:opacity-40 disabled:cursor-not-allowed"
                          title={u.isSuperAdmin && !u.isSelf ? '非本人操作时，超级管理员密码不可重置' : '重置密码'}
                        >
                          重置密码
                        </button>
                        <button
                          onClick={() => { setDeleteError(''); setDeleteTarget(u) }}
                          disabled={u.isSelf || u.isSuperAdmin}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-mes-danger bg-red-50 hover:bg-red-500 hover:text-white transition-all-smooth disabled:opacity-40 disabled:cursor-not-allowed"
                          title={u.isSelf ? '不能注销当前登录账号' : u.isSuperAdmin ? '超级管理员不可注销' : '注销账号'}
                        >
                          注销
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 重置密码弹窗 */}
      {resetTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 animate-fade-in" onClick={() => setResetTarget(null)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-base font-semibold text-mes-text mb-1">重置密码</h3>
              <p className="text-sm text-mes-textSecondary mb-4">
                为 <span className="font-medium text-mes-text">{resetTarget.username}</span> 设置新密码，该用户下次登录需修改
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">新密码</label>
                  <input
                    type="password"
                    placeholder="至少6位"
                    value={resetNewPwd}
                    onChange={e => setResetNewPwd(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-mes-textSecondary mb-1.5">确认新密码</label>
                  <input
                    type="password"
                    placeholder="再次输入新密码"
                    value={resetConfirm}
                    onChange={e => setResetConfirm(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm rounded-xl border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
                  />
                </div>
                {resetError && (
                  <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    {resetError}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setResetTarget(null)}
                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mes-textSecondary border border-mes-border hover:bg-gray-50 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleReset}
                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-mes-primary hover:bg-mes-primaryHover transition-colors shadow-sm"
                  >
                    确认重置
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 注销确认弹窗 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 animate-fade-in" onClick={() => setDeleteTarget(null)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-4 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-red-50 flex items-center justify-center mb-3">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <line x1="10" y1="17" x2="14" y2="17" />
                  <path d="M9 9a3 3 0 0 1 6 0v3a3 3 0 0 1-6 0z" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-mes-text mb-1">确认注销账号？</h3>
              <p className="text-sm text-mes-textSecondary mb-1">
                账号 <span className="font-medium text-mes-text">{deleteTarget.username}</span> 将被永久删除
              </p>
              <p className="text-xs text-mes-textTertiary">注销后该用户将无法登录，此操作不可撤销</p>
              {deleteError && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 flex items-center gap-2 text-left">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 px-6 pb-6">
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mes-textSecondary border border-mes-border hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors shadow-sm"
              >
                确认注销
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, icon, color }: { label: string; value: number; icon: string; color: string }) {
  return (
    <div className="rounded-xl border border-mes-border bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-mes-textSecondary">{label}</span>
        <span className="text-lg">{icon}</span>
      </div>
      <p className="text-2xl font-bold" style={{ color }}>{value}</p>
    </div>
  )
}

function RoleOption({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start px-3 py-2 rounded-xl border text-left transition-all-smooth ${
        active ? 'border-mes-primary bg-mes-tagBg' : 'border-mes-border bg-gray-50 hover:border-mes-primary'
      }`}
    >
      <span className={`text-sm font-medium ${active ? 'text-mes-primary' : 'text-mes-text'}`}>{title}</span>
      <span className="text-xs text-mes-textTertiary mt-0.5 leading-tight">{desc}</span>
    </button>
  )
}
