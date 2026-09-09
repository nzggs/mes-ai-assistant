// 批量注册 / 账号录入的纯校验逻辑（与 UI 解耦，便于单测复用）
import type { UserRole } from './userService'

/** 用户组（角色）白名单：导入文件中填写的中文/英文需映射到这两种之一，否则视为非法 */
export const ALLOWED_ROLES: Record<string, UserRole> = {
  '用户': 'user', 'user': 'user',
  '管理员': 'admin', 'admin': 'admin',
}

/** 用户名保留字：避免写入 Object 原型键导致原型污染 */
export function isReservedUsername(u: string): boolean {
  return ['__proto__', 'constructor', 'prototype', 'hasOwnProperty'].includes(u)
}

/** 用户名格式：字母/数字/中文/._@-，长度 2-20 */
export const USERNAME_RE = /^[A-Za-z0-9_一-龥.@-]{2,20}$/

/** 密码格式：长度 6-20、无空白、同时含字母与数字 */
export function validatePassword(p: string): string | null {
  if (p.length < 6 || p.length > 20) return '密码长度需 6-20 位'
  if (/\s/.test(p)) return '密码不能包含空格'
  if (!(/[A-Za-z]/.test(p) && /\d/.test(p))) return '密码需同时包含字母和数字'
  return null
}

export interface BatchRowRaw {
  username: string
  displayName: string
  department: string
  roleRaw: string
  password: string
}

export interface BatchRowResult {
  ok: boolean
  username: string
  displayName: string
  department: string
  role: UserRole | null
  error?: string
}

/**
 * 校验单行批量注册数据。
 * @param raw        已 trim 的一行字段
 * @param departments 合法部门白名单
 * @param existingLower 已存在（小写）用户名集合，用于重复检测
 * @param batchLower   本次已成功注册（小写）用户名集合，用于文件内重复检测
 */
export function validateBatchRow(
  raw: BatchRowRaw,
  departments: string[],
  existingLower: Set<string>,
  batchLower: Set<string>,
): BatchRowResult {
  const username = raw.username
  // ---- 用户名 ----
  if (!username) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: '用户名为空' }
  if (isReservedUsername(username)) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: '用户名非法（保留字）' }
  if (!USERNAME_RE.test(username)) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: '用户名仅允许字母/数字/中文/._@-，长度 2-20' }
  const low = username.toLowerCase()
  if (existingLower.has(low) || batchLower.has(low)) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: '用户名已存在' }

  // ---- 显示名称 ----
  if (raw.displayName && raw.displayName.length > 30) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: '显示名称过长（≤30 字）' }

  // ---- 部门 ----
  if (!raw.department) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: '部门为空' }
  if (!departments.includes(raw.department)) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: `部门不存在「${raw.department}」` }

  // ---- 用户组 ----
  const role = ALLOWED_ROLES[raw.roleRaw]
  if (!role) return { ok: false, username, displayName: raw.displayName, department: raw.department, role: null, error: `用户组不存在「${raw.roleRaw || '空'}」` }

  // ---- 密码 ----
  if (!raw.password) return { ok: false, username, displayName: raw.displayName, department: raw.department, role, error: '密码为空' }
  const pwdErr = validatePassword(raw.password)
  if (pwdErr) return { ok: false, username, displayName: raw.displayName, department: raw.department, role, error: pwdErr }

  return { ok: true, username, displayName: raw.displayName, department: raw.department, role }
}
