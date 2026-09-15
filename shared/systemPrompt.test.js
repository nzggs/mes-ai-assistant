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

  // 2026-09-15：分析思路类问题（"如何分析…为什么不合格"）必须先给方法、
  // 不查数据，并在末尾引导用户补充码号——避免一上来就触发 SQL 查询。
  it('要求先判断意图：分析思路类问题只给建议不查数据', () => {
    expect(SYSTEM_PROMPT).toMatch(/先判断问题意图/)
    expect(SYSTEM_PROMPT).toMatch(/只给分析建议、不查数据/)
    // 明确禁止在这类回答里输出查询语句/数据代码块
    expect(SYSTEM_PROMPT).toMatch(/不要输出查询语句或任何数据代码块/)
  })
  it('要求在这类回答末尾引导用户补充码号', () => {
    expect(SYSTEM_PROMPT).toMatch(/最后一句/)
    expect(SYSTEM_PROMPT).toMatch(/引导用户补充码号/)
    expect(SYSTEM_PROMPT).toMatch(/SN／工单号／批次/)
  })
})
