import { describe, it, expect } from 'vitest'
import { PROMPT_VERSION, SYSTEM_PROMPT } from './systemPrompt.js'

describe('shared/systemPrompt', () => {
  it('导出提示词版本与正文', () => {
    expect(typeof PROMPT_VERSION).toBe('string')
    expect(typeof SYSTEM_PROMPT).toBe('string')
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })
  it('提示词面向 MES / 制造场景', () => {
    expect(SYSTEM_PROMPT).toMatch(/MES/i)
  })
})
