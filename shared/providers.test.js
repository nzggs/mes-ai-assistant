import { describe, it, expect } from 'vitest'
import { PROVIDER_LIST } from './providers.js'

describe('shared/providers', () => {
  it('导出非空提供商列表', () => {
    expect(Array.isArray(PROVIDER_LIST)).toBe(true)
    expect(PROVIDER_LIST.length).toBeGreaterThan(0)
  })
  it('每个提供商含必要字段', () => {
    for (const p of PROVIDER_LIST) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(typeof p.apiUrl).toBe('string')
      expect(Array.isArray(p.models)).toBe(true)
      expect(p.models.length).toBeGreaterThan(0)
      expect(typeof p.defaultModel).toBe('string')
    }
  })
  it('含 deepseek 与 minimax（GroupId 直连场景）', () => {
    const ids = PROVIDER_LIST.map((p) => p.id)
    expect(ids).toContain('deepseek')
    expect(ids).toContain('minimax')
  })
  it('provider id 唯一', () => {
    const ids = PROVIDER_LIST.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
