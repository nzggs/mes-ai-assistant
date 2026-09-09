// ===== 用户与权限管理服务 =====
// 集中管理用户存储、超级管理员预设、注册/注销/重置密码/修改密码，以及权限辅助函数。
// 用户表优先持久化到后端（跨浏览器/设备共享），后端不可达时回退 localStorage。

import { BACKEND_BASE, getAdminToken } from './backend'

export type UserRole = 'admin' | 'user'

export interface User {
  username: string
  displayName: string
  department: string
  role: UserRole
  mustChangePassword?: boolean // 首次登录需修改密码
}

/** localStorage 中存储的用户记录 */
export interface StoredUser {
  password: string
  displayName: string
  department: string
  role: UserRole
  mustChangePassword: boolean
}

const STORAGE_KEY = 'mes-ai-users'
const SESSION_KEY = 'mes-ai-session'

/** 预设超级管理员账户
 *  初始密码可通过构建期环境变量 VITE_INITIAL_ADMIN_PASSWORD 覆盖（如 LAN 部署时指定初始口令）。
 *  无论何种初始密码，首次登录都强制要求修改（mustChangePassword=true），上线后请及时在用户管理中重置。 */
export const SUPER_ADMIN = {
  username: 'SITE_ADMIN',
  password: (import.meta.env.VITE_INITIAL_ADMIN_PASSWORD as string) || 'Admin@2026#Site',
  displayName: '系统管理员',
  department: 'IT部',
  role: 'admin' as UserRole,
}

/** 部门列表（用于注册表单下拉） */
export const DEPARTMENTS = ['IT部', '技术部', '生产部', '质量部', '设备部']

// ===== 密码哈希（同步 SHA-256，避免明文存储） =====

/** SHA-256 同步实现（标准算法），返回 64 位十六进制字符串 */
function sha256Hex(input: string): string {
  const utf8 = unescape(encodeURIComponent(input)) // UTF-8 bytes as latin1 string
  const bytes: number[] = []
  for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 0xff)
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const bitLen = utf8.length * 8
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff)

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w: number[] = new Array(64)

  for (let block = 0; block < bytes.length / 64; block++) {
    for (let i = 0; i < 16; i++) {
      const j = block * 64 + i * 4
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e
      e = (d + temp1) >>> 0
      d = c; c = b; b = a
      a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }

  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** 使用用户名作盐进行加盐哈希 */
function hashPassword(username: string, password: string): string {
  return sha256Hex(`${username}:${password}`)
}

/** 校验密码：兼容哈希与历史明文，明文通过后自动升级为哈希 */
export function verifyPassword(stored: StoredUser, username: string, password: string): boolean {
  if (/^[0-9a-f]{64}$/i.test(stored.password)) {
    return stored.password === hashPassword(username, password)
  }
  // 历史明文：验证通过后由调用方升级为哈希
  return stored.password === password
}

/** 将旧明文密码记录升级为哈希（登录验证通过后调用） */
export function upgradePasswordToHash(username: string): void {
  const users = getRegisteredUsers()
  const u = users[username]
  if (u && !/^[0-9a-f]{64}$/i.test(u.password)) {
    u.password = hashPassword(username, u.password)
    saveRegisteredUsers(users)
  }
}

// ===== 存储读写 =====

export function getRegisteredUsers(): Record<string, StoredUser> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

export function saveRegisteredUsers(users: Record<string, StoredUser>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(users))
  // 异步同步到后端（跨浏览器/设备共享）；后端不可达时静默失败，本地仍有数据
  syncUsersToBackend(users).catch(() => {})
}

/** 将用户表推送到后端（跨浏览器共享） */
async function syncUsersToBackend(users: Record<string, StoredUser>): Promise<void> {
  try {
    // B1：管理路由需携带管理员令牌（未配置 ADMIN_TOKEN 时服务端放行）
    await fetch(`${BACKEND_BASE}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': getAdminToken() },
      body: JSON.stringify({ users }),
    })
  } catch { /* 后端不可达时忽略 */ }
}

/**
 * 从后端拉取用户表（后端为唯一真相源，覆盖本地）。
 * 覆盖式而非合并式，保证「删除」能正确传播：A 浏览器注销的用户，B 浏览器同步后也被移除，
 * 不会被本地旧数据「复活」。后端为空（首次部署）时，把本地（含超管）推到后端做初始化。
 */
export async function syncUsersFromBackend(): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/users`, {
      headers: { 'X-Admin-Token': getAdminToken() },
    })
    if (!res.ok) return
    const data = await res.json()
    const remote = data?.users
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return
    const local = getRegisteredUsers()
    if (Object.keys(remote).length === 0) {
      // 后端为空（首次部署）：把本地（含超管）推到后端，不覆盖本地
      if (Object.keys(local).length > 0) {
        await syncUsersToBackend(local)
      }
      return
    }
    // 后端有数据：以后端为准覆盖本地（正确处理删除与注册）
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remote))
  } catch { /* 后端不可达时忽略 */ }
}

