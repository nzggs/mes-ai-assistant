// @vitest-environment node
// 总结入口的准入校验：未入库（未审核通过）/ 已删除文档不得发起总结。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import request from 'supertest'
import { app, configureStorage, resetStorageCache } from './index.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-summary-guard-'))
  configureStorage({ dataDir: dir })
  resetStorageCache()
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// vitest 会加载根目录 .env，ADMIN_TOKEN 可能已设置；带令牌以兼容两种情况
const ADMIN = process.env.ADMIN_TOKEN || ''

async function createDoc(id, status) {
  const res = await request(app)
    .post('/api/docs')
    .set('X-Admin-Token', ADMIN)
    .send({ id, doc: { id, name: 't.pdf', type: 'pdf', status, textContent: 'hello world '.repeat(50) } })
  expect(res.status).toBe(200)
}

const startSummary = (docId) => request(app)
  .post('/api/summary/start')
  .set('X-Api-Key', '1234567890abcdef')
  .send({ docId, providerId: 'deepseek' })

describe('POST /api/summary/start 准入校验', () => {
  it('未入库（pending）文档禁止总结', async () => {
    await createDoc('upload-pending-1', 'pending')
    const res = await startSummary('upload-pending-1')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('尚未入库')
  })

  it('被驳回（rejected）文档也禁止总结', async () => {
    await createDoc('upload-rejected-1', 'rejected')
    const res = await startSummary('upload-rejected-1')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('尚未入库')
  })

  it('已删除文档（墓碑）提示文档不存在', async () => {
    await createDoc('upload-deleted-1', 'approved')
    const del = await request(app).delete('/api/docs/upload-deleted-1').set('X-Admin-Token', ADMIN)
    expect(del.status).toBe(200)
    const res = await startSummary('upload-deleted-1')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('文档不存在')
  })
})
