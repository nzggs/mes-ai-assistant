/**
 * MES AI 智能助手 - 系统提示词（后端代理模式）
 * 与前端 llmApi.ts 共享同一份提示词（shared/systemPrompt.js），保证内容一致。
 */
import { SYSTEM_PROMPT } from '../shared/systemPrompt.js'

export function createSystemPrompt() {
  return SYSTEM_PROMPT
}