/** 确保超级管理员账户存在（应用启动时调用） */
export function ensureSuperAdminSeeded() {
  const users = getRegisteredUsers()
  if (!users[SUPER_ADMIN.username]) {
    users[SUPER_ADMIN.username] = {
      password: hashPassword(SUPER_ADMIN.username, SUPER_ADMIN.password),
      displayName: SUPER_ADMIN.displayName,
      department: SUPER_ADMIN.department,
      role: SUPER_ADMIN.role,
      mustChangePassword: true,
    }
    saveRegisteredUsers(users)
  }
}

// ===== 会话读写 =====

export function getSession(): User | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
  } catch {
    return null
  }
}

export function setSession(user: User) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user))
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

// ===== 账户操作 =====

export function registerUser(data: {
  username: string
  password: string
  displayName?: string
  department: string
  role: UserRole
  mustChangePassword?: boolean
}): { success: boolean; error?: string } {
  const users = getRegisteredUsers()
  const username = data.username.trim()
  if (username.length < 2) return { success: false, error: '用户名至少 2 个字符' }
  if (data.password.length < 6) return { success: false, error: '密码至少 6 位' }
  if (users[username]) return { success: false, error: '该用户名已被注册' }
  users[username] = {
    password: hashPassword(username, data.password),
    displayName: data.displayName?.trim() || username,
    department: data.department,
    role: data.role,
    mustChangePassword: data.mustChangePassword ?? false,
  }
  saveRegisteredUsers(users)
  return { success: true }
}

export function deleteUser(username: string): { success: boolean; error?: string } {
  const users = getRegisteredUsers()
  if (username === SUPER_ADMIN.username) return { success: false, error: '超级管理员账户不可注销' }
  if (!users[username]) return { success: false, error: '用户不存在' }
  delete users[username]
  saveRegisteredUsers(users)
  return { success: true }
}

export function resetPassword(username: string, newPassword: string): { success: boolean; error?: string } {
  const users = getRegisteredUsers()
  if (!users[username]) return { success: false, error: '用户不存在' }
  if (newPassword.length < 6) return { success: false, error: '新密码至少 6 位' }
  users[username].password = hashPassword(username, newPassword)
  users[username].mustChangePassword = true // 重置后首次登录需修改密码
  saveRegisteredUsers(users)
  return { success: true }
}

export function changePassword(
  username: string,
  oldPassword: string,
  newPassword: string
): { success: boolean; error?: string } {
  const users = getRegisteredUsers()
  const u = users[username]
  if (!u) return { success: false, error: '用户不存在' }
  if (!verifyPassword(u, username, oldPassword)) return { success: false, error: '原密码错误' }
  if (newPassword.length < 6) return { success: false, error: '新密码至少 6 位' }
  u.password = hashPassword(username, newPassword)
  u.mustChangePassword = false
  saveRegisteredUsers(users)
  return { success: true }
}

/** 强制改密（首次登录）：以哈希方式写入新密码，清除 mustChangePassword。
 *  用于首次登录强制修改场景，避免以明文存储密码。 */
export function forceSetPassword(username: string, newPassword: string): { success: boolean; error?: string } {
  const users = getRegisteredUsers()
  const u = users[username]
  if (!u) return { success: false, error: '用户不存在' }
  if (newPassword.length < 6) return { success: false, error: '新密码至少 6 位' }
  u.password = hashPassword(username, newPassword)
  u.mustChangePassword = false
  saveRegisteredUsers(users)
  return { success: true }
}

// ===== 权限辅助 =====

export function isSuperAdmin(user: User | null): boolean {
  return !!user && user.username === SUPER_ADMIN.username
}

/** 是否可访问用户管理模块（仅 IT 部管理员） */
export function canAccessUserManagement(user: User | null): boolean {
  return !!user && user.department === 'IT部' && user.role === 'admin'
}

/** 查询上传人所属部门 */
export function getUploaderDepartment(username: string): string | null {
  const users = getRegisteredUsers()
  const u = users[username]
  return u ? u.department : null
}

/**
 * 是否可审核/删除某文档。
 * - 仅管理员可操作
 * - IT 部管理员（含超级管理员）可处理全部文档
 * - 其他部门管理员仅限处理本部门账户上传的文档（未知上传人视为历史文档，管理员均可处理）
 */
export function canReviewDoc(user: User | null, uploaderUsername: string): boolean {
  if (!user || user.role !== 'admin') return false
  const isITAdmin = user.department === 'IT部'
  if (isITAdmin) return true
  const uploaderDept = getUploaderDepartment(uploaderUsername)
  if (uploaderDept === null) return true
  return uploaderDept === user.department
}
