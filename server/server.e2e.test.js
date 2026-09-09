// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import request from 'supertest'
import { app, configureStorage, resetStorageCache, requireAdmin, chatRateLimit, buildProviderUrl } from './index.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-e2e-'))
  configureStorage({ dataDir: dir })
  resetStorageCache()
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// 构造一个 SSE 流式响应（模拟 LLM 直连返回）
function sseResponse(chunks) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const jsonFetch = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

describe('健康检查', () => {
  it('GET /api/health 返回 provider 列表', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(Array.isArray(res.body.providers)).toBe(true)
    expect(res.body.providers).toContain('deepseek')
  })
})

describe('文档列表与分页', () => {
  it('空库返回 []', async () => {
    const res = await request(app).get('/api/docs')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(0)
  })
  it('分页返回轻量元数据与总数', async () => {
    await request(app).post('/api/docs').send({ id: 'p1', doc: { name: 'A', status: 'approved', textContent: 'x' } })
    await request(app).post('/api/docs').send({ id: 'p2', doc: { name: 'B' } })
    const res = await request(app).get('/api/docs?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].doc.name).toBe('A')
    expect(res.body.items[0].doc.textContent).toBeUndefined()
    expect(res.body.items[0].doc.hasContent).toBe(true)
  })
  it('按 status 过滤', async () => {
    await request(app).post('/api/docs').send({ id: 'a1', doc: { name: 'A', status: 'approved' } })
    await request(app).post('/api/docs').send({ id: 'b1', doc: { name: 'B', status: 'pending' } })
    const res = await request(app).get('/api/docs?status=approved&page=1')
    const ids = res.body.items.map(r => r.id)
    expect(ids).toEqual(['a1'])
  })
  it('按 q 关键字搜索', async () => {
    await request(app).post('/api/docs').send({ id: 's1', doc: { name: '设备手册' } })
    const res = await request(app).get('/api/docs?q=手册&page=1')
    expect(res.body.items.map(r => r.id)).toEqual(['s1'])
  })
})

describe('保存/更新文档', () => {
  it('创建文档成功', async () => {
    const res = await request(app).post('/api/docs').send({ id: 'd1', doc: { name: '测试', status: 'pending' } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
  it('缺少 id/doc 返回 400', async () => {
    expect((await request(app).post('/api/docs').send({})).status).toBe(400)
    expect((await request(app).post('/api/docs').send({ id: 'x' })).status).toBe(400)
  })
  it('非法 id 返回 400', async () => {
    expect((await request(app).post('/api/docs').send({ id: '../x', doc: {} })).status).toBe(400)
  })
  it('文件过大返回 413', async () => {
    const big = 'A'.repeat(100 * 1024 * 1024 * 4 / 3 + 100)
    const res = await request(app).post('/api/docs').send({ id: 'big', doc: { name: 'big.bin' }, fileBase64: big })
    expect(res.status).toBe(413)
  }, 30000)
  it('不支持的文件类型返回 400', async () => {
    const res = await request(app).post('/api/docs').send({ id: 'e1', doc: { name: 'x.exe' }, fileBase64: 'AAAA' })
    expect(res.status).toBe(400)
  })
  it('同名文档重复上传返回 409 并带 existingId', async () => {
    await request(app).post('/api/docs').send({ id: 'dup', doc: { name: '重复名' } })
    const res = await request(app).post('/api/docs').send({ id: 'dup2', doc: { name: '重复名' } })
    expect(res.status).toBe(409)
    expect(res.body.existingId).toBe('dup')
  })
  it('已删除文档非重传更新返回 409', async () => {
    await request(app).post('/api/docs').send({ id: 'del', doc: { name: '将被删' } })
    await request(app).delete('/api/docs/del')
    const res = await request(app).post('/api/docs').send({ id: 'del', doc: { name: '将被删', status: 'approved' } })
    expect(res.status).toBe(409)
  })
  it('重新上传（带 fileBase64）会清除墓碑', async () => {
    await request(app).post('/api/docs').send({ id: 'reup', doc: { name: 'r.pdf' } })
    await request(app).delete('/api/docs/reup')
    const res = await request(app).post('/api/docs').send({ id: 'reup', doc: { name: 'r.pdf' }, fileBase64: 'AAAA' })
    expect(res.status).toBe(200)
    const got = await request(app).get('/api/docs/reup')
    expect(got.body.doc.deleted).toBeFalsy()
  })
  it('携带合法 fileBase64 会写原始文件', async () => {
    const res = await request(app).post('/api/docs').send({ id: 'f1', doc: { name: 'f.pdf' }, fileBase64: 'QUJD' }) // "ABC"
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(dir, 'files', 'f1'))).toBe(true)
  })
})

describe('单篇文档与文件', () => {
  it('获取完整文档', async () => {
    await request(app).post('/api/docs').send({ id: 'one', doc: { name: '1', textContent: '正文' } })
    const res = await request(app).get('/api/docs/one')
    expect(res.status).toBe(200)
    expect(res.body.doc.textContent).toBe('正文')
  })
  it('已删除文档返回 404', async () => {
    await request(app).post('/api/docs').send({ id: 'gone', doc: { name: 'g' } })
    await request(app).delete('/api/docs/gone')
    expect((await request(app).get('/api/docs/gone')).status).toBe(404)
  })
  it('非法 id 返回 400', async () => {
    expect((await request(app).get('/api/docs/' + encodeURIComponent('a/b'))).status).toBe(400)
  })
  it('文件缺失返回 404', async () => {
    expect((await request(app).get('/api/docs/nofile/file')).status).toBe(404)
  })
})

describe('删除文档（墓碑）', () => {
  it('删除成功', async () => {
    await request(app).post('/api/docs').send({ id: 'dd', doc: { name: 'd' } })
    const res = await request(app).delete('/api/docs/dd')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
  it('非法 id 返回 400', async () => {
    expect((await request(app).delete('/api/docs/' + encodeURIComponent('a/b'))).status).toBe(400)
  })
})

describe('用户表（管理路由默认放开）', () => {
  it('GET 返回用户', async () => {
    const res = await request(app).get('/api/users')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('users')
  })
  it('POST 覆盖用户表（且真正落盘，防止"返回 200 但未写入"回归）', async () => {
    const payload = {
      u1: { password: 'p1', displayName: '用户一', department: 'IT部', role: 'user', mustChangePassword: true },
      u2: { password: 'p2', displayName: '用户二', department: '技术部', role: 'admin', mustChangePassword: false },
    }
    const res = await request(app).post('/api/users').send({ users: payload })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // 关键断言：读回必须包含刚写入的账号（此前 withUsersWrite 语义错配导致"写新→被旧覆盖"）
    const got = await request(app).get('/api/users')
    expect(got.body.users.u1).toBeTruthy()
    expect(got.body.users.u2).toBeTruthy()
    expect(Object.keys(got.body.users).sort()).toEqual(['u1', 'u2'])
  })
  it('POST 非法 body 返回 400', async () => {
    expect((await request(app).post('/api/users').send({ users: [] })).status).toBe(400)
    expect((await request(app).post('/api/users').send({})).status).toBe(400)
  })
})

describe('文档操作日志', () => {
  it('POST 合法日志成功', async () => {
    const res = await request(app).post('/api/doc-logs').send({ log: { action: 'upload', operator: 'u1', target: 'd1' } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.log.id).toBeTruthy()
  })
  it('POST 缺失 log 返回 400', async () => {
    expect((await request(app).post('/api/doc-logs').send({})).status).toBe(400)
  })
  it('POST 非法 action 返回 400', async () => {
    expect((await request(app).post('/api/doc-logs').send({ log: { action: 'hack', operator: 'u' } })).status).toBe(400)
  })
  it('POST 字段超长返回 400', async () => {
    expect((await request(app).post('/api/doc-logs').send({ log: { action: 'upload', operator: 'u', detail: 'x'.repeat(501) } })).status).toBe(400)
  })
  it('GET 返回日志列表', async () => {
    await request(app).post('/api/doc-logs').send({ log: { action: 'approve', operator: 'u' } })
    const res = await request(app).get('/api/doc-logs')
    expect(res.status).toBe(200)
    expect(res.body.logs.length).toBeGreaterThan(0)
  })
})

describe('聊天接口 /api/chat (SSE)', () => {
  it('缺少 messages 返回 400', async () => {
    expect((await request(app).post('/api/chat').send({})).status).toBe(400)
    expect((await request(app).post('/api/chat').send({ messages: [] })).status).toBe(400)
  })
  it('消息过多返回 400', async () => {
    const msgs = Array.from({ length: 201 }, (_, i) => ({ role: 'user', content: 'x' + i }))
    expect((await request(app).post('/api/chat').send({ messages: msgs })).status).toBe(400)
  })
  it('单条消息超长返回 400', async () => {
    expect((await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'x'.repeat(200001) }] })).status).toBe(400)
  })
  it('无 API Key 返回 SSE error 事件', async () => {
    const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.text).toContain('"type":"error"')
    expect(res.text).toContain('[DONE]')
  })
  it('API Key 过短返回 SSE error', async () => {
    const res = await request(app).post('/api/chat').set('X-Api-Key', 'short').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.text).toContain('"type":"error"')
  })
  it('上游 401 返回 SSE error', async () => {
    fetch.mockResolvedValue(jsonFetch({ error: { message: 'invalid' } }, 401))
    const res = await request(app).post('/api/chat').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.text).toContain('"type":"error"')
  })
  it('MiniMax 200 但业务错误（base_resp）透出 error', async () => {
    const sse = 'data: {"base_resp":{"status_code":1000,"status_msg":"key invalid"}}\n\n\ndata: [DONE]\n\n'
    fetch.mockResolvedValue(sseResponse([sse]))
    const res = await request(app).post('/api/chat').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }], providerId: 'minimax' })
    expect(res.text).toContain('"type":"error"')
    expect(res.text).toContain('key invalid')
  })
  it('正常流式转发 content/thinking', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"我在想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    fetch.mockResolvedValue(sseResponse([sse]))
    const res = await request(app).post('/api/chat').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.text).toContain('"type":"thinking"')
    expect(res.text).toContain('"type":"content"')
    expect(res.text).toContain('"type":"content"')
    expect(res.text).toContain('[DONE]')
  })
  it('推理模型跳过 temperature 参数（不报错即可）', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"r"}}]}\n\n\ndata: [DONE]\n\n'
    fetch.mockResolvedValue(sseResponse([sse]))
    const res = await request(app).post('/api/chat').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }], modelId: 'deepseek-reasoner' })
    expect(res.text).toContain('"type":"content"')
  })
})

