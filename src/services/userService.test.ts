import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SUPER_ADMIN,
  DEPARTMENTS,
  verifyPassword,
  upgradePasswordToHash,
  getRegisteredUsers,
  saveRegisteredUsers,
  syncUsersFromBackend,
  ensureSuperAdminSeeded,
  getSession,
  setSession,
  clearSession,
  registerUser,
  deleteUser,
  resetPassword,
  changePassword,
  forceSetPassword,
  isSuperAdmin,
  canAccessUserManagement,
  getUploaderDepartment,
  canReviewDoc,
} from './userService'

describe('userService', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('常量', () => {
    it('超级管理员预设', () => {
      expect(SUPER_ADMIN.username).toBe('SITE_ADMIN')
      expect(SUPER_ADMIN.role).toBe('admin')
      expect(SUPER_ADMIN.department).toBe('IT部')
    })
    it('部门列表非空且含 IT 部', () => {
      expect(Array.isArray(DEPARTMENTS)).toBe(true)
      expect(DEPARTMENTS).toContain('IT部')
    })
  })

  describe('密码哈希与校验', () => {
    it('ensureSuperAdminSeeded 写入哈希密码（非明文）', () => {
      ensureSuperAdminSeeded()
      const u = getRegisteredUsers()[SUPER_ADMIN.username]
      expect(u).toBeTruthy()
      expect(u.password).toMatch(/^[0-9a-f]{64}$/i)
      expect(u.password).not.toContain('Admin@2026')
      expect(u.mustChangePassword).toBe(true)
    })
    it('verifyPassword 校验哈希密码正确/错误', () => {
      ensureSuperAdminSeeded()
      const u = getRegisteredUsers()[SUPER_ADMIN.username]
      expect(verifyPassword(u, SUPER_ADMIN.username, 'Admin@2026#Site')).toBe(true)
      expect(verifyPassword(u, SUPER_ADMIN.username, 'wrong-password')).toBe(false)
    })
    it('verifyPassword 兼容历史明文', () => {
      const stored = { password: 'plain123', displayName: 'x', department: 'IT部', role: 'user' as const, mustChangePassword: false }
      expect(verifyPassword(stored, 'alice', 'plain123')).toBe(true)
      expect(verifyPassword(stored, 'alice', 'nope')).toBe(false)
    })
    it('upgradePasswordToHash 把明文升级为哈希', () => {
      saveRegisteredUsers({ alice: { password: 'plain123', displayName: 'x', department: 'IT部', role: 'user', mustChangePassword: false } })
      upgradePasswordToHash('alice')
      const u = getRegisteredUsers()['alice']
      expect(u.password).toMatch(/^[0-9a-f]{64}$/i)
    })
    it('upgradePasswordToHash 对已是哈希的记录不重复处理', () => {
      saveRegisteredUsers({ alice: { password: 'a'.repeat(64), displayName: 'x', department: 'IT部', role: 'user', mustChangePassword: false } })
      upgradePasswordToHash('alice')
      expect(getRegisteredUsers()['alice'].password).toBe('a'.repeat(64))
    })
  })

  describe('存储读写', () => {
    it('getRegisteredUsers 空表返回 {}', () => {
      expect(getRegisteredUsers()).toEqual({})
    })
    it('saveRegisteredUsers 持久化并同步后端', () => {
      saveRegisteredUsers({ bob: { password: 'x', displayName: 'x', department: 'IT部', role: 'user', mustChangePassword: false } })
      expect(getRegisteredUsers()['bob']).toBeTruthy()
    })
    it('getRegisteredUsers 对损坏 JSON 返回 {}', () => {
      localStorage.setItem('mes-ai-users', '{broken')
      expect(getRegisteredUsers()).toEqual({})
    })
  })

  describe('会话', () => {
    it('get/set/clear session', () => {
      expect(getSession()).toBeNull()
      setSession({ username: 'u', displayName: 'U', department: 'IT部', role: 'admin' })
      expect(getSession()?.username).toBe('u')
      clearSession()
      expect(getSession()).toBeNull()
    })
    it('getSession 对损坏 JSON 返回 null', () => {
      localStorage.setItem('mes-ai-session', '{bad')
      expect(getSession()).toBeNull()
    })
  })

  describe('注册', () => {
    it('用户名过短', () => {
      expect(registerUser({ username: 'a', password: 'abc123', department: 'IT部', role: 'user' }).success).toBe(false)
    })
    it('密码过短', () => {
      expect(registerUser({ username: 'alice', password: '123', department: 'IT部', role: 'user' }).success).toBe(false)
    })
    it('重复注册', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      const r = registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      expect(r.success).toBe(false)
      expect(r.error).toContain('已被注册')
    })
    it('注册成功并哈希存储', () => {
      const r = registerUser({ username: '  alice  ', password: 'abc123', department: 'IT部', role: 'admin' })
      expect(r.success).toBe(true)
      const u = getRegisteredUsers()['alice']
      expect(u.password).toMatch(/^[0-9a-f]{64}$/i)
      expect(u.role).toBe('admin')
    })
  })

  describe('注销', () => {
    it('超管不可注销', () => {
      const r = deleteUser(SUPER_ADMIN.username)
      expect(r.success).toBe(false)
      expect(r.error).toContain('超级管理员')
    })
    it('用户不存在', () => {
      expect(deleteUser('ghost').success).toBe(false)
    })
    it('正常注销', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      expect(deleteUser('alice').success).toBe(true)
      expect(getRegisteredUsers()['alice']).toBeUndefined()
    })
  })

  describe('重置密码', () => {
    it('用户不存在', () => {
      expect(resetPassword('ghost', 'abc123').success).toBe(false)
    })
    it('新密码过短', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      expect(resetPassword('alice', '123').success).toBe(false)
    })
    it('重置成功且强制改密', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      const r = resetPassword('alice', 'xyz789')
      expect(r.success).toBe(true)
      const u = getRegisteredUsers()['alice']
      expect(u.mustChangePassword).toBe(true)
      expect(verifyPassword(u, 'alice', 'xyz789')).toBe(true)
    })
  })

  describe('修改密码', () => {
    it('用户不存在', () => {
      expect(changePassword('ghost', 'a', 'abc123').success).toBe(false)
    })
    it('原密码错误', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      const r = changePassword('alice', 'wrong1', 'xyz789')
      expect(r.success).toBe(false)
      expect(r.error).toContain('原密码')
    })
    it('新密码过短', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      expect(changePassword('alice', 'abc123', '1').success).toBe(false)
    })
    it('修改成功并清除强制改密标记', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      const r = changePassword('alice', 'abc123', 'xyz789')
      expect(r.success).toBe(true)
      const u = getRegisteredUsers()['alice']
      expect(u.mustChangePassword).toBe(false)
      expect(verifyPassword(u, 'alice', 'xyz789')).toBe(true)
    })
  })

  describe('强制改密', () => {
    it('用户不存在', () => {
      expect(forceSetPassword('ghost', 'abc123').success).toBe(false)
    })
    it('新密码过短', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      expect(forceSetPassword('alice', '1').success).toBe(false)
    })
    it('成功', () => {
      registerUser({ username: 'alice', password: 'abc123', department: 'IT部', role: 'user' })
      expect(forceSetPassword('alice', 'xyz789').success).toBe(true)
      const u = getRegisteredUsers()['alice']
      expect(u.mustChangePassword).toBe(false)
    })
  })

  describe('权限辅助', () => {
    const admin = { username: 'a', displayName: 'A', department: 'IT部', role: 'admin' as const }
    const prodAdmin = { username: 'p', displayName: 'P', department: '生产部', role: 'admin' as const }
    const normalUser = { username: 'u', displayName: 'U', department: '生产部', role: 'user' as const }

    it('isSuperAdmin', () => {
      expect(isSuperAdmin({ ...admin, username: 'SITE_ADMIN' })).toBe(true)
      expect(isSuperAdmin(admin)).toBe(false)
      expect(isSuperAdmin(null)).toBe(false)
    })
    it('canAccessUserManagement 仅 IT 部管理员', () => {
      expect(canAccessUserManagement(admin)).toBe(true)
      expect(canAccessUserManagement(prodAdmin)).toBe(false)
      expect(canAccessUserManagement(normalUser)).toBe(false)
      expect(canAccessUserManagement(null)).toBe(false)
    })
    it('getUploaderDepartment', () => {
      registerUser({ username: 'bob', password: 'abc123', department: '质量部', role: 'user' })
      expect(getUploaderDepartment('bob')).toBe('质量部')
      expect(getUploaderDepartment('ghost')).toBeNull()
    })
    it('canReviewDoc：非管理员不可', () => {
      expect(canReviewDoc(normalUser, 'bob')).toBe(false)
      expect(canReviewDoc(null, 'bob')).toBe(false)
    })
    it('canReviewDoc：IT 部管理员可处理全部', () => {
      expect(canReviewDoc(admin, 'bob')).toBe(true)
    })
    it('canReviewDoc：其他部门管理员仅限本部门', () => {
      registerUser({ username: 'bob', password: 'abc123', department: '生产部', role: 'user' })
      registerUser({ username: 'carol', password: 'abc123', department: '质量部', role: 'user' })
      expect(canReviewDoc(prodAdmin, 'bob')).toBe(true)
      expect(canReviewDoc(prodAdmin, 'carol')).toBe(false)
    })
    it('canReviewDoc：未知上传人视为历史文档可处理', () => {
      expect(canReviewDoc(prodAdmin, 'unknown-user')).toBe(true)
    })
  })

  describe('后端同步', () => {
    it('syncUsersFromBackend：后端有数据覆盖本地', async () => {
      const remote = { alice: { password: 'h'.repeat(64), displayName: 'A', department: 'IT部', role: 'admin', mustChangePassword: false } }
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ users: remote }) } as Response)))
      saveRegisteredUsers({ bob: { password: 'x', displayName: 'B', department: 'IT部', role: 'user', mustChangePassword: false } })
      await syncUsersFromBackend()
      expect(getRegisteredUsers()['alice']).toBeTruthy()
      expect(getRegisteredUsers()['bob']).toBeUndefined()
    })
    it('syncUsersFromBackend：后端为空且本地有数据则推送', async () => {
      const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ users: {} }) } as Response))
      vi.stubGlobal('fetch', fetchMock)
      saveRegisteredUsers({ bob: { password: 'x', displayName: 'B', department: 'IT部', role: 'user', mustChangePassword: false } })
      await syncUsersFromBackend()
      expect(fetchMock).toHaveBeenCalled()
      // 本地数据不被清空
      expect(getRegisteredUsers()['bob']).toBeTruthy()
    })
    it('syncUsersFromBackend：后端不可达时静默忽略', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
      saveRegisteredUsers({ bob: { password: 'x', displayName: 'B', department: 'IT部', role: 'user', mustChangePassword: false } })
      await expect(syncUsersFromBackend()).resolves.toBeUndefined()
      expect(getRegisteredUsers()['bob']).toBeTruthy()
    })
    it('syncUsersFromBackend：响应非对象忽略', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ users: 'not-object' }) } as Response)))
      await expect(syncUsersFromBackend()).resolves.toBeUndefined()
    })
    it('syncUsersFromBackend：!ok 直接返回', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response)))
      await expect(syncUsersFromBackend()).resolves.toBeUndefined()
    })
  })
})
