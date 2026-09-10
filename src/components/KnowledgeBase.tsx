import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { PdfViewer } from './PdfViewer'
import { processUploadedDoc, reextractDocMetadata, summarizeDocumentScope, FULL_DOC_SUMMARY_KEY } from '../services/knowledgeService'
import { getApiKey, getProviderId, resolveModelId, getGroupId } from '../services/llmApi'
import { saveTableSummary, appendDocLog, getDocLogs, saveUploadedDoc, saveMeta, removeDoc, syncDocNow, fetchAllDocPages } from '../services/docStore'
import { canReviewDoc, type User } from '../services/userService'
import type { KnowledgeDoc, DocPage, DocLog } from '../types'
import * as XLSX from 'xlsx'
import { renderAsync as renderDocx } from 'docx-preview'
import { extractExcelImages } from '../services/officeMedia'
import { reportError } from '../services/errorReporter'

const docTypeConfig = {
  word: { label: 'Word', icon: '📄', color: '#2563eb', bg: '#eff6ff' },
  ppt: { label: 'PPT', icon: '📊', color: '#ea580c', bg: '#fff7ed' },
  excel: { label: 'Excel', icon: '📈', color: '#16a34a', bg: '#f0fdf4' },
  pdf: { label: 'PDF', icon: '📕', color: '#dc2626', bg: '#fef2f2' },
  xml: { label: 'XML', icon: '🗂️', color: '#7c3aed', bg: '#f5f3ff' },
}

const statusConfig = {
  pending: { label: '待审核', color: '#f59e0b', bg: '#fffbeb' },
  approved: { label: '已入库', color: '#16a34a', bg: '#f0fdf4' },
  rejected: { label: '已拒绝', color: '#ef4444', bg: '#fef2f2' },
}

// 根据文件扩展名判断类型
function getFileType(filename: string): 'word' | 'ppt' | 'excel' | 'pdf' | 'xml' | null {
  const ext = filename.toLowerCase().split('.').pop()
  if (ext === 'doc' || ext === 'docx') return 'word'
  if (ext === 'ppt' || ext === 'pptx') return 'ppt'
  if (ext === 'xls' || ext === 'xlsx') return 'excel'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'xml') return 'xml'
  return null
}

// 格式化文件大小
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// 格式化日期
function formatDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 格式化日志时间（ISO → 本地 YYYY-MM-DD HH:MM:SS）
function formatLogTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 日志操作类型配色
function logActionStyle(action: string): string {
  switch (action) {
    case 'upload': return 'bg-blue-50 text-blue-600'
    case 'delete': return 'bg-red-50 text-red-600'
    case 'approve': return 'bg-green-50 text-green-600'
    case 'reject': return 'bg-orange-50 text-orange-600'
    case 'summary': return 'bg-purple-50 text-purple-600'
    default: return 'bg-gray-100 text-gray-600'
  }
}

const LOG_ACTION_LABEL: Record<string, string> = {
  upload: '上传',
  delete: '删除',
  approve: '审核通过',
  reject: '审核拒绝',
  summary: '总结',
}

interface KnowledgeBaseProps {
  documents: KnowledgeDoc[]
  currentUser: User | null
  onDocumentsChange: (updater: (prev: KnowledgeDoc[]) => KnowledgeDoc[]) => void
  onRequireLogin?: () => void
}

