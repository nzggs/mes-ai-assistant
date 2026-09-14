// @vitest-environment node
// /api/memories 路由级回归测试。
// 背景：listMemories 改为 async 后，GET 路由没 await，Promise 被 JSON 序列化成 {}，
// 前端拿到非数组 memories 后 memories.map 崩溃 → 整页白屏。本文件防止该类问题回归。
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { app, configureStorage, resetStorageCache } from './index.js'
import { configureMemoryStore, deleteAllMemories } from './memoryStore.js'

let tmpFile = ''
let tmpDirs = []

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `mem-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  configureMemoryStore({ file: tmpFile })
})

afterAll(() => {
  try { fs.rmSync(tmpFile, { force: true }) } catch { /* ignore */ }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  configureMemoryStore({})
})

describe('GET /api/memories', () => {
  it('memories 字段必须是数组（Promise 若被误序列化会得到 {}）', async () => {
    const res = await request(app).get('/api/memories?username=route-test')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Array.isArray(res.body.memories)).toBe(true)
    expect(res.body.limits).toMatchObject({ maxLen: 500, maxPerUser: 100 })
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

describe('deleteAllMemories（删除账号联动清空记忆）', () => {
  it('清空指定账号全部记忆并返回条数；其他账号不受影响；重复清空返回 0', async () => {
    await request(app).post('/api/memories').send({ username: 'del-user', content: '偏好一' })
    await request(app).post('/api/memories').send({ username: 'del-user', content: '偏好二' })
    await request(app).post('/api/memories').send({ username: 'keep-user', content: '保留的偏好' })

    expect(await deleteAllMemories('del-user')).toBe(2)

    const after = await request(app).get('/api/memories?username=del-user')
    expect(after.status).toBe(200)
    expect(after.body.memories).toHaveLength(0)

    const kept = await request(app).get('/api/memories?username=keep-user')
    expect(kept.body.memories).toHaveLength(1)

    expect(await deleteAllMemories('del-user')).toBe(0)
    expect(await deleteAllMemories('no-such-user')).toBe(0)
  })

  it('非法 username 抛 400', async () => {
    await expect(deleteAllMemories('')).rejects.toMatchObject({ status: 400 })
  })
})

describe('POST /api/users 删除账号时同步清空其记忆', () => {
  it('整表覆盖后被移除的账号，其记忆被清空；保留账号记忆不动', async () => {
    // 用户表写入走 storage（users.json），隔离到临时目录，避免污染真实数据
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-route-users-'))
    tmpDirs.push(dir)
    configureStorage({ dataDir: dir })
    resetStorageCache()

    const token = { 'X-Admin-Token': process.env.ADMIN_TOKEN || '' }
    // 先播种两个账号（u-del 待删除、u-keep 保留）
    const seed = await request(app)
      .post('/api/users')
      .set(token)
      .send({ users: {
        'u-del': { password: 'p1', displayName: '待删', department: 'IT部', role: 'user', mustChangePassword: false },
        'u-keep': { password: 'p2', displayName: '保留', department: 'IT部', role: 'user', mustChangePassword: false },
      } })
    expect(seed.status).toBe(200)

    await request(app).post('/api/memories').send({ username: 'u-del', content: '将被清空的偏好' })
    await request(app).post('/api/memories').send({ username: 'u-keep', content: '保留的偏好' })

    // 整表覆盖：只保留 u-keep（= 删除 u-del）
    const res = await request(app)
      .post('/api/users')
      .set(token)
      .send({ users: { 'u-keep': { password: 'p2', displayName: '保留', department: 'IT部', role: 'user', mustChangePassword: false } } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const del = await request(app).get('/api/memories?username=u-del')
    expect(del.body.memories).toHaveLength(0)
    const keep = await request(app).get('/api/memories?username=u-keep')
    expect(keep.body.memories).toHaveLength(1)
  })
})