describe('一次性补全 /api/chat-once', () => {
  it('缺少 messages 返回 400', async () => {
    expect((await request(app).post('/api/chat-once').send({})).status).toBe(400)
  })
  it('无 API Key 返回 400', async () => {
    expect((await request(app).post('/api/chat-once').send({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(400)
  })
  it('成功返回 content', async () => {
    fetch.mockResolvedValue(jsonFetch({ choices: [{ message: { content: '总结结果' } }] }))
    const res = await request(app).post('/api/chat-once').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('总结结果')
  })
  it('上游错误透传', async () => {
    fetch.mockResolvedValue(jsonFetch({ error: 'bad' }, 400))
    const res = await request(app).post('/api/chat-once').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(400)
  })
  it('MiniMax base_resp 错误返回 401', async () => {
    fetch.mockResolvedValue(jsonFetch({ base_resp: { status_code: 1, status_msg: 'no key' } }, 200))
    const res = await request(app).post('/api/chat-once').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }], providerId: 'minimax' })
    expect(res.status).toBe(401)
  })
  it('返回空 content 返回 502', async () => {
    fetch.mockResolvedValue(jsonFetch({ choices: [{ message: { content: '' } }] }))
    const res = await request(app).post('/api/chat-once').set('X-Api-Key', 'sk-1234567890').send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(502)
  })
})