export function KnowledgeBase({ documents, currentUser, onDocumentsChange, onRequireLogin }: KnowledgeBaseProps) {
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null)
  const [readerDoc, setReaderDoc] = useState<KnowledgeDoc | null>(null)
  const [originalDoc, setOriginalDoc] = useState<KnowledgeDoc | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterDepartment, setFilterDepartment] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<KnowledgeDoc | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 整表/整文档总结（map-reduce）状态
  const [summaryDoc, setSummaryDoc] = useState<KnowledgeDoc | null>(null)
  const [summaryScope, setSummaryScope] = useState<string | undefined>(undefined)
  const [summaryRunning, setSummaryRunning] = useState(false)
  const [summaryStage, setSummaryStage] = useState<'map' | 'reduce' | 'done' | null>(null)
  const [summaryProgress, setSummaryProgress] = useState({ done: 0, total: 0, elapsedMs: 0, etaMs: undefined as number | undefined })
  const [summaryText, setSummaryText] = useState('')
  const [summaryError, setSummaryError] = useState('')
  const [summarySaved, setSummarySaved] = useState(false)
  // 后台总结任务（断点续跑）：docTasks 记录 docId->taskId（关闭/刷新前端仍在后端继续）；
  // liveTasks 记录 taskId->实时视图（用于弹窗与列表进度展示）；activeTask 为当前打开弹窗订阅的任务。
  const [docTasks, setDocTasks] = useState<Record<string, string>>({})
  const [liveTasks, setLiveTasks] = useState<Record<string, any>>({})
  const [activeTask, setActiveTask] = useState<{ doc: KnowledgeDoc; scope?: string; taskId: string } | null>(null)
  const doneHandledRef = useRef<Set<string>>(new Set())
  // 知识库列表分页（仅影响列表渲染，不影响检索所用的 documents 全集）
  const DOC_PAGE_SIZE = 50
  const [docPage, setDocPage] = useState(1)

  // 操作日志弹窗
  const [showLogModal, setShowLogModal] = useState(false)

  // 更新单个文档
  const updateDoc = useCallback((id: string, updates: Partial<KnowledgeDoc>) => {
    onDocumentsChange(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d))
    setSelectedDoc(prev => prev?.id === id ? { ...prev, ...updates } : prev)
  }, [onDocumentsChange])

  // ===== 超大文档的按需补全（第二期） =====
  // 服务端对页数/体积超阈值的文档（XML 数据导出常达数千条记录、数十 MB）不会随列表下发正文，
  // 只返回 contentOmitted 标记。列表、卡片、搜索等轻量场景无需正文；
  // 只有用户真正打开「详情 / 原文阅读」时才按需取回，避免新浏览器一次同步就拉取几十 MB。
  const deferredLoading = useRef<Set<string>>(new Set())
  const ensureDocContent = useCallback(async (doc: KnowledgeDoc) => {
    if (!doc.contentOmitted || (doc.content && doc.content.length > 0)) return
    if (deferredLoading.current.has(doc.id)) return
    deferredLoading.current.add(doc.id)
    try {
      const pages = await fetchAllDocPages(doc.id)
      if (pages.length === 0) return
      const patch = (d: KnowledgeDoc | null) =>
        d && d.id === doc.id ? { ...d, content: pages, contentOmitted: false } : d
      onDocumentsChange(prev => prev.map(d => (d.id === doc.id ? { ...d, content: pages, contentOmitted: false } : d)))
      setSelectedDoc(prev => patch(prev))
      setReaderDoc(prev => patch(prev))
    } catch (e) {
      console.warn('超大文档正文按需加载失败:', e)
    } finally {
      deferredLoading.current.delete(doc.id)
    }
  }, [onDocumentsChange])

  useEffect(() => { if (selectedDoc) ensureDocContent(selectedDoc) }, [selectedDoc?.id, ensureDocContent])
  useEffect(() => { if (readerDoc) ensureDocContent(readerDoc) }, [readerDoc?.id, ensureDocContent])

  // 记录知识库操作日志（上传/删除/审核/总结 的人员与时间），后端共享、静默失败
  const recordLog = useCallback((
    action: DocLog['action'],
    target: string,
    detail?: string,
  ) => {
    if (!currentUser) return
    appendDocLog({
      action,
      operator: currentUser.username,
      operatorName: currentUser.displayName,
      department: currentUser.department,
      target,
      detail,
    })
  }, [currentUser])

  // 发起/订阅后台总结任务：任务在后端运行，关闭窗口/刷新浏览器后仍继续，可断点续跑
  const runSummary = useCallback(async (doc: KnowledgeDoc, sheetName?: string) => {
    const apiKey = getApiKey()
    if (!apiKey) {
      setSummaryDoc(doc)
      setSummaryScope(sheetName)
      setSummaryError('请先在设置中配置 API Key 后再进行总结')
      return
    }
    // 未入库（未审核通过）的文档禁止总结：其正文与总结切片都不进问答检索，生成无意义
    if (doc.status !== 'approved') {
      setSummaryDoc(doc)
      setSummaryScope(sheetName)
      setSummaryError('该文档尚未入库，请先点击「确认入库」后再进行总结。')
      return
    }
    // 若该文档已有活动任务，直接打开弹窗订阅，不重复发起
    if (docTasks[doc.id]) {
      setActiveTask({ doc, scope: sheetName, taskId: docTasks[doc.id] })
      setSummaryDoc(doc)
      setSummaryScope(sheetName)
      return
    }
    const payload = {
      docId: doc.id,
      sheetName: sheetName || null,
      providerId: getProviderId(),
      modelId: resolveModelId(),
      groupId: getGroupId(),
    }
    const startOnce = () => fetch('/api/summary/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify(payload),
    })

    try {
      let res = await startOnce()
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let errMsg = ''
        try { errMsg = (JSON.parse(text) as any)?.error || '' } catch { /* 非 JSON 响应 */ }
        // 后端查不到该文档分片（上传时后端同步失败/未完成时会出现）→ 先补传文档再重试一次，
        // 避免用户必须重新上传才能总结
        if (res.status === 400 && errMsg.includes('文档不存在')) {
          try {
            await syncDocNow(doc)
            res = await startOnce()
            if (res.ok) {
              const retried = await res.json()
              setDocTasks(prev => ({ ...prev, [doc.id]: retried.id }))
              setActiveTask({ doc, scope: sheetName, taskId: retried.id })
              setSummaryDoc(doc)
              setSummaryScope(sheetName)
              setSummaryText('')
              setSummaryError('')
              setSummarySaved(false)
              return
            }
            const text2 = await res.text().catch(() => '')
            try { errMsg = (JSON.parse(text2) as any)?.error || '发起总结失败' } catch { errMsg = '发起总结失败' }
          } catch (e: any) {
            errMsg = `文档尚未同步到服务器，自动补传失败：${e?.message || e}（请刷新页面后重试）`
          }
        }
        setSummaryDoc(doc)
        setSummaryScope(sheetName)
        setSummaryError(errMsg || '发起总结失败')
        return
      }
      const task = await res.json()
      setDocTasks(prev => ({ ...prev, [doc.id]: task.id }))
      setActiveTask({ doc, scope: sheetName, taskId: task.id })
      setSummaryDoc(doc)
      setSummaryScope(sheetName)
      setSummaryText('')
      setSummaryError('')
      setSummarySaved(false)
    } catch (e: any) {
      setSummaryDoc(doc)
      setSummaryScope(sheetName)
      setSummaryError('发起总结失败：' + (e?.message || String(e)))
    }
  }, [docTasks])

  // 取消某文档的后台总结任务（仅从列表取消按钮或弹窗外触发；关闭弹窗不取消）
  const cancelSummary = useCallback((docId: string) => {
    const taskId = docTasks[docId]
    if (!taskId) return
    fetch('/api/summary/' + taskId + '/cancel', { method: 'POST' }).catch(() => {})
    doneHandledRef.current.add(taskId)
    setDocTasks(prev => { const n = { ...prev }; delete n[docId]; return n })
    if (activeTask?.taskId === taskId) { setActiveTask(null); setSummaryDoc(null) }
  }, [docTasks, activeTask])

  // 全局轮询：跟踪所有活动任务（弹窗开/关都持续更新，列表可查看进度）；完成后刷新本地文档使对应标签页自动打勾
  useEffect(() => {
    const ids = Object.values(docTasks)
    if (ids.length === 0) return
    let cancelled = false
    const tick = async () => {
      const entries = await Promise.all(ids.map(async (id) => {
        try {
          const r = await fetch('/api/summary/' + id)
          if (r.ok) return [id, await r.json()] as const
        } catch { /* 忽略瞬时错误 */ }
        return null
      }))
      if (cancelled) return
      const next: Record<string, any> = {}
      for (const e of entries) if (e) next[e[0]] = e[1]
      setLiveTasks(prev => ({ ...prev, ...next }))
      for (const e of entries) {
        if (!e) continue
        const t = e[1] as any
        if ((t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') && !doneHandledRef.current.has(t.id)) {
          doneHandledRef.current.add(t.id)
          const docId = t.docId
          const scope = t.sheetName || undefined
          const docName = documents.find(d => d.id === docId)?.name || docId
          if (t.status === 'done') {
            try {
              const r = await fetch('/api/docs/' + docId)
              if (r.ok) {
                const fresh = await r.json()
                // GET /api/docs/:id 返回 { id, doc }，真实字段在 fresh.doc 下
                const fd = fresh.doc || fresh
                updateDoc(docId, { tableSummaries: fd.tableSummaries, summaryChunks: fd.summaryChunks, chunks: fd.chunks })
                // 仅在文档确实刷新成功时才记「已总结」日志，避免文档已删除时记幽灵日志
                recordLog('summary', scope ? `${docName} · ${scope}` : docName)
              }
            } catch { /* 忽略刷新失败，下次进入仍可见 */ }
          }
          setDocTasks(prev => { const n = { ...prev }; delete n[docId]; return n })
          // 终态后清理 liveTasks 中该任务的实时视图，避免内存只增不删
          setLiveTasks(prev => { if (!prev[t.id]) return prev; const n = { ...prev }; delete n[t.id]; return n })
        }
      }
    }
    tick()
    const iv = setInterval(tick, 1500)
    return () => { cancelled = true; clearInterval(iv) }
  }, [docTasks, documents, updateDoc, recordLog])

  // 启动时重新认领后端仍在运行/排队的总结任务：关闭窗口或刷新浏览器后，
  // 这些任务在后端继续跑，重新订阅后才能在完成后让对应标签页自动打勾。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/summary/list')
        if (!r.ok) return
        const data = await r.json()
        const tasks = Array.isArray(data?.tasks) ? data.tasks : []
        const map: Record<string, string> = {}
        for (const t of tasks) {
          if (!t || !t.id || !t.docId) continue
          if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') continue
          if (doneHandledRef.current.has(t.id)) continue
          map[t.docId] = t.id
        }
        if (!cancelled && Object.keys(map).length) setDocTasks(prev => ({ ...prev, ...map }))
      } catch { /* 忽略：下次发起或轮询时自然恢复 */ }
    })()
    return () => { cancelled = true }
  }, [])

  // 把当前弹窗订阅的任务实时状态同步给 SummaryModal 的展示 props
  useEffect(() => {
    if (!activeTask) return
    const t = liveTasks[activeTask.taskId]
    if (!t) return
    setSummaryRunning(t.status === 'running' || t.status === 'pending')
    setSummaryStage(t.stage || 'map')
    setSummaryProgress({ done: t.done || 0, total: t.total || 0, elapsedMs: t.startedAt ? Date.now() - t.startedAt : 0, etaMs: undefined })
    setSummaryText(t.status === 'done' ? (t.result || '') : (t.partial || ''))
    setSummarySaved(t.status === 'done')
    setSummaryError(t.status === 'failed' || t.status === 'cancelled' ? (t.error || (t.status === 'cancelled' ? '已取消' : '总结失败')) : '')
  }, [activeTask, liveTasks])

  // 重新归纳：复用已存储文本，重新提取元数据并落库
  const handleReextract = useCallback(async (doc: KnowledgeDoc) => {
    await reextractDocMetadata(doc, (updates) => {
      updateDoc(doc.id, updates)
      const updated = { ...doc, ...updates }
      saveMeta(updated).catch(err => console.error('重新归纳后同步元数据到 IndexedDB 失败', doc.name, err))
    })
  }, [updateDoc])

  // 处理上传文件
  const handleFiles = useCallback(async (files: FileList | null) => {
    try {
    if (!currentUser) {
      setUploadStatus('请先登录后再上传文档')
      setTimeout(() => setUploadStatus(''), 4000)
      return
    }
    if (!files || files.length === 0) return

    // 单次上传数量上限：最多 20 份，超出则整体拒绝（全不上传）并报错
    if (files.length > 20) {
      setUploadStatus('上传失败：单次最多上传 20 份文档，请减少选择数量后再试')
      setTimeout(() => setUploadStatus(''), 5000)
      return
    }

    const newDocs: KnowledgeDoc[] = []
    let rejectedCount = 0
    let duplicateCount = 0
    let overLimitCount = 0

    // 上传限制：单文件 50MB（XML 数据导出可到 60MB，需容纳 base64 膨胀后的请求体），文件名 ≤120 字符
    const MAX_FILE_SIZE = 50 * 1024 * 1024
    const MAX_XML_FILE_SIZE = 60 * 1024 * 1024
    const MAX_FILENAME_LEN = 120

    for (const file of Array.from(files)) {
      const fileType = getFileType(file.name)
      if (!fileType) {
        rejectedCount++
        continue
      }

      // 大小/文件名超限拒绝
      const sizeLimit = fileType === 'xml' ? MAX_XML_FILE_SIZE : MAX_FILE_SIZE
      if (file.size > sizeLimit || file.name.length > MAX_FILENAME_LEN) {
        overLimitCount++
        continue
      }

      // 自动去重：与已有文档或本批次已接受的文件同名时拒绝上传
      const isDuplicate = documents.some(d => d.name === file.name) ||
        newDocs.some(d => d.name === file.name)
      if (isDuplicate) {
        duplicateCount++
        continue
      }

      // 为所有文件创建 Object URL（PDF 用 pdfUrl，其他用 fileUrl）
      const objectUrl = URL.createObjectURL(file)
      const pdfUrl = fileType === 'pdf' ? objectUrl : undefined
      const fileUrl = fileType !== 'pdf' ? objectUrl : undefined

      // 获取详细扩展名
      const ext = file.name.toLowerCase().split('.').pop() as 'docx' | 'doc' | 'pptx' | 'ppt' | 'xlsx' | 'xls' | 'pdf' | 'xml'

      // 创建文档初始内容（解析前占位）
      const emptyPages: DocPage[] = fileType !== 'pdf' ? [{
        pageNum: 1,
        title: file.name,
        paragraphs: ['文档正在解析中，请稍候...'],
      }] : []

      const newDoc: KnowledgeDoc = {
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        type: fileType,
        size: formatFileSize(file.size),
        uploadDate: formatDate(),
        uploader: currentUser?.username || '未登录用户',
        uploaderName: currentUser?.displayName || currentUser?.username || '',
        uploaderDepartment: currentUser?.department || '',
        status: 'pending',
        keywords: ['待提取'],
        background: '文档上传后，AI 将自动分析并提取背景信息',
        causeAnalysis: '待 AI 自动分析',
        solution: '待 AI 自动分析',
        summary: `已上传 ${formatFileSize(file.size)} 的 ${docTypeConfig[fileType].label} 文档，正在解析文件内容...`,
        chunks: Math.max(1, Math.ceil(file.size / 4096)),
        pages: 1,
        content: emptyPages,
        pdfUrl,
        fileUrl,
        fileType: ext,
        aiExtracting: false,
        aiExtracted: false,
      }
      newDocs.push(newDoc)
      // 记录上传日志（人员 + 时间，后端共享）
      recordLog('upload', newDoc.name)
      // 持久化到 IndexedDB（元数据 + 原始文件 Blob）；await 确保落盘完成，上传后立即刷新也能恢复
      await saveUploadedDoc(newDoc, file).catch(err => console.error('保存文档到 IndexedDB 失败', newDoc.name, err))
    }

    if (newDocs.length > 0) {
      onDocumentsChange(prev => [...newDocs, ...prev])
      const hasXml = newDocs.some(d => d.type === 'xml')
      setUploadStatus(`成功上传 ${newDocs.length} 个文件${rejectedCount > 0 ? `，${rejectedCount} 个不支持的文件已忽略` : ''}${overLimitCount > 0 ? `，${overLimitCount} 个文件超过大小上限或文件名过长被忽略` : ''}${duplicateCount > 0 ? `，${duplicateCount} 个文件因同名已存在被拒绝` : ''}，${hasXml ? '正在解析并入库（XML 数据导出不经过 AI 预处理）' : 'AI 正在自动归纳'}...`)
      setTimeout(() => setUploadStatus(''), 6000)

      // 有限并发触发 AI 提取：一次传太多时若全部同时打向 LLM，厂商限流/网络抖动会让请求挂起（AI解析中卡死）。
      // 这里最多 4 个并行，配合 callLLMNonStream 的 120s 超时，避免批量上传卡死。
      const MAX_CONCURRENT_EXTRACT = 4
      let cursor = 0
      // 额度/限流类错误时回滚本次上传：从知识库与本地移除该文档，避免残留不完整内容
      const rollbackUpload = (doc: KnowledgeDoc) => {
        onDocumentsChange(prev => prev.filter(d => d.id !== doc.id))
        if (doc.pdfUrl) URL.revokeObjectURL(doc.pdfUrl)
        if (doc.fileUrl) URL.revokeObjectURL(doc.fileUrl)
        if (doc.id.startsWith('upload-')) {
          removeDoc(doc.id).catch(err => console.error('回滚删除 IndexedDB 文档失败', err))
        }
        setSelectedDoc(prev => prev?.id === doc.id ? null : prev)
        setReaderDoc(prev => prev?.id === doc.id ? null : prev)
      }
      const worker = async () => {
        while (cursor < newDocs.length) {
          const doc = newDocs[cursor++]
          try {
            await processUploadedDoc(doc, (updates) => {
              // 在 state 更新器中基于最新文档同步 IndexedDB（含累积的 textContent，刷新后可被 AI 检索引用）
              onDocumentsChange(prev => {
                const next = prev.map(d => d.id === doc.id ? { ...d, ...updates } : d)
                const updated = next.find(d => d.id === doc.id)
                if (updated && doc.id.startsWith('upload-')) {
                  saveMeta(updated).catch(err => console.error('同步文档元数据到 IndexedDB 失败', updated.name, err))
                }
                return next
              })
              setSelectedDoc(prev => prev?.id === doc.id ? { ...prev, ...updates } : prev)
              setReaderDoc(prev => prev?.id === doc.id ? { ...prev, ...updates } : prev)
            })
          } catch (err: any) {
            // 额度/限流类错误：本次上传无法完成解析，回滚（从知识库与本地移除），避免残留不完整文档
            if (err?.quotaLimited) {
              reportError(`文档「${doc.name}」因模型使用量过大未能完成解析，已自动从知识库移除（请稍后再试或开启后付费）`)
              rollbackUpload(doc)
            } else {
              console.error('AI extraction failed for', doc.name, err)
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_EXTRACT, newDocs.length) }, worker))
    } else if (rejectedCount > 0) {
      setUploadStatus(`不支持的文件格式，请上传 Word、PPT、Excel、PDF 或 XML 文件`)
      setTimeout(() => setUploadStatus(''), 5000)
    } else if (duplicateCount > 0) {
      setUploadStatus(`上传失败：${duplicateCount} 个文件与已有文档重名（同名文档已存在）`)
      setTimeout(() => setUploadStatus(''), 5000)
    } else if (overLimitCount > 0) {
      setUploadStatus(`上传失败：${overLimitCount} 个文件超过 50MB 或文件名过长（最多 120 字符）`)
      setTimeout(() => setUploadStatus(''), 5000)
    }
    } catch (err: any) {
      const msg = (err && err.message) ? err.message : String(err)
      reportError(`批量上传处理异常：${msg}`)
    }
  }, [onDocumentsChange, currentUser, documents])

  // 拖拽事件处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (!currentUser) {
      setUploadStatus('请先登录后再上传文档')
      setTimeout(() => setUploadStatus(''), 4000)
      return
    }
    handleFiles(e.dataTransfer.files)
  }, [handleFiles, currentUser])

  // 点击选择文件
  const handleSelectFile = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files)
    // 重置 input 以便可以重复选择同一文件
    e.target.value = ''
  }, [handleFiles])

  const filteredDocs = useMemo(() => {
    let result = documents
    if (filterStatus !== 'all') result = result.filter(d => d.status === filterStatus)
    if (filterDepartment !== 'all') result = result.filter(d => (d.uploaderDepartment || '未知') === filterDepartment)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(d =>
        (d.name || '').toLowerCase().includes(q) ||
        (d.summary || '').toLowerCase().includes(q) ||
        (d.keywords || []).some(kw => (kw || '').toLowerCase().includes(q)) ||
        (d.content || []).some(page => (page?.paragraphs || []).some(p => (p || '').toLowerCase().includes(q)))
      )
    }
    // 按入库日期倒序（最新在前）；无入库日期的（待审核/已拒绝）排在后面，其内部按上传日期倒序
    return [...result].sort((a, b) => {
      const da = a.approvedDate || ''
      const db = b.approvedDate || ''
      if (da && db) return db.localeCompare(da)
      if (da && !db) return -1
      if (!da && db) return 1
      return b.uploadDate.localeCompare(a.uploadDate)
    })
  }, [documents, filterStatus, filterDepartment, searchQuery])

  // 筛选条件变化时回到第一页
  useEffect(() => { setDocPage(1) }, [filterStatus, filterDepartment, searchQuery])

  // 当前页要渲染的文档（在过滤+排序结果上切片；检索所用的 documents 全集不变）
  const pagedDocs = useMemo(() => {
    const start = (docPage - 1) * DOC_PAGE_SIZE
    return filteredDocs.slice(start, start + DOC_PAGE_SIZE)
  }, [filteredDocs, docPage, DOC_PAGE_SIZE])
  const docTotalPages = Math.max(1, Math.ceil(filteredDocs.length / DOC_PAGE_SIZE))

  // 部门筛选选项（从文档提取去重）
  const departmentOptions = useMemo(() => {
    const depts = new Set<string>()
    documents.forEach(d => {
      const dept = (d.uploaderDepartment || '未知').trim()
      if (dept) depts.add(dept)
    })
    return Array.from(depts).sort()
  }, [documents])

  const handleApprove = async (id: string) => {
    const today = formatDate()
    const current = documents.find(d => d.id === id)
    if (!current) return
    // 防并发覆盖：AI 提取完成前禁止审核（按钮已禁用，此处为双保险）
    if (current.aiExtracting) return
    try {
      // 先同步后端，后端拒绝（如文档已在其他浏览器被删除）时提示，不更新本地
      await saveMeta({ ...current, status: 'approved', approvedDate: today })
    } catch (err: any) {
      window.alert(`审核失败：${err?.message || '该文档可能已被删除，请刷新页面后重试'}`)
      return
    }
    recordLog('approve', current.name)
    onDocumentsChange(prev => prev.map(d => d.id === id ? { ...d, status: 'approved', approvedDate: today } : d))
    setSelectedDoc(prev => prev?.id === id ? { ...prev, status: 'approved', approvedDate: today } : prev)
  }

  const handleReject = async (id: string) => {
    const current = documents.find(d => d.id === id)
    if (!current) return
    if (current.aiExtracting) return
    try {
      await saveMeta({ ...current, status: 'rejected' })
    } catch (err: any) {
      window.alert(`驳回失败：${err?.message || '该文档可能已被删除，请刷新页面后重试'}`)
      return
    }
    recordLog('reject', current.name)
    // R3：驳回时清除残留的审核日期，避免已拒绝文档排到已入库之前造成视图误导
    onDocumentsChange(prev => prev.map(d => d.id === id ? { ...d, status: 'rejected', approvedDate: undefined } : d))
    setSelectedDoc(prev => prev?.id === id ? { ...prev, status: 'rejected', approvedDate: undefined } : prev)
  }

  const handleDelete = useCallback((id: string) => {
    // 删除前先记录日志（文档名 + 操作人 + 时间），删除后日志仍保留在后端
    const doc = documents.find(d => d.id === id)
    if (doc) recordLog('delete', doc.name)
    // 删除文档时取消该文档正在跑的总结任务：任务跑完会落库总结，
    // 若不取消会往已删除的分片写回内容（后端另有 deleted 复查兜底）
    if (docTasks[id]) cancelSummary(id)
    // 释放 Object URL 防止内存泄漏
    onDocumentsChange(prev => {
      const doc = prev.find(d => d.id === id)
      if (doc?.pdfUrl) URL.revokeObjectURL(doc.pdfUrl)
      if (doc?.fileUrl) URL.revokeObjectURL(doc.fileUrl)
      return prev.filter(d => d.id !== id)
    })
    // 删除 IndexedDB 中的持久化记录（仅用户上传文档）
    if (id.startsWith('upload-')) {
      removeDoc(id).catch(err => console.error('删除 IndexedDB 文档失败', err))
    }
    setSelectedDoc(prev => prev?.id === id ? null : prev)
    setReaderDoc(prev => prev?.id === id ? null : prev)
    setDeleteConfirm(null)
  }, [onDocumentsChange, documents, recordLog, docTasks, cancelSummary])

  // "阅读原文"：在应用内模态框打开上传的原始文档（PDF 原生预览 / Office 下载）
  // 无原始文件（如内置样例文档）时回退到文本阅读器
  const openOriginalDoc = (doc: KnowledgeDoc) => {
    const url = doc.pdfUrl || doc.fileUrl
    if (!url) {
      setReaderDoc(doc)
      return
    }
    setOriginalDoc(doc)
  }

  const stats = {
    total: documents.length,
    approved: documents.filter(d => d.status === 'approved').length,
    pending: documents.filter(d => d.status === 'pending').length,
    chunks: documents.reduce((sum, d) => sum + (d.chunks || 0), 0),
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* 页面标题 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-mes-text mb-1">知识库管理</h1>
            <p className="text-sm text-mes-textSecondary">
              文档投喂 · 自动归纳 · 原文阅读检索 · 管理员审核
            </p>
          </div>
          <button
            onClick={() => currentUser ? setShowUpload(!showUpload) : onRequireLogin?.()}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium transition-all-smooth shadow-sm ${
              currentUser
                ? 'bg-mes-primary hover:bg-mes-primaryHover'
                : 'bg-gray-400 hover:bg-gray-500'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {currentUser ? '上传文档' : '请先登录后上传'}
          </button>
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <StatCard label="文档总数" value={stats.total} icon="📚" color="#4d6bfe" />
          <StatCard label="已入库" value={stats.approved} icon="✅" color="#22c55e" />
          <StatCard label="待审核" value={stats.pending} icon="⏳" color="#f59e0b" />
          <StatCard label="知识切片" value={stats.chunks} icon="🧩" color="#7c3aed" />
        </div>

        {/* 上传区域 */}
        {showUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".doc,.docx,.ppt,.pptx,.xls,.xlsx,.pdf,.xml"
              onChange={handleFileInputChange}
              className="hidden"
            />
            {uploadStatus && (
              <div className="mb-3 px-4 py-2 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-700 flex items-center gap-2 animate-fade-in">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
                {uploadStatus}
              </div>
            )}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={handleSelectFile}
              className={`mb-6 rounded-xl border-2 border-dashed p-8 transition-all-smooth cursor-pointer animate-expand ${
                dragOver
                  ? 'border-mes-primary bg-mes-primary/10 scale-[1.01]'
                  : 'border-mes-primary bg-mes-tagBg/30 hover:bg-mes-tagBg/50'
              }`}
            >
              {/* 上传提示 */}
              <div className="mb-4 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-500 shrink-0 mt-0.5">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <p className="text-xs text-amber-700 leading-relaxed">
                  请上传<span className="font-medium">知识沉淀类文档</span>，不要上传变更频繁的<span className="font-medium">作业指导书和标准</span>，避免引起错误理解。
                </p>
              </div>
              <div className="flex flex-col items-center text-center">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-3 transition-colors ${dragOver ? 'bg-mes-primary/20' : 'bg-mes-primary/10'}`}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-mes-primary transition-transform ${dragOver ? 'scale-110' : ''}`}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-mes-text mb-1">
                  {dragOver ? '松开鼠标即可上传' : '拖拽文件到此处，或点击选择文件'}
                </p>
                <div className="flex items-center gap-2 mb-3 flex-wrap justify-center">
                  <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">📄 Word (.docx)</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-orange-50 text-orange-600 font-medium">📊 PPT (.pptx)</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-600 font-medium">📈 Excel (.xlsx)</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-600 font-medium">📕 PDF (.pdf)</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSelectFile() }}
                    className="px-4 py-1.5 rounded-lg bg-mes-primary text-white text-xs font-medium hover:bg-mes-primaryHover transition-colors"
                  >
                    选择文件
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowUpload(false) }}
                    className="px-4 py-1.5 rounded-lg text-mes-textSecondary text-xs font-medium hover:bg-gray-100 transition-colors"
                  >
                    取消
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-mes-textTertiary">
                  <span className="flex items-center gap-1">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 11l3 3L22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                    自动提取关键词、背景、原因分析、解决方案
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* 搜索框 */}
        <div className="mb-4 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-mes-textTertiary" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="搜索文档名称、关键词或内容..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-mes-border bg-white focus:border-mes-primary focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-100 text-mes-textTertiary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* 筛选标签 */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-mes-textTertiary mr-1">状态：</span>
            <FilterTag active={filterStatus === 'all'} onClick={() => setFilterStatus('all')} label="全部" count={documents.length} />
            <FilterTag active={filterStatus === 'approved'} onClick={() => setFilterStatus('approved')} label="已入库" count={stats.approved} />
            <FilterTag active={filterStatus === 'pending'} onClick={() => setFilterStatus('pending')} label="待审核" count={stats.pending} />
          </div>
          <div className="w-px h-4 bg-mes-border mx-1" />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-mes-textTertiary mr-1">部门：</span>
            <FilterTag active={filterDepartment === 'all'} onClick={() => setFilterDepartment('all')} label="全部" count={documents.length} />
            {departmentOptions.map(dept => (
              <FilterTag
                key={dept}
                active={filterDepartment === dept}
                onClick={() => setFilterDepartment(dept)}
                label={dept}
                count={documents.filter(d => (d.uploaderDepartment || '未知') === dept).length}
              />
            ))}
          </div>
          {/* 操作日志：检索上传/删除/审核/总结的人员与时间（最右侧，仅管理员可见） */}
          {currentUser?.role === 'admin' && (
            <button
              onClick={() => setShowLogModal(true)}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-mes-primary bg-white border border-mes-primary/30 hover:bg-mes-primary/5 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="16" y2="17" />
              </svg>
              操作日志
            </button>
          )}
        </div>

        {/* 文档列表 */}
        <div className="space-y-3">
          {filteredDocs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-mes-textTertiary">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <p className="text-sm">未找到匹配的文档</p>
            </div>
          ) : (
            pagedDocs.map(doc => (
              <DocCard
                key={doc.id}
                doc={doc}
                searchQuery={searchQuery}
                onClick={() => setSelectedDoc(doc)}
                onRead={() => setReaderDoc(doc)}
                onOpenOriginal={() => openOriginalDoc(doc)}
                onDelete={() => setDeleteConfirm(doc)}
                canReview={currentUser ? canReviewDoc(currentUser, doc.uploader) : false}
                summaryTask={docTasks[doc.id] ? liveTasks[docTasks[doc.id]] : undefined}
                onCancelSummary={() => cancelSummary(doc.id)}
              />
            ))
          )}
        </div>

        {/* 列表分页控件（仅渲染分页，不改动检索数据） */}
        {docTotalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-5 mb-2">
            <button
              onClick={() => setDocPage(p => Math.max(1, p - 1))}
              disabled={docPage <= 1}
              className="px-3 py-1.5 rounded-lg text-sm border border-mes-border text-mes-textSecondary disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              上一页
            </button>
            <span className="text-sm text-mes-textSecondary px-2">
              第 {docPage} / {docTotalPages} 页（共 {filteredDocs.length} 篇）
            </span>
            <button
              onClick={() => setDocPage(p => Math.min(docTotalPages, p + 1))}
              disabled={docPage >= docTotalPages}
              className="px-3 py-1.5 rounded-lg text-sm border border-mes-border text-mes-textSecondary disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* 文档详情弹窗 */}
      {selectedDoc && (
        <DocDetailModal
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onApprove={() => handleApprove(selectedDoc.id)}
          onReject={() => handleReject(selectedDoc.id)}
          onRead={() => { setReaderDoc(selectedDoc); setSelectedDoc(null) }}
          onOpenOriginal={() => openOriginalDoc(selectedDoc)}
          onDelete={() => { setDeleteConfirm(selectedDoc); setSelectedDoc(null) }}
          onSummarize={(sheetName) => runSummary(selectedDoc, sheetName)}
          onReextract={() => handleReextract(selectedDoc)}
          canReview={currentUser ? canReviewDoc(currentUser, selectedDoc.uploader) : false}
        />
      )}

      {/* 整表/整文档总结弹窗 */}
      {summaryDoc && (
        <SummaryModal
          doc={summaryDoc}
          scope={summaryScope}
          running={summaryRunning}
          stage={summaryStage}
          progress={summaryProgress}
          text={summaryText}
          error={summaryError}
          saved={summarySaved}
          onClose={() => { setActiveTask(null); setSummaryDoc(null) }}
        />
      )}

      {showLogModal && (
        <LogModal onClose={() => setShowLogModal(false)} />
      )}

      {/* 文档阅读器弹窗 */}
      {readerDoc && (
        <DocReaderModal doc={readerDoc} onClose={() => setReaderDoc(null)} />
      )}

      {/* 原始文档查看弹窗 */}
      {originalDoc && (
        <OriginalDocModal doc={originalDoc} onClose={() => setOriginalDoc(null)} />
      )}

      {/* 删除确认弹窗 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 animate-fade-in" onClick={() => setDeleteConfirm(null)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-4 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-red-50 flex items-center justify-center mb-3">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-mes-text mb-1">确认删除文档？</h3>
              <p className="text-sm text-mes-textSecondary mb-1">
                文档 <span className="font-medium text-mes-text">{deleteConfirm.name}</span> 将被永久删除
              </p>
              <p className="text-xs text-mes-textTertiary">
                删除后知识库中将移除该文档的所有切片和索引
              </p>
              <p className="text-xs text-mes-textTertiary mt-1">
                此操作不可撤销
              </p>
            </div>
            <div className="flex items-center gap-2 px-6 pb-6">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mes-textSecondary border border-mes-border hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm.id)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors shadow-sm"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, icon, color }: { label: string; value: number; icon: string; color: string }) {
  return (
    <div className="rounded-xl border border-mes-border bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-mes-textSecondary">{label}</span>
        <span className="text-lg">{icon}</span>
      </div>
      <p className="text-2xl font-bold" style={{ color }}>{value}</p>
    </div>
  )
}

function FilterTag({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all-smooth ${
        active ? 'bg-mes-primary text-white' : 'bg-white text-mes-textSecondary border border-mes-border hover:border-mes-primary'
      }`}
    >
      {label}
      <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-white/20' : 'bg-gray-100'}`}>
        {count}
      </span>
    </button>
  )
}

// 高亮搜索关键词
function HighlightText({ text, query }: { text: string; query: string }) {
  const safeText = text == null ? '' : String(text)
  if (!query.trim()) return <>{safeText}</>
  const parts = safeText.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-yellow-200 rounded px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  )
}

function DocCard({ doc, searchQuery, onClick, onRead, onOpenOriginal, onDelete, canReview, summaryTask, onCancelSummary }: {
  doc: KnowledgeDoc; searchQuery: string; onClick: () => void; onRead: () => void; onOpenOriginal: () => void; onDelete: () => void; canReview: boolean
  summaryTask?: { status: string; stage?: string; done?: number; total?: number; sheetName?: string | null } | undefined
  onCancelSummary?: () => void
}) {
  const typeConfig = docTypeConfig[doc.type as keyof typeof docTypeConfig] || docTypeConfig.pdf
  const status = statusConfig[doc.status as keyof typeof statusConfig] || statusConfig.pending

  return (
    <div
      className="group flex items-start gap-3 p-4 rounded-xl border border-mes-border bg-white hover:border-mes-primary hover:shadow-md transition-all-smooth"
    >
      {/* 文档图标 */}
      <div
        className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-xl cursor-pointer"
        style={{ backgroundColor: typeConfig.bg }}
        onClick={onClick}
      >
        {typeConfig.icon}
      </div>

      {/* 文档信息 */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-mes-text truncate">
            <HighlightText text={doc.name} query={searchQuery} />
          </span>
          <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: typeConfig.color, backgroundColor: typeConfig.bg }}>
            {typeConfig.label}
          </span>
          <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: status.color, backgroundColor: status.bg }}>
            {status.label}
          </span>
          {doc.aiExtracting && (
            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium shrink-0 bg-purple-50 text-purple-600">
              <span className="w-2.5 h-2.5 border-1.5 border-purple-400 border-t-transparent rounded-full animate-spin" />
              AI分析中
            </span>
          )}
          {summaryTask && (summaryTask.status === 'running' || summaryTask.status === 'pending') && (
            <span className="flex items-center gap-1.5 text-xs px-1.5 py-0.5 rounded font-medium shrink-0 bg-purple-50 text-purple-600">
              <span className="w-2.5 h-2.5 border-1.5 border-purple-400 border-t-transparent rounded-full animate-spin" />
              总结中 {summaryTask.done || 0}/{summaryTask.total || 0}
              {onCancelSummary && (
                <button
                  onClick={(e) => { e.stopPropagation(); onCancelSummary() }}
                  className="ml-0.5 px-1 rounded bg-purple-100 hover:bg-purple-200 text-purple-700 leading-none"
                  title="取消总结"
                >
                  ✕
                </button>
              )}
            </span>
          )}
        </div>

        <p className="text-xs text-mes-textSecondary mb-2 line-clamp-1">
          <HighlightText text={doc.summary} query={searchQuery} />
        </p>

        {/* 关键词标签 */}
        <div className="flex items-center gap-1 flex-wrap mb-2">
          {(doc.keywords || []).slice(0, 4).map((kw, idx) => (
            <span key={idx} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-mes-textSecondary">
              <HighlightText text={kw} query={searchQuery} />
            </span>
          ))}
        </div>

        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-mes-textTertiary">
          {/* 用户名 */}
          <span className="flex items-center gap-0.5" title="用户名">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            {doc.uploader}
          </span>
          {/* 显示名称 */}
          {doc.uploaderName && doc.uploaderName !== doc.uploader && (
            <span className="flex items-center gap-0.5" title="显示名称">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              {doc.uploaderName}
            </span>
          )}
          {/* 部门 */}
          {doc.uploaderDepartment && (
            <span className="flex items-center gap-0.5" title="部门">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 21h18" />
                <path d="M5 21V7l7-4 7 4v14" />
                <path d="M9 21v-6h6v6" />
              </svg>
              {doc.uploaderDepartment}
            </span>
          )}
          {/* 上传日期 */}
          <span className="flex items-center gap-0.5" title="上传日期">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            上传 {doc.uploadDate}
          </span>
          {/* 入库日期 */}
          <span className="flex items-center gap-0.5" title="入库日期">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            入库 {doc.approvedDate || (doc.status === 'approved' ? '—' : '待审核')}
          </span>
          <span className="flex items-center gap-0.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            </svg>
            {doc.size}
          </span>
          <span className="flex items-center gap-0.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
            {doc.chunks} 切片 · {doc.pages} 页
          </span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); onOpenOriginal() }}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-mes-primary bg-mes-tagBg hover:bg-mes-primary hover:text-white transition-all-smooth"
          title="打开上传的原始文档"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          阅读原文
        </button>
        <button
          onClick={onClick}
          className="p-1.5 rounded-lg hover:bg-gray-100 text-mes-textTertiary hover:text-mes-primary transition-colors"
          title="查看详情"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {canReview && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="p-1.5 rounded-lg hover:bg-red-50 text-mes-textTertiary hover:text-red-500 transition-colors"
            title="删除文档"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

function DocDetailModal({
  doc,
  onClose,
  onApprove,
  onReject,
  onRead,
  onOpenOriginal,
  onDelete,
  onSummarize,
  onReextract,
  canReview,
}: {
  doc: KnowledgeDoc
  onClose: () => void
  onApprove: () => void
  onReject: () => void
  onRead: () => void
  onOpenOriginal: () => void
  onDelete: () => void
  onSummarize: (sheetName?: string) => void
  onReextract: () => void
  canReview: boolean
}) {
  const typeConfig = docTypeConfig[doc.type]
  const status = statusConfig[doc.status]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-white shadow-2xl animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-mes-border bg-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ backgroundColor: typeConfig.bg }}>
              {typeConfig.icon}
            </div>
            <div>
              <h2 className="text-sm font-semibold text-mes-text">{doc.name}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ color: typeConfig.color, backgroundColor: typeConfig.bg }}>
                  {typeConfig.label}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ color: status.color, backgroundColor: status.bg }}>
                  {status.label}
                </span>
                <span className="text-xs text-mes-textTertiary">{doc.size} · {doc.chunks} 切片 · {doc.pages} 页</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onOpenOriginal}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-mes-primary bg-mes-tagBg hover:bg-mes-primary hover:text-white transition-all-smooth"
              title="打开上传的原始文档"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              阅读原文
            </button>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* 弹窗内容 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* 上传信息 */}
          <div className="flex items-center gap-x-5 gap-y-2 flex-wrap text-sm">
            <div className="flex items-center gap-1.5">
              <span className="text-mes-textTertiary text-xs">用户名</span>
              <span className="font-medium text-mes-text">{doc.uploader}</span>
            </div>
            {doc.uploaderName && doc.uploaderName !== doc.uploader && (
              <div className="flex items-center gap-1.5">
                <span className="text-mes-textTertiary text-xs">显示名称</span>
                <span className="font-medium text-mes-text">{doc.uploaderName}</span>
              </div>
            )}
            {doc.uploaderDepartment && (
              <div className="flex items-center gap-1.5">
                <span className="text-mes-textTertiary text-xs">部门</span>
                <span className="font-medium text-mes-text">{doc.uploaderDepartment}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-mes-textTertiary text-xs">上传日期</span>
              <span className="font-medium text-mes-text">{doc.uploadDate}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-mes-textTertiary text-xs">入库日期</span>
              <span className="font-medium text-mes-text">
                {doc.approvedDate || (doc.status === 'approved' ? '—' : '待审核')}
              </span>
            </div>
          </div>

          {/* AI 自动提取的元数据 */}
          <div className="rounded-xl border border-mes-border bg-gradient-to-br from-purple-50 to-blue-50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-600">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
              </svg>
              <span className="text-sm font-semibold text-purple-700">AI 自动归纳</span>
              {doc.aiExtracting ? (
                <span className="flex items-center gap-1 text-xs text-purple-600">
                  <span className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                  正在分析文档内容...
                </span>
              ) : (doc.aiExtracted || (doc.keywords.length > 0 && doc.keywords[0] !== '待提取')) ? (
                <span className="text-xs text-green-600 flex items-center gap-1">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                  已完成提取
                </span>
              ) : (
                <span className="text-xs text-mes-textTertiary">· 自动提取以下元数据</span>
              )}
              {/* 重新归纳：复用已提取的文档文本，重新调用 AI 提取元数据 */}
              {!doc.aiExtracting && (
                <button
                  onClick={onReextract}
                  className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 border border-purple-200 transition-colors"
                  title="使用当前模型重新提取关键词、背景、原因分析与解决方案"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                  重新归纳
                </button>
              )}
            </div>

            {doc.aiExtracting ? (
              <div className="flex flex-col items-center py-6 gap-3">
                <div className="w-8 h-8 border-3 border-purple-400 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-purple-600">AI 正在阅读文档并提取关键词、背景、原因分析和解决方案...</p>
                <p className="text-xs text-mes-textTertiary">预计需要 10-30 秒，请稍候</p>
              </div>
            ) : (
            <div className="space-y-3">
              <MetaField label="关键词">
                <div className="flex items-center gap-1 flex-wrap">
                  {doc.keywords.map((kw, idx) => (
                    <span key={idx} className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      kw === '待提取' ? 'bg-gray-100 text-gray-400' : 'bg-white text-purple-600'
                    }`}>
                      {kw}
                    </span>
                  ))}
                </div>
              </MetaField>

              <MetaField label="背景">
                <p className={`text-sm ${doc.background === '文档上传后，AI 将自动分析并提取背景信息' ? 'text-mes-textTertiary italic' : 'text-mes-text'}`}>{doc.background}</p>
              </MetaField>

              <MetaField label="原因分析">
                <p className={`text-sm ${doc.causeAnalysis === '待 AI 自动分析' ? 'text-mes-textTertiary italic' : 'text-mes-text'}`}>{doc.causeAnalysis}</p>
              </MetaField>

              <MetaField label="解决方案">
                <p className={`text-sm ${doc.solution === '待 AI 自动分析' ? 'text-mes-textTertiary italic' : 'text-mes-text'}`}>{doc.solution}</p>
              </MetaField>

              <MetaField label="概述">
                <p className="text-sm text-mes-textSecondary italic">{doc.summary}</p>
              </MetaField>

              {/* 整表 / 整文档总结（map-reduce，可覆盖全量，不限 maxChunks） */}
              <div className="rounded-lg border border-purple-200 bg-purple-50/40 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-600">
                    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
                    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
                  </svg>
                  <span className="text-xs font-medium text-purple-700">AI 整篇总结</span>
                  <span className="text-xs text-mes-textTertiary">（用于对知识密度极高文档的归纳提取，如字典手册类文档）</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => onSummarize()}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 transition-colors"
                  >
                    📝 总结整个文档
                    {doc.tableSummaries?.[FULL_DOC_SUMMARY_KEY] && (
                      <span
                        title={`已于 ${new Date(doc.tableSummaries[FULL_DOC_SUMMARY_KEY].updatedAt).toLocaleString()} 完成整篇总结`}
                        className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-green-100 text-green-700 px-1.5 py-0.5 text-[10px] font-semibold"
                      >
                        ✓ 已总结
                      </span>
                    )}
                  </button>
                  {doc.type === 'excel' && doc.content.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs text-mes-textTertiary">按标签页：</span>
                      {Array.from(new Set(doc.content.map(p => {
                        const parts = p.title.split(' - ')
                        return parts.length > 1 ? parts.slice(1).join(' - ') : p.title
                      }))).map(sheet => {
                        const sheetSummary = doc.tableSummaries?.[sheet]
                        return (
                          <button
                            key={sheet}
                            onClick={() => onSummarize(sheet)}
                            className={
                              sheetSummary
                                ? 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-purple-700 bg-green-50 border border-green-300 hover:bg-green-100 transition-colors'
                                : 'px-2.5 py-1.5 rounded-lg text-xs font-medium text-purple-700 bg-white border border-purple-200 hover:bg-purple-100 transition-colors'
                            }
                          >
                            {sheet}
                            {sheetSummary && (
                              <span
                                title={`已于 ${new Date(sheetSummary.updatedAt).toLocaleString()} 完成该标签页总结`}
                                className="text-green-600 font-bold"
                              >
                                ✓
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
            )}
          </div>

          {/* 文档预览（前两段） */}
          {doc.content.length > 0 && (
            <div className="rounded-xl border border-mes-border p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-mes-text">文档预览</span>
                <button
                  onClick={onRead}
                  className="text-xs text-mes-primary hover:underline"
                >
                  查看全部 {doc.pages} 页 →
                </button>
              </div>
              <div className="space-y-2">
                {doc.content[0].paragraphs.slice(0, 2).map((p, idx) => (
                  <p key={idx} className="text-xs text-mes-textSecondary leading-relaxed">{p}</p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 弹窗底部操作 */}
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-t border-mes-border bg-white">
          {canReview ? (
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-mes-textTertiary hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              删除文档
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {canReview && doc.status === 'pending' && doc.aiExtracting ? (
              <span className="px-3 py-2 text-xs text-mes-textTertiary bg-gray-50 rounded-lg">⏳ AI 提取中，暂不可审核</span>
            ) : canReview && doc.status === 'pending' && (
              <>
                <button
                  onClick={onReject}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-mes-danger border border-red-200 hover:bg-red-50 transition-colors"
                >
                  拒绝入库
                </button>
                <button
                  onClick={onApprove}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-mes-success hover:bg-green-600 transition-colors shadow-sm"
                >
                  确认入库
                </button>
              </>
            )}
            {doc.status === 'approved' && (
              <span className="text-xs text-mes-textTertiary flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-success">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
                已确认入库，可用于 AI 检索
              </span>
            )}
            {doc.status === 'rejected' && (
              <span className="text-xs text-mes-textTertiary flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mes-danger">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                已拒绝入库
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// 将工作表渲染为带列宽与合并单元格的 HTML 表格（更接近 Excel 打开效果；仅 UI，不影响归纳/检索）
function renderExcelSheetHtml(ws: XLSX.WorkSheet): string {
  const ref = ws['!ref']
  if (!ref) return ''
  const range = XLSX.utils.decode_range(ref)
  const cols = ws['!cols'] || []
  const merges = ws['!merges'] || []
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // 列宽（优先 wpx 像素宽，否则 wch 字符宽换算；ci.width 是 Excel 单位非像素，不直接用）
  let colgroup = '<colgroup>'
  for (let c = range.s.c; c <= range.e.c; c++) {
    const ci = cols[c] as any
    let wpx = 80
    if (ci) {
      if (ci.wpx) wpx = Math.round(ci.wpx)
      else if (ci.wch) wpx = Math.round(ci.wch * 7 + 5)
    }
    if (wpx < 40) wpx = 40
    colgroup += `<col style="width:${wpx}px;min-width:${wpx}px">`
  }
  colgroup += '</colgroup>'

  // 合并单元格：主格记录 colspan/rowspan，被合并格跳过
  const spanMap = new Map<string, { cs: number; rs: number }>()
  const skip = new Set<string>()
  for (const m of merges) {
    spanMap.set(`${m.s.r},${m.s.c}`, { cs: m.e.c - m.s.c + 1, rs: m.e.r - m.s.r + 1 })
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) skip.add(`${r},${c}`)
      }
    }
  }

  let body = ''
  for (let r = range.s.r; r <= range.e.r; r++) {
    // 跳过整行全空
    let rowEmpty = true
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (skip.has(`${r},${c}`)) continue
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.v != null && String(cell.v) !== '') { rowEmpty = false; break }
    }
    if (rowEmpty) continue

    body += '<tr>'
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (skip.has(`${r},${c}`)) continue
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      const span = spanMap.get(`${r},${c}`)
      const cs = span ? ` colspan="${span.cs}"` : ''
      const rs = span ? ` rowspan="${span.rs}"` : ''
      const val = cell && cell.v != null ? esc(String(cell.v)) : ''
      body += `<td${cs}${rs}>${val}</td>`
    }
    body += '</tr>'
  }
  return `<table>${colgroup}<tbody>${body}</tbody></table>`
}

// ===== 原始文档查看弹窗（阅读原文） =====
function OriginalDocModal({ doc, onClose }: { doc: KnowledgeDoc; onClose: () => void }) {
  const url = doc.pdfUrl || doc.fileUrl
  const typeConfig = docTypeConfig[doc.type]
  const canPdfPreview = doc.type === 'pdf' && !!doc.pdfUrl
  const previewRef = useRef<HTMLDivElement>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // 动态加载并渲染 Office 文档（docx / xlsx），pptx 展示提取的文本内容
  useEffect(() => {
    const container = previewRef.current
    if (canPdfPreview || !url || !container) return
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)

    const render = async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error('fetch failed')
        const blob = await res.blob()
        if (cancelled) return

        if (doc.type === 'xml') {
          // XML 数据导出：以「一条记录一块」的等宽文本展示。
          // 只渲染前 200 条：完整导出常含数千条记录，全量渲染会卡死页面。
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const MAX_PREVIEW_RECORDS = 200
          const shown = doc.content.slice(0, MAX_PREVIEW_RECORDS)
          const inner = shown
            .map(
              p =>
                `<div style="margin:0 0 14px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;">` +
                `<div style="font-weight:600;color:#7c3aed;margin-bottom:6px;">第 ${p.pageNum} 条 · ${esc(p.title)}</div>` +
                `<pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;color:#1f2937;">${esc(
                  p.paragraphs.join('\n')
                )}</pre></div>`
            )
            .join('')
          const more =
            doc.content.length > MAX_PREVIEW_RECORDS
              ? `<p class="pptx-para">…… 仅预览前 ${MAX_PREVIEW_RECORDS} 条，共 ${doc.content.length} 条记录。完整内容请在问答中检索，或下载原文件查看。</p>`
              : ''
          container.innerHTML = inner + more
        } else if (doc.type === 'word') {
          // Word：docx-preview 渲染原始排版
          await renderDocx(blob, container, undefined, {
            inWrapper: false,
            ignoreWidth: false,
            breakPages: true,
          })
        } else if (doc.type === 'excel') {
          // Excel：SheetJS 渲染表格 + 内嵌图片按锚点绝对定位叠加（不影响归纳/检索，仅 UI 渲染）
          const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array', cellStyles: true })
          const sheetImages = await extractExcelImages(blob).catch(() => [])
          const imgBySheet = new Map(sheetImages.map(s => [s.sheetName, s]))
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          let html = ''
          for (const name of wb.SheetNames) {
            const ws = wb.Sheets[name]
            const title = `<div class="xlsx-sheet-title">${esc(name)}</div>`
            const sheetMedia = imgBySheet.get(name)
            if (!ws || !ws['!ref']) {
              // 空表：仍有图片时单独展示图片
              const loose = (sheetMedia?.looseImages || []).map(src =>
                `<img src="${src}" alt="" style="display:block;max-width:320px;height:auto;margin:8px 0;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.12);" />`
              ).join('')
              html += title + (loose || '<p class="pptx-para" style="color:#9ca3af;">该工作表为空，无数据可预览。</p>')
              continue
            }
            let tableHtml = ''
            try {
              tableHtml = renderExcelSheetHtml(ws)
            } catch {
              tableHtml = XLSX.utils.sheet_to_html(ws, { header: '', footer: '' })
            }
            const imgs = sheetMedia?.images || []
            const overlay = imgs.length
              ? imgs.map(im =>
                  `<img src="${im.dataUrl}" alt="" style="position:absolute;left:${im.leftPx}px;top:${im.topPx}px;width:${im.widthPx}px;height:${im.heightPx}px;z-index:2;pointer-events:none;" />`
                ).join('')
              : ''
            const looseHtml = (sheetMedia?.looseImages || []).length
              ? `<div class="xlsx-loose-images">${(sheetMedia!.looseImages).map(src =>
                  `<img src="${src}" alt="" style="display:block;max-width:320px;height:auto;margin:8px 0;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.12);" />`
                ).join('')}</div>`
              : ''
            html += `<div class="xlsx-sheet-block">${title}<div class="xlsx-sheet-canvas">${tableHtml}${overlay}</div>${looseHtml}</div>`
          }
          container.innerHTML = html || '<p class="pptx-para">此工作簿无可预览内容，请下载原文件查看。</p>'
        } else {
          // PPT：pptx-browser Canvas 渲染（接近 PowerPoint 打开效果；仅 UI，不影响归纳/检索）
          try {
            const { PptxRenderer } = await import('pptx-browser')
            const renderer = new PptxRenderer()
            await renderer.load(blob)
            const width = Math.max(360, Math.min(960, (container.clientWidth || 900) - 48))
            const canvases = await renderer.renderAllSlides(width)
            container.innerHTML = ''
            canvases.forEach((canvas: HTMLCanvasElement, i: number) => {
              const wrapper = document.createElement('div')
              wrapper.className = 'pptx-slide'
              const no = document.createElement('div')
              no.className = 'pptx-slide-no'
              no.textContent = `第 ${i + 1} 页 / 共 ${canvases.length} 页`
              wrapper.appendChild(no)
              canvas.style.maxWidth = '100%'
              canvas.style.height = 'auto'
              canvas.style.borderRadius = '4px'
              wrapper.appendChild(canvas)
              container.appendChild(wrapper)
            })
            renderer.destroy()
          } catch {
            // 回退：pptx-browser 失败时展示已提取文本
            const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            const paragraphs = doc.content.flatMap(p => p.paragraphs)
            const inner = (paragraphs.length
              ? paragraphs
              : ['此幻灯片无可预览的文本内容，请下载原文件查看。']
            ).map(p => `<p class="pptx-para">${esc(p)}</p>`).join('')
            container.innerHTML = inner || '<p class="pptx-para">此演示文稿无可预览内容，请下载原文件查看。</p>'
          }
        }
      } catch (err: any) {
        console.error('在线预览失败', doc.name, err)
        if (!cancelled) setPreviewError(`在线预览失败（${err?.message || String(err)}），请下载原文件查看`)
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }

    render()
    return () => { cancelled = true }
  }, [doc, url, canPdfPreview])

  // 下载原文件：优先 showSaveFilePicker 以保留原文件名，回退 <a download>
  const downloadOriginal = async () => {
    if (!url) return
    const res = await fetch(url)
    const blob = await res.blob()
    const fileName = doc.name || '原文档'

    // 根据文件扩展名映射文件类型（使保存对话框的类型下拉默认原扩展名）
    const ext = (doc.fileType || fileName.split('.').pop() || '').toLowerCase()
    const mimeMap: Record<string, { mime: string; label: string }> = {
      docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word 文档' },
      doc: { mime: 'application/msword', label: 'Word 文档' },
      pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint 演示文稿' },
      ppt: { mime: 'application/vnd.ms-powerpoint', label: 'PowerPoint 演示文稿' },
      xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel 工作表' },
      xls: { mime: 'application/vnd.ms-excel', label: 'Excel 工作表' },
      pdf: { mime: 'application/pdf', label: 'PDF 文档' },
    }
    const typeInfo = mimeMap[ext] || { mime: 'application/octet-stream', label: '原始文档' }

    const picker = (window as any).showSaveFilePicker
    if (typeof picker === 'function') {
      try {
        const handle = await picker.call(window, {
          suggestedName: fileName,
          types: [{ description: typeInfo.label, accept: { [typeInfo.mime]: [`.${ext}`] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
        return
      } catch {
        return // 用户取消保存对话框
      }
    }

    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-white animate-fade-in">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-mes-border bg-white shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg shrink-0">{typeConfig.icon}</span>
          <h2 className="text-sm font-semibold text-mes-text truncate">{doc.name}</h2>
          <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0" style={{ color: typeConfig.color, backgroundColor: typeConfig.bg }}>
            原始文档
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={downloadOriginal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-mes-primary bg-mes-tagBg hover:bg-mes-primary hover:text-white transition-all-smooth"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            下载原文件
          </button>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-mes-textTertiary hover:text-mes-text"
            title="关闭"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto bg-gray-50">
        {canPdfPreview ? (
          <iframe src={url} className="w-full h-full" title={doc.name} />
        ) : (
          <div className="max-w-4xl mx-auto p-6">
            {previewLoading && (
              <div className="flex items-center justify-center gap-2 py-16 text-mes-textSecondary">
                <span className="w-5 h-5 border-2 border-mes-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">正在加载在线预览...</span>
              </div>
            )}
            {previewError && (
              <div className="flex flex-col items-center justify-center gap-4 py-16 text-mes-textSecondary">
                <span className="text-5xl">{typeConfig.icon}</span>
                <p className="text-sm">{previewError}</p>
                <button
                  onClick={downloadOriginal}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-mes-primary hover:bg-mes-primaryHover transition-all-smooth"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  下载原文件
                </button>
              </div>
            )}
            <div
              ref={previewRef}
              className="docx-preview-container"
              style={{ display: previewLoading || previewError ? 'none' : undefined }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ===== 文档阅读器弹窗 =====
function DocReaderModal({ doc, onClose }: { doc: KnowledgeDoc; onClose: () => void }) {
  const isPdf = doc.type === 'pdf' && !!doc.pdfUrl
  const [currentPage, setCurrentPage] = useState(0) // text docs: 0-indexed
  const [pdfPage, setPdfPage] = useState(1) // PDF: 1-indexed
  const [pdfTotal, setPdfTotal] = useState(doc.pages)
  const [pdfLabels, setPdfLabels] = useState<string[]>([]) // PDF 真实页码标签
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<number[]>([]) // text: page indices
  const [pdfSearchResults, setPdfSearchResults] = useState<number[]>([]) // PDF: page numbers
  const jumpToPageRef = useRef<((page: number) => void) | null>(null)

  const typeConfig = docTypeConfig[doc.type]
  const page = !isPdf ? doc.content[currentPage] : null

  // Text search (for non-PDF)
  const handleSearch = (term: string) => {
    setSearchTerm(term)
    if (isPdf) return
    if (!term.trim()) {
      setSearchResults([])
      return
    }
    const results: number[] = []
    doc.content.forEach((p, idx) => {
      if (p.paragraphs.some(para => para.toLowerCase().includes(term.toLowerCase())) ||
          p.title.toLowerCase().includes(term.toLowerCase())) {
        results.push(idx)
      }
    })
    setSearchResults(results)
  }

  const jumpToResult = (idx: number) => {
    if (isPdf) {
      const targetPage = pdfSearchResults[idx]
      setPdfPage(targetPage)
      jumpToPageRef.current?.(targetPage)
    } else {
      setCurrentPage(searchResults[idx])
    }
  }

  // PDF callbacks
  const handlePdfPageChange = useCallback((page: number, total: number, labels?: string[] | null) => {
    setPdfPage(page)
    setPdfTotal(total)
    if (labels && labels.length) setPdfLabels(labels)
  }, [])

  const handlePdfSearchResults = useCallback((pages: number[], total: number) => {
    setPdfSearchResults(pages)
    setPdfTotal(total)
  }, [])

  const registerJumpToPage = useCallback((fn: (page: number) => void) => {
    jumpToPageRef.current = fn
  }, [])

  const activeSearchResults = isPdf ? pdfSearchResults : searchResults

  // Page navigation
  const totalPages = isPdf ? pdfTotal : doc.content.length
  const currentPageDisplay = isPdf ? pdfPage : currentPage + 1

  const goToPrevPage = () => {
    if (isPdf) {
      const newPage = Math.max(1, pdfPage - 1)
      setPdfPage(newPage)
      jumpToPageRef.current?.(newPage)
    } else {
      setCurrentPage(Math.max(0, currentPage - 1))
    }
  }

  const goToNextPage = () => {
    if (isPdf) {
      const newPage = Math.min(pdfTotal, pdfPage + 1)
      setPdfPage(newPage)
      jumpToPageRef.current?.(newPage)
    } else {
      setCurrentPage(Math.min(doc.content.length - 1, currentPage + 1))
    }
  }

  const goToPage = (pageNum: number) => {
    if (isPdf) {
      setPdfPage(pageNum)
      jumpToPageRef.current?.(pageNum)
    } else {
      setCurrentPage(pageNum - 1)
    }
  }

  const isFirstPage = isPdf ? pdfPage <= 1 : currentPage === 0
  const isLastPage = isPdf ? pdfPage >= pdfTotal : currentPage >= doc.content.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-4xl h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 阅读器头部 */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-mes-border bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0" style={{ backgroundColor: typeConfig.bg }}>
              {typeConfig.icon}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-mes-text truncate">{doc.name}</h2>
              <span className="text-xs text-mes-textTertiary">
                {typeConfig.label} · {isPdf ? `第 ${pdfLabels[pdfPage - 1] ?? pdfPage} / ${pdfTotal} 页` : `${doc.pages} 页`} · {doc.size}
                {isPdf && <span className="ml-1.5 text-mes-primary">· 原生渲染</span>}
              </span>
            </div>
          </div>

          {/* 搜索框 */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mes-textTertiary" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="检索原文内容..."
                value={searchTerm}
                onChange={e => handleSearch(e.target.value)}
                className="w-56 pl-8 pr-3 py-1.5 text-xs rounded-lg border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors"
              />
              {searchTerm && activeSearchResults.length > 0 && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-mes-primary font-medium">
                  {activeSearchResults.length} 结果
                </span>
              )}
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* 搜索结果导航 */}
        {searchTerm && activeSearchResults.length > 0 && (
          <div className="shrink-0 flex items-center gap-1.5 px-5 py-2 bg-yellow-50 border-b border-yellow-200 overflow-x-auto">
            <span className="text-xs text-mes-textSecondary shrink-0">命中页面：</span>
            {activeSearchResults.map((pageIdx, idx) => {
              const displayPage = isPdf ? (pdfLabels[pageIdx - 1] ?? pageIdx) : pageIdx + 1
              const isActive = isPdf ? pdfPage === pageIdx : currentPage === pageIdx
              return (
                <button
                  key={idx}
                  onClick={() => jumpToResult(idx)}
                  className={`shrink-0 text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                    isActive
                      ? 'bg-mes-primary text-white'
                      : 'bg-white text-mes-primary border border-mes-primary hover:bg-mes-tagBg'
                  }`}
                >
                  第 {displayPage} 页
                </button>
              )
            })}
          </div>
        )}
        {searchTerm && activeSearchResults.length === 0 && (
          <div className="shrink-0 px-5 py-2 bg-gray-50 border-b border-mes-border">
            <span className="text-xs text-mes-textTertiary">未找到包含&ldquo;{searchTerm}&rdquo;的内容</span>
          </div>
        )}

        {/* 文档内容区域 */}
        <div className="flex-1 overflow-y-auto bg-gray-100">
          {isPdf ? (
            <div className="px-4 py-6">
              <PdfViewer
                url={doc.pdfUrl!}
                searchTerm={searchTerm}
                onPageChange={handlePdfPageChange}
                onSearchResults={handlePdfSearchResults}
                registerJumpToPage={registerJumpToPage}
              />
            </div>
          ) : doc.contentOmitted && doc.content.length === 0 ? (
            // 超大文档正文未随列表下发：打开阅读器时按需从服务端取回
            <div className="flex flex-col items-center justify-center h-full py-20 gap-4">
              <div className="w-12 h-12 border-3 border-purple-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-purple-600 font-medium">正在加载文档正文，请稍候...</p>
              <p className="text-xs text-mes-textTertiary">该文档体量较大（{doc.pageCount ?? 0} 条记录），正文按需加载，问答检索由服务端索引处理</p>
            </div>
          ) : doc.aiExtracting ? (
            <div className="flex flex-col items-center justify-center h-full py-20 gap-4">
              <div className="w-12 h-12 border-3 border-purple-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-purple-600 font-medium">正在解析文档内容，请稍候...</p>
              <p className="text-xs text-mes-textTertiary">提取文本中，完成后可在此阅读和检索原文</p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-8">
              <div className="bg-white rounded-lg shadow-lg p-8 md:p-12 min-h-[600px]">
                <div className="flex items-center gap-2 mb-6 pb-3 border-b border-gray-200">
                  <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ color: typeConfig.color, backgroundColor: typeConfig.bg }}>
                    {typeConfig.label}
                  </span>
                  <h3 className="text-lg font-bold text-gray-800">{page?.title}</h3>
                </div>
                <div className="space-y-4">
                  {page?.paragraphs.map((para, idx) => (
                    <p key={idx} className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                      <HighlightText text={para} query={searchTerm} />
                    </p>
                  ))}
                </div>
                <div className="mt-8 pt-4 border-t border-gray-200 flex items-center justify-between text-xs text-gray-400">
                  <span>{doc.name}</span>
                  <span>第 {page?.pageNum} / {doc.pages} 页</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 底部翻页导航 */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-t border-mes-border bg-white">
          <button
            onClick={goToPrevPage}
            disabled={isFirstPage}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-mes-textSecondary hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            上一页
          </button>

          {/* 页码导航 */}
          <div className="flex items-center gap-1">
            {Array.from({ length: totalPages }, (_, idx) => {
              const pageNum = idx + 1
              if (totalPages > 10 && pageNum > 3 && pageNum < totalPages - 1) {
                if (pageNum === 4) return <span key={idx} className="text-xs text-mes-textTertiary px-1">...</span>
                return null
              }
              return (
                <button
                  key={idx}
                  onClick={() => goToPage(pageNum)}
                  className={`w-7 h-7 rounded-md text-xs font-medium transition-all-smooth ${
                    currentPageDisplay === pageNum
                      ? 'bg-mes-primary text-white'
                      : 'text-mes-textSecondary hover:bg-gray-100'
                  }`}
                >
                  {pageNum}
                </button>
              )
            })}
            {totalPages > 10 && (
              <span className="text-xs text-mes-textTertiary px-1">共{totalPages}页</span>
            )}
          </div>

          <button
            onClick={goToNextPage}
            disabled={isLastPage}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-mes-textSecondary hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            下一页
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <div className="w-1 h-3 rounded-full bg-purple-400" />
        <span className="text-xs font-medium text-purple-600">{label}</span>
      </div>
      <div className="pl-2.5">{children}</div>
    </div>
  )
}

// ===== 整表 / 整文档总结弹窗（map-reduce 进度 + 结果） =====
function SummaryModal({
  doc,
  scope,
  running,
  stage,
  progress,
  text,
  error,
  saved,
  onClose,
}: {
  doc: KnowledgeDoc
  scope?: string
  running: boolean
  stage: 'map' | 'reduce' | 'done' | null
  progress: { done: number; total: number; elapsedMs?: number; etaMs?: number }
  text: string
  error: string
  saved?: boolean
  onClose: () => void
}) {
  const scopeLabel = scope ? `标签页「${scope}」` : '整个文档'
  // 已用时 / 预计剩余（避免用户误以为卡死）：elapsed 始终展示，eta 仅在已知进度时展示
  const fmtMin = (ms?: number) => (ms && ms > 0 ? `${(ms / 60000).toFixed(ms >= 60000 ? 0 : 1)} 分钟` : '')
  const elapsedText = fmtMin(progress.elapsedMs)
  const etaText = fmtMin(progress.etaMs)
  const timeHint = elapsedText ? `（已用 ${elapsedText}${etaText ? `，预计还需 ${etaText}` : ''}）` : ''
  const stageText =
    stage === 'map' ? `正在逐段分析（${progress.done}/${progress.total}）${timeHint}...`
      : stage === 'reduce' ? (progress.total > 0 ? `正在汇总全局结论（合并批次 ${progress.done}/${progress.total}）${timeHint}...` : `正在汇总全局结论${timeHint}...`)
        : stage === 'done' ? '总结完成' : ''

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-white shadow-2xl animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between px-6 py-4 border-b border-mes-border bg-white z-10">
          <div>
            <h2 className="text-sm font-semibold text-mes-text">AI 整篇总结</h2>
            <p className="text-xs text-mes-textTertiary mt-0.5">
              {doc.name} · {scopeLabel}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* 进度条 */}
          {running && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-xs text-mes-textSecondary mb-1.5">
                <span className="flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                  {stageText}
                </span>
                <span className="font-medium">{progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0}%</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-purple-500 transition-all-smooth"
                  style={{ width: `${progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* 结果文本 */}
          {text ? (
            <div className="rounded-xl border border-mes-border bg-gray-50 p-4">
              {saved && (
                <div className="mb-3 flex items-center gap-1.5 text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  已保存到知识库：整表总结已持久化，刷新 / 重开页面 / 换浏览器均可直接复用，无需再次生成
                </div>
              )}
              <pre className="text-sm text-mes-text leading-relaxed whitespace-pre-wrap font-sans">{text}</pre>
            </div>
          ) : !running && !error ? (
            <div className="flex flex-col items-center justify-center py-10 text-mes-textTertiary">
              <p className="text-sm">暂无内容</p>
            </div>
          ) : null}
        </div>

        <div className="sticky bottom-0 flex items-center justify-between px-6 py-4 border-t border-mes-border bg-white">
          <span className="text-xs text-mes-textTertiary">
            {running ? '处理中…可点击右下角「关闭」关闭本窗口，总结将在后台继续完成，完成后对应标签页会自动打勾' : '可复制以上总结内容使用'}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-mes-primary hover:bg-mes-primaryHover transition-colors"
          >
            {running ? '关闭' : '完成'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== 知识库操作日志查询弹窗 =====
function LogModal({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<DocLog[]>([])
  const [loading, setLoading] = useState(true)
  const [actionFilter, setActionFilter] = useState<'all' | 'upload' | 'delete' | 'review' | 'summary'>('all')
  const [operator, setOperator] = useState('')
  const [docName, setDocName] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)
  const PAGE_SIZE = 50

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getDocLogs()
      .then(list => { if (!cancelled) { setLogs(list); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshKey])

  // 打开期间每 5 秒轮询一次，确保删除/上传/审核等操作后日志即时可见
  useEffect(() => {
    const timer = setInterval(() => setRefreshKey(k => k + 1), 5000)
    return () => clearInterval(timer)
  }, [])

  const filtered = useMemo(() => {
    return logs
      .filter(l => {
        if (actionFilter === 'review') {
          if (l.action !== 'approve' && l.action !== 'reject') return false
        } else if (actionFilter !== 'all' && l.action !== actionFilter) {
          return false
        }
        if (operator.trim()) {
          const q = operator.trim().toLowerCase()
          if (!((l.operator || '').toLowerCase().includes(q) || (l.operatorName || '').toLowerCase().includes(q))) return false
        }
        if (docName.trim()) {
          const q = docName.trim().toLowerCase()
          if (!(l.target || '').toLowerCase().includes(q)) return false
        }
        if (dateFrom) {
          const d = (l.time || '').slice(0, 10)
          if (d < dateFrom) return false
        }
        if (dateTo) {
          const d = (l.time || '').slice(0, 10)
          if (d > dateTo) return false
        }
        return true
      })
      .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
  }, [logs, actionFilter, operator, docName, dateFrom, dateTo])

  // 筛选条件变化时回到第一页
  useEffect(() => { setPage(1) }, [actionFilter, operator, docName, dateFrom, dateTo])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const actionTabs: Array<'all' | 'upload' | 'delete' | 'review' | 'summary'> = ['all', 'upload', 'delete', 'review', 'summary']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-[760px] max-w-[94vw] h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-mes-border">
          <h3 className="text-base font-semibold text-mes-text">知识库操作日志</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              className="px-2.5 py-1 text-xs rounded-lg border border-mes-border bg-gray-50 hover:bg-white text-mes-textSecondary"
            >
              ↻ 刷新
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-mes-textTertiary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          </div>
        </div>

        {/* 筛选区：第一行操作类型，第二行检索栏 */}
        <div className="px-6 py-3 border-b border-mes-border space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {actionTabs.map(a => (
                <button
                  key={a}
                  onClick={() => setActionFilter(a)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${actionFilter === a ? 'bg-mes-primary text-white' : 'bg-gray-100 text-mes-textSecondary hover:bg-gray-200'}`}
                >
                  {a === 'all' ? '全部' : a === 'review' ? '审核' : LOG_ACTION_LABEL[a]}
                </button>
              ))}
            </div>
            <span className="text-xs text-mes-textTertiary">共 {filtered.length} 条</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={operator}
              onChange={e => setOperator(e.target.value)}
              placeholder="人员（用户名/姓名）"
              className="px-2.5 py-1 text-xs rounded-lg border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none"
            />
            <input
              value={docName}
              onChange={e => setDocName(e.target.value)}
              placeholder="文档名（模糊检索）"
              className="px-2.5 py-1 text-xs rounded-lg border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none"
            />
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="px-2 py-1 text-xs rounded-lg border border-mes-border bg-gray-50"
            />
            <span className="text-xs text-mes-textTertiary">至</span>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="px-2 py-1 text-xs rounded-lg border border-mes-border bg-gray-50"
            />
          </div>
        </div>

        {/* 日志列表 */}
        <div className="flex-1 overflow-y-auto px-6">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-mes-textTertiary text-sm">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-mes-textTertiary text-sm">暂无匹配日志</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-xs text-mes-textTertiary border-b border-mes-border">
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">时间</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">操作</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">人员</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">部门</th>
                  <th className="py-2 font-medium whitespace-nowrap">对象</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map(l => (
                  <tr key={l.id} className="border-b border-mes-border/60">
                    <td className="py-2 pr-3 text-mes-textSecondary whitespace-nowrap">{formatLogTime(l.time)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap ${logActionStyle(l.action)}`}>
                        {LOG_ACTION_LABEL[l.action] || l.action}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-mes-text whitespace-nowrap">
                      {l.operatorName || l.operator}
                      <span className="text-mes-textTertiary text-xs ml-1">@{l.operator}</span>
                    </td>
                    <td className="py-2 pr-3 text-mes-textSecondary whitespace-nowrap">{l.department || '—'}</td>
                    <td className="py-2 text-mes-textSecondary">{l.target || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

        </div>

        {/* 分页控件：固定在弹窗底端 */}
        {filtered.length > PAGE_SIZE && (
          <div className="shrink-0 flex items-center justify-center gap-2 py-2 px-6 border-t border-mes-border bg-white">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-2.5 py-1 text-xs rounded-lg border border-mes-border bg-white text-mes-textSecondary hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              上一页
            </button>
            <span className="text-xs text-mes-textTertiary">第 {page} / {totalPages} 页</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-2.5 py-1 text-xs rounded-lg border border-mes-border bg-white text-mes-textSecondary hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
