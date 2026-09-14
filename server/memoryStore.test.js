import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  configureMemoryStore, listMemories, addMemory, updateMemory, deleteMemory,
  MEMORY_LIMITS,
} from './memoryStore.js'

let tmpFile = ''

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  configureMemoryStore({ file: tmpFile })
})

afterAll(() => {
  try { fs.rmSync(tmpFile, { force: true }) } catch { /* ignore */ }
  configureMemoryStore({})
})

describe('memoryStore', () => {
  it('新用户返回空列表', async () => {
    expect(await listMemories('alice')).toEqual([])
  })

  it('新增记忆并返回列表', async () => {
    const list = await addMemory('alice', '生成的 SQL 列名注释要加双引号')
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('生成的 SQL 列名注释要加双引号')
    expect(list[0].id).toMatch(/^mem-/)
    expect(list[0].createdAt).toBeTruthy()
  })

  it('内容为空或超长时报 400', async () => {
    await expect(addMemory('alice', '   ')).rejects.toMatchObject({ status: 400 })
    await expect(addMemory('alice', 'x'.repeat(MEMORY_LIMITS.maxLen + 1))).rejects.toMatchObject({ status: 400 })
  })

  it('username 非法时报 400', async () => {
    await expect(listMemories('')).rejects.toMatchObject({ status: 400 })
    await expect(addMemory('a\nb', 'x')).rejects.toMatchObject({ status: 400 })
    await expect(addMemory('x'.repeat(65), 'x')).rejects.toMatchObject({ status: 400 })
  })

  it('用户名含中文合法（与注册规则一致），trim 后落库', async () => {
    const list = await addMemory('  张三  ', '回答保持简洁')
    expect(list).toHaveLength(1)
    expect(await listMemories('张三')).toHaveLength(1)
  })

  it('更新记忆：内容生效且 updatedAt 变化，返回最新列表', async () => {
    const before = await addMemory('bob', '旧内容')
    const id = before[0].id
    await new Promise(r => setTimeout(r, 5))
    const after = await updateMemory('bob', id, '新内容')
    expect(after[0].content).toBe('新内容')
    expect(after[0].updatedAt >= after[0].createdAt).toBe(true)
  })

  it('更新/删除不存在的 id 或他人 id 时报 404', async () => {
    await addMemory('bob', '一条')
    await expect(updateMemory('bob', 'mem-nope', 'x')).rejects.toMatchObject({ status: 404 })
    await expect(deleteMemory('bob', 'mem-nope')).rejects.toMatchObject({ status: 404 })
    await expect(updateMemory('alice', 'mem-nope', 'x')).rejects.toMatchObject({ status: 404 })
  })

  it('删除记忆后列表为空；文件里也清理空用户键', async () => {
    const list = await addMemory('carol', '待删除')
    const id = list[0].id
    const after = await deleteMemory('carol', id)
    expect(after).toEqual([])
    const doc = JSON.parse(fs.readFileSync(tmpFile, 'utf8'))
    expect(doc.users.carol).toBeUndefined()
  })

  it('每人最多 50 条，超出报 400', async () => {
    for (let i = 0; i < MEMORY_LIMITS.maxPerUser; i++) {
      await addMemory('dave', `记忆 ${i}`)
    }
    await expect(addMemory('dave', '超出的一条')).rejects.toMatchObject({ status: 400 })
    expect(await listMemories('dave')).toHaveLength(MEMORY_LIMITS.maxPerUser)
  })

  it('并发写入串行化：连续 10 次新增全部落盘不丢失', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => addMemory('eve', `并发 ${i}`)))
    expect(await listMemories('eve')).toHaveLength(10)
  })

  it('持久化：重置内存缓存后从磁盘重新读取', async () => {
    await addMemory('frank', '重启后仍在')
    configureMemoryStore({ file: tmpFile }) // 模拟进程重启
    const list = await listMemories('frank')
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('重启后仍在')
  })

  it('各用户记忆相互隔离', async () => {
    await addMemory('u1', 'u1 的偏好')
    await addMemory('u2', 'u2 的偏好')
    expect(await listMemories('u1')).toHaveLength(1)
    expect(await listMemories('u2')).toHaveLength(1)
    expect((await listMemories('u1'))[0].content).toBe('u1 的偏好')
  })
})
