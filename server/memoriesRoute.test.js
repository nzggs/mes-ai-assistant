// @vitest-environment node
// /api/memories 路由级回归测试。
// 背景：listMemories 改为 async 后，GET 路由没 await，Promise 被 JSON 序列化成 {}，
// 前端拿到非数组 memories 后 memories.map 崩溃 → 整页白屏。本文件防止该类问题回归。
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { app } from './index.js'
import { configureMemoryStore } from './memoryStore.js'

let tmpFile = ''

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `mem-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  configureMemoryStore({ file: tmpFile })
})

afterAll(() => {
  try { fs.rmSync(tmpFile, { force: true }) } catch { /* ignore */ }
  configureMemoryStore({})
})

describe('GET /api/memories', () => {
  it('memories 字段必须是数组（Promise 若被误序列化会得到 {}）', async () => {
    const res = await request(app).get('/api/memories?username=route-test')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Array.isArray(res.body.memories)).toBe(true)
    expect(res.body.limits).toMatchObject({ maxLen: 500, maxPerUser: 50 })
  })
})

describe('/api/memories 增删改查回路', () => {
  it('add → list（数组且含新条目）→ delete → list 为空', async () => {
    const add = await request(app)
      .post('/api/memories')
      .send({ username: 'route-test', content: 'SQL 列名注释要加双引号' })
    expect(add.status).toBe(200)
    expect(Array.isArray(add.body.memories)).toBe(true)
    const id = add.body.memories[0].id

    const list = await request(app).get('/api/memories?username=route-test')
    expect(Array.isArray(list.body.memories)).toBe(true)
    expect(list.body.memories.some(m => m.id === id)).toBe(true)

    const upd = await request(app)
      .put(`/api/memories/${id}`)
      .send({ username: 'route-test', content: '更新后的偏好' })
    expect(upd.status).toBe(200)
    expect(upd.body.memories.find(m => m.id === id).content).toBe('更新后的偏好')

    const del = await request(app).delete(`/api/memories/${id}?username=route-test`)
    expect(del.status).toBe(200)
    const after = await request(app).get('/api/memories?username=route-test')
    expect(Array.isArray(after.body.memories)).toBe(true)
    expect(after.body.memories).toHaveLength(0)
  })

  it('非法 username 返回 400', async () => {
    const res = await request(app).get('/api/memories?username=')
    expect(res.status).toBe(400)
  })
})
