// @vitest-environment node
// server/docIndexRoute.test.js —— 知识库文档台账（/api/documents）单测
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureStorage, resetStorageCache, setDocInCache, readDocs } from './storage.js'
import { upsertDocument } from './searchIndex.js'
import { listDocuments, registerDocIndexRoutes } from './docIndexRoute.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-docidx-'))
  configureStorage({ dataDir: dir })
  resetStorageCache()
})

afterAll(() => {
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** 造一批覆盖各状态的文档：2 approved + 1 pending + 1 rejected + 2 墓碑 */
function seedDocs() {
  readDocs() // 关键：强制 ensureDocsCache 先按空磁盘建缓存，否则后面 setDocInCache 的数据会被磁盘加载覆盖
  const recs = [
    { id: 'd-xml-1', doc: { id: 'd-xml-1', name: 'Z_LOGIC_202609101240.xml', type: 'xml', status: 'approved', pages: 2035, content: [] } },
    { id: 'd-pdf-1', doc: { id: 'd-pdf-1', name: 'SAP HANA数据库SQL参考手册.pdf', type: 'pdf', status: 'approved', pages: 228, textContent: 'x'.repeat(100) } },
    { id: 'd-xml-2', doc: { id: 'd-xml-2', name: 'Z_QUEUE_202609101238.xml', type: 'xml', status: 'pending', pages: 54 } },
    { id: 'd-doc-1', doc: { id: 'd-doc-1', name: '作业指导书.docx', type: 'word', status: 'rejected', pages: 12 } },
    { id: 'dead-1', doc: { id: 'dead-1', name: '已删除', deleted: true } },           // 墓碑（无 status，与线上形态一致）
    { id: 'dead-2', doc: { id: 'dead-2', name: '已删除', deleted: true } },           // 显式墓碑
  ]
  for (const r of recs) setDocInCache(r.id, r)
  return recs
}

describe('listDocuments：计数与墓碑过滤', () => {
  beforeEach(seedDocs)

  it('counts 三态正确且不计入墓碑（total=4 而非 6）', () => {
    const r = listDocuments({})
    expect(r.counts).toEqual({ total: 4, approved: 2, pending: 1, rejected: 1 })
    expect(r.total).toBe(4)
    expect(r.items.map(i => i.id).sort()).toEqual(['d-doc-1', 'd-pdf-1', 'd-xml-1', 'd-xml-2'])
  })

  it('deleted:true 的记录绝不出现', () => {
    const r = listDocuments({})
    expect(r.items.some(i => i.id === 'dead-2')).toBe(false)
  })

  it('status 缺省归一化为 pending', () => {
    // 正常记录但缺 status 字段（非墓碑）→ 必须按 pending 处理
    setDocInCache('d-nostat', { id: 'd-nostat', doc: { id: 'd-nostat', name: '无状态.docx', type: 'word' } })
    const r = listDocuments({})
    expect(r.items.find(i => i.id === 'd-nostat').status).toBe('pending')
    expect(r.counts.pending).toBe(2) // d-xml-2 + d-nostat
  })

  it('返回项绝不携带正文重字段', () => {
    const r = listDocuments({})
    for (const it of r.items) {
      expect(it).not.toHaveProperty('textContent')
      expect(it).not.toHaveProperty('content')
      expect(it).not.toHaveProperty('summaryChunks')
      expect(it).not.toHaveProperty('fileUrl')
      expect(it).not.toHaveProperty('pdfUrl')
    }
  })

  it('status / q / limit 过滤生效', () => {
    expect(listDocuments({ status: 'approved' }).total).toBe(2)
    expect(listDocuments({ status: 'pending' }).items.map(i => i.id)).toEqual(['d-xml-2'])
    expect(listDocuments({ q: 'hana' }).items.map(i => i.id)).toEqual(['d-pdf-1'])
    expect(listDocuments({ limit: 1 }).items).toHaveLength(1)
  })
})

describe('listDocuments：与倒排索引侧字段合并', () => {
  it('未入索引的文档 indexed=false / indexedPages=0；入索引后为真值', () => {
    seedDocs()
    const before = listDocuments({}).items.find(i => i.id === 'd-xml-1')
    expect(before.indexed).toBe(false)
    expect(before.indexedPages).toBe(0)
    // 真实走一次 upsertDocument（与生产同路径），content 两页
    upsertDocument('d-xml-1', {
      id: 'd-xml-1', name: 'Z_LOGIC_202609101240.xml', status: 'approved',
      content: [{ title: 'p1', text: 'a b c' }, { title: 'p2', text: 'd e f' }],
    })
    const after = listDocuments({}).items.find(i => i.id === 'd-xml-1')
    expect(after.indexed).toBe(true)
    expect(after.indexedPages).toBe(2)
  })
})

describe('GET /api/documents 路由', () => {
  it('返回台账且支持 status 过滤', async () => {
    seedDocs()
    const app = express()
    registerDocIndexRoutes(app)
    const all = await request(app).get('/api/documents')
    expect(all.status).toBe(200)
    expect(all.body.counts.approved).toBe(2)
    expect(all.body.total).toBe(4)

    const approved = await request(app).get('/api/documents?status=approved')
    expect(approved.body.total).toBe(2)
    expect(approved.body.items.every(i => i.status === 'approved')).toBe(true)
  })

  it('limit 越界值被夹逼，异常参数不 500', async () => {
    seedDocs()
    const app = express()
    registerDocIndexRoutes(app)
    const r1 = await request(app).get('/api/documents?limit=99999')
    expect(r1.status).toBe(200)
    expect(r1.body.items.length).toBeLessThanOrEqual(500)
    const r2 = await request(app).get('/api/documents?limit=abc')
    expect(r2.status).toBe(200)
  })
})
