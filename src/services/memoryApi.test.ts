import { describe, it, expect } from 'vitest'
import { buildMemoryContext } from './memoryApi'

describe('buildMemoryContext', () => {
  it('始终注入「记忆保存机制」约定（无记忆时也注入，否则模型不知道要输出 user-memory 代码块）', () => {
    const ctx = buildMemoryContext([])
    expect(ctx).toContain('user-memory')
    expect(ctx).toContain('（暂无）')
  })

  it('传入 null/undefined 不抛错且仍注入机制', () => {
    expect(() => buildMemoryContext(null)).not.toThrow()
    expect(() => buildMemoryContext(undefined)).not.toThrow()
    expect(buildMemoryContext(null)).toContain('user-memory')
  })

  it('有记忆时逐条列出内容', () => {
    const ctx = buildMemoryContext([
      { id: '1', content: '生成的 SQL 列名注释要加双引号', createdAt: '', updatedAt: '' },
      { id: '2', content: '涉及账号、用户名、邮箱从 Z_USER_EXTEND 查询', createdAt: '', updatedAt: '' },
    ])
    expect(ctx).toContain('生成的 SQL 列名注释要加双引号')
    expect(ctx).toContain('Z_USER_EXTEND')
    expect(ctx).not.toContain('（暂无）')
  })

  it('超长记忆内容被压缩到 200 字以内', () => {
    const long = 'x'.repeat(500)
    const ctx = buildMemoryContext([{ id: '1', content: long, createdAt: '', updatedAt: '' }])
    expect(ctx).toContain('x'.repeat(200))
    expect(ctx).not.toContain('x'.repeat(201))
  })
})
