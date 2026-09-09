import { describe, it, expect } from 'vitest'
import {
  ALLOWED_ROLES,
  isReservedUsername,
  USERNAME_RE,
  validatePassword,
  validateBatchRow,
} from './userValidation'

describe('userValidation', () => {
  describe('ALLOWED_ROLES', () => {
    it('映射中英文角色', () => {
      expect(ALLOWED_ROLES['用户']).toBe('user')
      expect(ALLOWED_ROLES['user']).toBe('user')
      expect(ALLOWED_ROLES['管理员']).toBe('admin')
      expect(ALLOWED_ROLES['admin']).toBe('admin')
    })
  })

  describe('isReservedUsername', () => {
    it('识别原型链保留字', () => {
      expect(isReservedUsername('__proto__')).toBe(true)
      expect(isReservedUsername('constructor')).toBe(true)
      expect(isReservedUsername('prototype')).toBe(true)
      expect(isReservedUsername('hasOwnProperty')).toBe(true)
    })
    it('普通用户名返回 false', () => {
      expect(isReservedUsername('alice')).toBe(false)
      expect(isReservedUsername('管理员')).toBe(false)
    })
  })

  describe('USERNAME_RE', () => {
    it('合法范围', () => {
      expect(USERNAME_RE.test('ab')).toBe(true)
      expect(USERNAME_RE.test('张三')).toBe(true)
      expect(USERNAME_RE.test('a.b@x-y')).toBe(true)
    })
    it('非法范围', () => {
      expect(USERNAME_RE.test('a')).toBe(false) // 太短
      expect(USERNAME_RE.test('a'.repeat(21))).toBe(false) // 太长
      expect(USERNAME_RE.test('has space')).toBe(false)
    })
  })

  describe('validatePassword', () => {
    it('长度不合法', () => {
      expect(validatePassword('123')).toBe('密码长度需 6-20 位')
      expect(validatePassword('a'.repeat(21))).toBe('密码长度需 6-20 位')
    })
    it('含空白', () => {
      expect(validatePassword('abc 123')).toContain('空格')
    })
    it('需同时含字母与数字', () => {
      expect(validatePassword('abcdef')).toContain('字母和数字')
      expect(validatePassword('123456')).toContain('字母和数字')
    })
    it('合法密码返回 null', () => {
      expect(validatePassword('abc123')).toBeNull()
      expect(validatePassword('Passw0rd')).toBeNull()
    })
  })

  describe('validateBatchRow', () => {
    const depts = ['IT部', '生产部']
    const existing = new Set<string>()
    const batch = new Set<string>()

    it('用户名为空', () => {
      const r = validateBatchRow({ username: '', displayName: 'x', department: 'IT部', roleRaw: 'user', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('用户名')
    })
    it('保留字用户名', () => {
      const r = validateBatchRow({ username: '__proto__', displayName: 'x', department: 'IT部', roleRaw: 'user', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('保留字')
    })
    it('非法用户名格式', () => {
      const r = validateBatchRow({ username: 'a', displayName: 'x', department: 'IT部', roleRaw: 'user', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('仅允许')
    })
    it('用户名已存在（existing）', () => {
      const r = validateBatchRow({ username: 'Bob', displayName: 'x', department: 'IT部', roleRaw: 'user', password: 'abc123' }, depts, new Set(['bob']), batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('已存在')
    })
    it('用户名已存在（本次 batch）', () => {
      const r = validateBatchRow({ username: 'Bob', displayName: 'x', department: 'IT部', roleRaw: 'user', password: 'abc123' }, depts, existing, new Set(['bob']))
      expect(r.ok).toBe(false)
      expect(r.error).toContain('已存在')
    })
    it('显示名过长', () => {
      const r = validateBatchRow({ username: 'alice', displayName: 'x'.repeat(31), department: 'IT部', roleRaw: 'user', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('显示名称')
    })
    it('部门为空', () => {
      const r = validateBatchRow({ username: 'alice', displayName: 'x', department: '', roleRaw: 'user', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('部门')
    })
    it('部门不存在', () => {
      const r = validateBatchRow({ username: 'alice', displayName: 'x', department: '未知部', roleRaw: 'user', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('部门不存在')
    })
    it('用户组不存在', () => {
      const r = validateBatchRow({ username: 'alice', displayName: 'x', department: 'IT部', roleRaw: 'guest', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('用户组')
    })
    it('密码为空', () => {
      const r = validateBatchRow({ username: 'alice', displayName: 'x', department: 'IT部', roleRaw: 'user', password: '' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('密码为空')
    })
    it('密码不合法', () => {
      const r = validateBatchRow({ username: 'alice', displayName: 'x', department: 'IT部', roleRaw: 'user', password: 'abcdef' }, depts, existing, batch)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('字母')
    })
    it('全部合法', () => {
      const r = validateBatchRow({ username: 'alice', displayName: '爱丽丝', department: 'IT部', roleRaw: '管理员', password: 'abc123' }, depts, existing, batch)
      expect(r.ok).toBe(true)
      expect(r.role).toBe('admin')
    })
  })
})