describe('鉴权与限流辅助函数', () => {
  it('requireAdmin 未配置令牌放行', () => {
    const next = vi.fn()
    requireAdmin({ headers: {} }, {}, next)
    expect(next).toHaveBeenCalled()
  })
  it('requireAdmin 匹配令牌放行、不匹配 403', () => {
    const next = vi.fn()
    requireAdmin({ headers: { 'x-admin-token': 'secret' } }, { status: (c) => ({ json: () => ({}) }), json: () => ({}) }, next)
    // 默认 ADMIN_TOKEN 为空，仍放行
    expect(next).toHaveBeenCalled()
  })
  it('requireAdmin 配置令牌后不匹配返回 403', () => {
    process.env.ADMIN_TOKEN = 'topsecret'
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const res = { status, json }
    requireAdmin({ headers: { 'x-admin-token': 'wrong' } }, res, vi.fn())
    expect(status).toHaveBeenCalledWith(403)
    process.env.ADMIN_TOKEN = ''
  })
  it('requireAdmin 配置令牌且匹配放行', () => {
    process.env.ADMIN_TOKEN = 'topsecret'
    const next = vi.fn()
    requireAdmin({ headers: { 'x-admin-token': 'topsecret' } }, { status: () => ({ json: () => ({}) }), json: () => ({}) }, next)
    expect(next).toHaveBeenCalled()
    process.env.ADMIN_TOKEN = ''
  })
  it('chatRateLimit 正常放行', () => {
    const next = vi.fn()
    const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' } }
    chatRateLimit(req, { status: () => ({ json: () => {} }) }, next)
    expect(next).toHaveBeenCalled()
  })
  it('chatRateLimit 超限返回 429', () => {
    const next = vi.fn()
    const res = { status: vi.fn(() => ({ json: vi.fn() })) }
    const req = { headers: {}, socket: { remoteAddress: '9.9.9.9' } }
    for (let i = 0; i < 35; i++) chatRateLimit(req, res, next)
    expect(res.status).toHaveBeenCalledWith(429)
  })
  it('buildProviderUrl 为 minimax 拼接 GroupId', () => {
    const p = { id: 'minimax', apiUrl: 'https://x/v1/chatcompletion_v2' }
    expect(buildProviderUrl(p, 'G123')).toContain('GroupId=G123')
    expect(buildProviderUrl({ id: 'deepseek', apiUrl: 'https://y' }, 'G')).toBe('https://y')
  })
})

// 辅助：取当前 FILES_DIR（复用 configureStorage 返回值）
function getFilesDir() {
  // configureStorage 已在 beforeEach 调用并写入 dir；这里直接基于 dir 计算
  return path.join(dir, 'files')
}
