import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 每次测试重置模块状态（backendAvailable / dbPromise 为模块级单例），避免串扰。
// 注意：不删除 fake-indexeddb 数据库（残留连接会导致 deleteDatabase 卡死、后续事务超时），
// 改用「唯一 id + 相对断言」避免数据残留干扰。
let uid = 0
const nextId = () => `d${++uid}`

async function freshDocStore() {
  vi.resetModules()
  return import('./docStore')
}

function mkDoc(over: Record<string, unknown> = {}) {
  return {
    id: nextId(),
    name: '测试文档.docx',
    type: 'word',
    status: 'pending',
    summary: '',
    keywords: [],
    content: [{ title: '章节', paragraphs: ['正文内容'] }],
    chunks: 1,
    tableSummaries: {},
    summaryChunks: [],
    ...over,
  } as any
}

describe('docStore', () => {
  beforeEach(() => {
    // 默认后端不可达（fetch reject），让所有写操作走本地 IndexedDB 路径
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('restoreDocsFromRecords（纯函数）', () => {
    it('过滤无 id / 空 doc 记录', async () => {
      const { restoreDocsFromRecords } = await freshDocStore()
      const good = mkDoc()
      const out = restoreDocsFromRecords([null as any, { id: 'x', doc: {} as any }, { id: good.id, doc: good }])
      expect(out.length).toBe(1)
      expect(out[0].id).toBe(good.id)
    })
    it('规整缺失字段为安全默认值', async () => {
      const { restoreDocsFromRecords } = await freshDocStore()
      const bad = { id: 'b', name: 'x', type: 'unknown', status: 'weird', summary: 123, keywords: 'not-array', content: null } as any
      const [doc] = restoreDocsFromRecords([{ id: 'b', doc: bad }])
      expect(doc.summary).toBe('')
      expect(doc.keywords).toEqual([])
      expect(doc.content).toEqual([])
      expect(doc.type).toBe('pdf')
      expect(doc.status).toBe('pending')
    })
    it('有 blob 时 PDF 走本地 blob URL', async () => {
      const { restoreDocsFromRecords } = await freshDocStore()
      const blob = new Blob(['x'])
      const [doc] = restoreDocsFromRecords([{ id: 'p', doc: mkDoc({ type: 'pdf', id: 'p' }), blob }])
      expect(doc.pdfUrl).toBe('blob:mock')
      expect(doc.fileUrl).toBeUndefined()
    })
    it('无 blob 时用后端文件 URL', async () => {
      const { restoreDocsFromRecords } = await freshDocStore()
      const [doc] = restoreDocsFromRecords([{ id: 'p', doc: mkDoc({ type: 'pdf', id: 'p' }) }])
      expect(doc.pdfUrl).toContain('/api/docs/p/file')
    })
    it('非 PDF 文档生成 fileUrl', async () => {
      const { restoreDocsFromRecords } = await freshDocStore()
      const [doc] = restoreDocsFromRecords([{ id: 'w', doc: mkDoc({ type: 'word', id: 'w' }) }])
      expect(doc.fileUrl).toBeTruthy()
      expect(doc.pdfUrl).toBeUndefined()
    })
  })

  describe('保存与读取（本地 IndexedDB）', () => {
    it('saveUploadedDoc 后 getAllDocs 能读到（后端不可达仅本地）', async () => {
      const { saveUploadedDoc, getAllDocs } = await freshDocStore()
      const doc = mkDoc()
      await saveUploadedDoc(doc, new Blob(['file-content']))
      const all = await getAllDocs()
      const rec = all.find(r => r.id === doc.id)
      expect(rec).toBeTruthy()
      expect(rec!.blob).toBeTruthy()
    })
    it('IndexedDB 瘦身：剥离正文/内容/切片，保留元数据与 blob', async () => {
      const { saveUploadedDoc, getAllDocs } = await freshDocStore()
      const doc = mkDoc({ textContent: '超长正文', content: [{ title: 't', paragraphs: ['p'] }], summaryChunks: [{ sheetKey: 'x', label: 'l', text: 's' }] })
      await saveUploadedDoc(doc, new Blob(['b']))
      const all = await getAllDocs()
      const rec = all.find(r => r.id === doc.id)!
      expect((rec.doc as any).textContent).toBeUndefined()
      expect((rec.doc as any).content).toBeUndefined()
      expect((rec.doc as any).summaryChunks).toBeUndefined()
      expect(rec.doc.name).toBe('测试文档.docx')
    })
    it('saveMeta 保留已有 blob', async () => {
      const { saveUploadedDoc, saveMeta, getAllDocs } = await freshDocStore()
      const doc = mkDoc()
      await saveUploadedDoc(doc, new Blob(['orig']))
      await saveMeta({ ...doc, name: '改名.docx' })
      const all = await getAllDocs()
      const rec = all.find(r => r.id === doc.id)!
      expect(rec.doc.name).toBe('改名.docx')
      expect(rec.blob).toBeTruthy()
    })
    it('removeDoc 删除本地记录', async () => {
      const { saveUploadedDoc, removeDoc, getAllDocs } = await freshDocStore()
      const doc = mkDoc()
      await saveUploadedDoc(doc, new Blob(['b']))
      await removeDoc(doc.id)
      const all = await getAllDocs()
      expect(all.find(r => r.id === doc.id)).toBeUndefined()
    })
  })

  describe('saveTableSummary', () => {
    it('生成总结并切片、合并同 sheetKey 旧切片', async () => {
      const { saveTableSummary, getAllDocs } = await freshDocStore()
      const doc = mkDoc({ content: [{ title: 't', paragraphs: ['p'] }] })
      await saveTableSummary(doc, '__doc__', '总结文本'.repeat(200))
      const r1 = await saveTableSummary(doc, '__doc__', '总结文本'.repeat(200))
      expect(Object.keys(r1.tableSummaries)).toEqual(['__doc__'])
      const all = await getAllDocs()
      const rec = all.find(r => r.id === doc.id)!
      const chunks = rec.doc.summaryChunks || []
      expect(chunks.every(c => c.sheetKey === '__doc__')).toBe(true)
      expect(rec.doc.tableSummaries['__doc__'].text).toContain('总结文本')
      expect(rec.doc.tableSummaries['__doc__'].contentHash).toBeTruthy()
    })

    it('后端同步失败时（POST 被拒）仍成功返回 tableSummaries，不中断本地保存', async () => {
      // 浏览器环境（LAN IP / 代理）：本地 IndexedDB 写入成功，但 postToBackend 同步后端被拒（如 409/413/500）。
      // 修复前 saveMeta 抛错会让 saveTableSummary 整体失败，导致调用方 updateDoc/setSummarySaved/recordLog 全部跳过；
      // 修复后本地保存即成功，仅告警不抛错。
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (String(url).includes('/api/health')) return Promise.resolve({ ok: true } as Response)
        // POST /api/docs 被后端明确拒绝（非 2xx）
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: '该文档已被删除，无法更新（请刷新页面）' }) } as unknown as Response)
      }))
      const { saveTableSummary } = await freshDocStore()
      const doc = mkDoc({ content: [{ title: 't', paragraphs: ['p'] }] })
      // 不应 reject（修复后本地保存成功即返回）
      const r = await saveTableSummary(doc, '__doc__', '总结文本'.repeat(50))
      expect(r.tableSummaries['__doc__'].text).toContain('总结文本')
    })
  })

  describe('操作日志', () => {
    it('后端不可达时静默返回，不报错', async () => {
      const { appendDocLog } = await freshDocStore()
      await expect(appendDocLog({ action: 'upload', operator: 'u' })).resolves.toBeUndefined()
    })
    it('后端可达但写入失败时上报错误', async () => {
      // health ok，但 doc-logs POST 失败
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (String(url).includes('/api/health')) return Promise.resolve({ ok: true } as Response)
        return Promise.reject(new Error('write fail'))
      }))
      // 先 resetModules 加载 docStore，再取同一模块缓存的 errorReporter 实例
      const { appendDocLog } = await freshDocStore()
      const { subscribeErrors } = await import('./errorReporter')
      const listener = vi.fn()
      const unsub = subscribeErrors(listener)
      await appendDocLog({ action: 'upload', operator: 'u' })
      expect(listener).toHaveBeenCalled()
      expect(listener.mock.calls[0][0].msg).toContain('操作日志写入失败')
      unsub()
    })
    it('getDocLogs 后端不可达返回空数组', async () => {
      const { getDocLogs } = await freshDocStore()
      expect(await getDocLogs()).toEqual([])
    })
  })
})
