import { describe, it, expect } from 'vitest'
import {
  presetQuestions,
  mockAnalysisTree,
  mockParamRecommendations,
  mockSources,
  mockMesData,
  mockKnowledgeGraph,
  mockThinkingSteps,
  generateResponse,
  initialConversations,
} from './mockData'

describe('mockData', () => {
  it('导出非空的预设数据', () => {
    expect(presetQuestions.length).toBeGreaterThan(0)
    expect(mockAnalysisTree).toBeTruthy()
    expect(mockParamRecommendations.length).toBeGreaterThan(0)
    expect(mockSources.length).toBeGreaterThan(0)
    expect(mockMesData).toBeTruthy()
    expect(mockKnowledgeGraph).toBeTruthy()
    expect(mockThinkingSteps.length).toBeGreaterThan(0)
  })
  it('初始对话为空数组', () => {
    expect(Array.isArray(initialConversations)).toBe(true)
    expect(initialConversations.length).toBe(0)
  })

  describe('generateResponse', () => {
    it('异常分析场景（含"胀气/异常"）', () => {
      const res = generateResponse('电芯胀气怎么处理')
      expect(res.some(b => b.type === 'analysisTree')).toBe(true)
      expect(res.some(b => b.type === 'thinking')).toBe(true)
      expect(res.some(b => b.type === 'sourceList')).toBe(true)
    })
    it('参数调优场景（含"参数/化成"）', () => {
      const res = generateResponse('化成参数调优')
      expect(res.some(b => b.type === 'paramCard')).toBe(true)
    })
    it('MES 数据查询场景（含"OEE/良率"）', () => {
      const res = generateResponse('今天良率多少')
      expect(res.some(b => b.type === 'mesData')).toBe(true)
    })
    it('知识检索场景（含"报告/文档"）', () => {
      const res = generateResponse('检索安全文档')
      expect(res.some(b => b.type === 'sourceList')).toBe(true)
    })
    it('默认回复', () => {
      const res = generateResponse('你好')
      expect(res.length).toBe(1)
      expect(res[0].type).toBe('text')
    })
  })
})
