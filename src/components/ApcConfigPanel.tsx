// 「APC 和 RTO」监测项目编辑器
//
// 数据层次：监测项目 → 监测项（items[]）→ 输出结果 CV（只能 1 个）+ 参与参数 MV（N 个）
//
// 两个页签：
//   ① 项目设置 —— 名称 / 描述 / 绑定哪个数据库系统（db1 / db2）+ 全局目录元信息
//   ② 监测项   —— 左侧列表 + 右侧详情（取数与输出 / 参与参数 / 调优策略）
//
// 关键约定：
//  - 取数模式**只有宽表**：一个监测项的 CV 与全部 MV 必须来自查询结果同一行的不同列，
//    因此监测项自带一条 SQL 模板，界面上不再有「窄表 / 宽表」单选；
//  - 影响系数 k = ∂CV/∂MVᵢ：缺省 0 ＝ 未标定（运行期被排除出求解集，但不阻断保存）；
//  - 6 个规格类字段（CV 的 lsl/usl/target、MV 的 min/max）都可填「取数结果列名表达式」；
//  - 所有改动先落本地草稿，点「保存」才提交（删除监测项同样在保存时生效）。
//
// 数据库连接（怎么连）与查询限制（怎么限）是公用配置，在侧边栏「数据库管理」页维护。
// 全部写接口在服务端挂 requireAdmin，需带 X-Admin-Token；配置落在服务端数据卷（不入 git）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  fetchApcConfig,
  fetchApcProject,
  createApcProject,
  updateApcProject,
  deleteApcProject,
  createApcItem,
  updateApcItem,
  deleteApcItem,
  saveApcConfig,
  previewApcItemQuery,
  setAdminToken,
} from '../services/apcApi'
import type {
  ApcConfigResponse,
  ApcItemOutput,
  ApcItemParam,
  ApcItemPreview,
  ApcItemTuning,
  ApcMonitorItem,
  ApcQueryConfig,
  ApcSpecValue,
} from '../types'

type TabKey = 'settings' | 'items'
type ItemTabKey = 'query' | 'params' | 'tuning'

const TABS: { key: TabKey; label: string; desc: string }[] = [
  { key: 'settings', label: '项目设置', desc: '名称与绑定的数据库系统' },
  { key: 'items', label: '监测项', desc: '一条 SQL + 1 个输出结果 + N 个参与参数' },
]

const ITEM_TABS: { key: ItemTabKey; label: string }[] = [
  { key: 'query', label: '取数与输出' },
  { key: 'params', label: '参与参数' },
  { key: 'tuning', label: '调优策略' },
]

const OBJECTIVE_OPTIONS = [
  { value: 'quality', label: '质量' },
  { value: 'energy', label: '能耗' },
  { value: 'yield', label: '收率' },
  { value: 'stability', label: '平稳性' },
]

const PLACEHOLDERS = [
  { token: '{{minutes}}', desc: '统计窗口分钟数（整数）' },
  { token: '{{limit}}', desc: '行数上限（整数）' },
  { token: '{{columns}}', desc: '时间戳列 + 输出结果列 + 全部参与参数列（自动生成，无需手写）' },
  { token: '{{schema}}', desc: '模式名（在「数据库管理」里配置）' },
]

const SQL_EXAMPLE =
  'SELECT {{columns}} FROM "MES_PROCESS_HIST"\n' +
  'WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}})\n' +
  'ORDER BY "TS" LIMIT {{limit}}'

// ===== 小工具 =====

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 规格字段的显示文本（null / undefined → 空串，便于「清空 = 不填」） */
function specText(v: ApcSpecValue | null | undefined): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

/** 是否为「含列名的表达式」写法（用于给输入框加等宽字体与提示） */
function isExprText(s: string): boolean {
  const t = s.trim()
  if (t === '') return false
  return !/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(t)
}

function numOrNull(s: string): number | null {
  const t = String(s).trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** 浅拷贝一个监测项（避免直接改到 state 里的引用） */
function cloneItem(it: ApcMonitorItem): ApcMonitorItem {
  return {
    ...it,
    query: { ...it.query, columns: { ...it.query.columns } },
    output: { ...it.output, spec: { ...it.output.spec } },
    params: (it.params || []).map(p => ({ ...p, k: { ...p.k } })),
    tuning: { ...it.tuning },
  }
}

function blankItem(n: number, deadbandPct: number): ApcMonitorItem {
  return {
    id: '',
    name: `新监测项 ${n}`,
    description: '',
    query: { mode: 'wide', history: '', columns: { ts: '' } },
    output: {
      code: `CV_${n}`,
      name: '输出结果',
      unit: '',
      decimals: 3,
      column: '',
      objective: 'quality',
      spec: { lsl: 0, usl: 1, target: '' },
    },
    params: [],
    tuning: { deadbandPct, maxRounds: 2, residualTolerancePct: 5 },
  }
}

function blankParam(n: number): ApcItemParam {
  return {
    code: `MV_${n}`,
    name: `参与参数 ${n}`,
    process: '',
    unit: '',
    decimals: 3,
    column: '',
    min: 0,
    max: 1,
    setpoint: null,
    maxStepPct: 3,
    weight: 1,
    enabled: true,
    k: { mode: 'manual', value: 0 },
  }
}

/**
 * 监测项自检提示（**与服务端 itemWarnings 保持一致**）。
 * 这些正是「配完了但算不出建议」的常见原因，提前讲清楚，
 * 好过运行期让人对着一个空建议猜。
 */
function itemWarnings(it: ApcMonitorItem): string[] {
  const out: string[] = []
  const params = it.params || []
  if (params.length === 0) {
    out.push('尚未添加参与参数，该监测项只能观察输出结果，无法给出调整建议。')
    return out
  }
  const noK = params.filter(p => !p.k || !Number.isFinite(p.k.value) || p.k.value === 0).map(p => p.code)
  if (noK.length > 0) {
    out.push(
      `以下参数的影响系数 k 为 0（尚未标定），调优时会被排除出求解集：${noK.join('、')}。` +
      '可先用单变量试验估计：k ≈ ΔCV / ΔMV。'
    )
  }
  const disabled = params.filter(p => p.enabled === false).map(p => p.code)
  if (disabled.length > 0) out.push(`以下参数已停用，不参与调优：${disabled.join('、')}。`)
  if (it.output && params.some(p => p.code === it.output.code)) {
    out.push(
      '该监测项的输出结果与某个参与参数是同一个量（自调优），等价于改造前的单参数模式；' +
      '如需多对 1，请改为独立的输出结果列并追加参与参数。'
    )
  }
  return out
}

/** 保存前的本地校验：给出比服务端报错更具体的定位 */
function validateItem(it: ApcMonitorItem, index: number): string | null {
  const where = `监测项第 ${index + 1} 项「${it.name || '(未命名)'}」`
  if (!it.name.trim()) return `${where}：名称不能为空`
  if (!/^[A-Za-z0-9_]{1,64}$/.test(it.output.code || '')) {
    return `${where}：输出结果编码非法（仅允许字母/数字/下划线）`
  }
  if (!String(it.output.column || '').trim()) return `${where}：输出结果必须配置数据列名`
  if (it.output.spec.lsl === '' || it.output.spec.lsl === null || it.output.spec.lsl === undefined) {
    return `${where}：输出结果缺少规格下限 lsl`
  }
  if (it.output.spec.usl === '' || it.output.spec.usl === null || it.output.spec.usl === undefined) {
    return `${where}：输出结果缺少规格上限 usl`
  }
  if (!String(it.query.history || '').trim()) return `${where}：缺少取数 SQL 模板`
  if (!String(it.query.columns?.ts || '').trim()) return `${where}：必须配置时间戳列`
  const seen = new Set<string>()
  for (const p of it.params) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(p.code || '')) {
      return `${where}：参与参数编码非法（仅允许字母/数字/下划线）：${p.code || '(空)'}`
    }
    if (seen.has(p.code)) return `${where}：参与参数存在重复编码 ${p.code}`
    seen.add(p.code)
    if (!String(p.column || '').trim()) return `${where}：参与参数 ${p.code} 必须配置数据列名`
    const lo = p.min
    const hi = p.max
    if (typeof lo === 'number' && typeof hi === 'number' && !(lo < hi)) {
      return `${where}：参与参数 ${p.code} 的可调范围非法（需 下限 < 上限）`
    }
  }
  return null
}

/** 提交给服务端的最小载荷（剥掉界面专用的东西） */
function toPayload(it: ApcMonitorItem) {
  return {
    id: it.id || undefined,
    name: it.name.trim(),
    description: it.description || '',
    query: {
      mode: 'wide' as const,
      history: it.query.history,
      columns: { ts: String(it.query.columns?.ts || '').trim() || undefined },
    },
    output: it.output,
    params: it.params,
    tuning: it.tuning,
  }
}

export function ApcConfigPanel({ projectId, onClose, onSaved }: {
  /** 要编辑的项目 id；null = 新建项目 */
  projectId: string | null
  onClose: () => void
  /** 保存/删除成功后回调（参数为已保存的项目 id，新建后用于切换选中） */
  onSaved: (projectId?: string) => void
}) {
  const [tab, setTab] = useState<TabKey>('settings')
  const [config, setConfig] = useState<ApcConfigResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState('')
  const [needsToken, setNeedsToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 项目设置草稿
  const [sName, setSName] = useState('')
  const [sDesc, setSDesc] = useState('')
  const [sDbSlot, setSDbSlot] = useState<'db1' | 'db2'>('db1')
  const [sDirty, setSDirty] = useState(false)

  // 监测项草稿
  const [items, setItems] = useState<ApcMonitorItem[]>([])
  /** 哪些下标被改过（保存时只提交这些） */
  const [dirtyIdx, setDirtyIdx] = useState<Record<number, true>>({})
  /** 待删除的已存在监测项 id（保存时生效） */
  const [deletedIds, setDeletedIds] = useState<string[]>([])
  const [selIdx, setSelIdx] = useState(0)
  const [itemTab, setItemTab] = useState<ItemTabKey>('query')
  const [pSel, setPSel] = useState(0)
  const [synthesized, setSynthesized] = useState(false)

  // 试运行
  const [preview, setPreview] = useState<ApcItemPreview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewRows, setPreviewRows] = useState(20)

  const [metaDraft, setMetaDraft] = useState<ApcConfigResponse['meta'] | null>(null)
  const [metaDirty, setMetaDirty] = useState(false)

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const sqlRef = useRef<HTMLTextAreaElement>(null)

  const isNew = !projectId
  const current = items[selIdx] || null
  const currentParam = current ? current.params[pSel] || null : null

  // ===== 载入 =====
  const load = useCallback(async () => {
    setLoading(true)
    setFatal('')
    try {
      const c = await fetchApcConfig()
      setConfig(c)
      setMetaDraft(c.meta ? { ...c.meta } : null)
      if (projectId) {
        const { project } = await fetchApcProject(projectId)
        setSName(project.name || '')
        setSDesc(project.description || '')
        setSDbSlot(project.dbSlot === 'db2' ? 'db2' : 'db1')
        setItems((project.items || []).map(cloneItem))
        setSynthesized(Boolean(project.synthesizedFromLegacy))
      } else {
        setSName('')
        setSDesc('')
        setSDbSlot('db1')
        setItems([])
        setSynthesized(false)
      }
      setSDirty(false)
      setMetaDirty(false)
      setDirtyIdx({})
      setDeletedIds([])
      setSelIdx(0)
      setItemTab('query')
      setPSel(0)
      setPreview(null)
      setPreviewErr('')
      setNeedsToken(false)
    } catch (err: any) {
      if (err?.status === 403) setNeedsToken(true)
      else setFatal(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  // 新建项目时用户手填了内容 → 视为已改动，避免「填了半天保存按钮是灰的」
  const locked = Boolean(config?.catalogFileLocked)
  const dirtyCount = (sDirty ? 1 : 0) + (metaDirty ? 1 : 0) +
    Object.keys(dirtyIdx).length + deletedIds.length

  const markItemDirty = useCallback((idx: number) => {
    setDirtyIdx(d => (d[idx] ? d : { ...d, [idx]: true }))
  }, [])

  const patchItems = useCallback((fn: (list: ApcMonitorItem[]) => ApcMonitorItem[]) => {
    setItems(list => fn(list))
  }, [])

  const patchCurrent = useCallback((fn: (it: ApcMonitorItem) => ApcMonitorItem) => {
    setItems(list => list.map((it, i) => (i === selIdx ? fn(it) : it)))
    markItemDirty(selIdx)
  }, [selIdx, markItemDirty])

  const patchOutput = useCallback((patch: Partial<ApcItemOutput>) => {
    patchCurrent(it => ({ ...it, output: { ...it.output, ...patch } }))
  }, [patchCurrent])

  const patchQuery = useCallback((patch: Partial<ApcQueryConfig>) => {
    patchCurrent(it => ({ ...it, query: { ...it.query, ...patch } }))
  }, [patchCurrent])

  const patchTuning = useCallback((patch: Partial<ApcItemTuning>) => {
    patchCurrent(it => ({ ...it, tuning: { ...it.tuning, ...patch } }))
  }, [patchCurrent])

  const patchParam = useCallback((patch: Partial<ApcItemParam>) => {
    patchCurrent(it => ({
      ...it,
      params: it.params.map((p, i) => (i === pSel ? { ...p, ...patch } : p)),
    }))
  }, [patchCurrent, pSel])

  // ===== 监测项增删 =====
  const addItem = useCallback(() => {
    const n = items.length + 1
    setItems(list => [...list, blankItem(n, metaDraft?.deadbandPctDefault ?? 10)])
    setDirtyIdx(d => ({ ...d, [items.length]: true }))
    setSelIdx(items.length)
    setItemTab('query')
    setPSel(0)
    setPreview(null)
  }, [items.length, metaDraft])

  const duplicateItem = useCallback(() => {
    if (!current) return
    const copy = cloneItem(current)
    copy.id = ''
    copy.name = `${current.name}（副本）`
    setItems(list => [...list, copy])
    setDirtyIdx(d => ({ ...d, [items.length]: true }))
    setSelIdx(items.length)
  }, [current, items.length])

  const removeItem = useCallback(() => {
    if (!current) return
    const name = current.name
    if (!window.confirm(`确定删除监测项「${name}」？该操作在点「保存」后才真正生效。`)) return
    setItems(list => list.filter((_, i) => i !== selIdx))
    setDeletedIds(ids => (current.id ? [...ids, current.id] : ids))
    // 下标会整体前移，脏标记按新下标重建
    setDirtyIdx(() => {
      const next: Record<number, true> = {}
      for (const k of Object.keys(dirtyIdx)) {
        const i = Number(k)
        if (i === selIdx) continue
        next[i > selIdx ? i - 1 : i] = true
      }
      return next
    })
    setSelIdx(s => Math.max(0, Math.min(s, items.length - 2)))
    setPreview(null)
  }, [current, selIdx, items.length, dirtyIdx])

  const addParam = useCallback(() => {
    if (!current) return
    const n = current.params.length + 1
    patchCurrent(it => ({ ...it, params: [...it.params, blankParam(n)] }))
    setPSel(current.params.length)
  }, [current, patchCurrent])

  const duplicateParam = useCallback(() => {
    if (!current || !currentParam) return
    const copy: ApcItemParam = { ...currentParam, k: { ...currentParam.k }, code: `${currentParam.code}_COPY`, name: `${currentParam.name}（副本）` }
    patchCurrent(it => ({ ...it, params: [...it.params, copy] }))
    setPSel(current.params.length)
  }, [current, currentParam, patchCurrent])

  const removeParam = useCallback(() => {
    if (!current || !currentParam) return
    patchCurrent(it => ({ ...it, params: it.params.filter((_, i) => i !== pSel) }))
    setPSel(s => Math.max(0, s - 1))
  }, [current, currentParam, patchCurrent, pSel])

  // ===== 试运行 =====
  const handlePreview = useCallback(async () => {
    if (!current) return
    const err = validateItem(current, selIdx)
    if (err) { setPreviewErr(err); setPreview(null); return }
    if (!projectId) {
      setPreviewErr('新项目尚未保存，无法连接数据库试运行；请先保存项目再试运行。')
      return
    }
    setPreviewing(true)
    setPreviewErr('')
    setPreview(null)
    try {
      setPreview(await previewApcItemQuery({
        projectId,
        item: toPayload(current),
        minutes: 120,
        maxRows: previewRows,
      }))
    } catch (e: any) {
      setPreviewErr(e?.message || String(e))
    } finally {
      setPreviewing(false)
    }
  }, [current, selIdx, projectId, previewRows])

  const insertPlaceholder = useCallback((token: string) => {
    const el = sqlRef.current
    if (!el) {
      patchQuery({ history: `${current?.query.history || ''}${token}` })
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const next = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`
    patchQuery({ history: next })
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }, [current, patchQuery])

  // ===== 保存 =====
  const handleSave = useCallback(async () => {
    if (dirtyCount === 0) return
    setSaving(true)
    setNotice(null)
    try {
      // ① 项目本身
      let pid = projectId || ''
      if (isNew) {
        if (!sName.trim()) throw new Error('项目名称不能为空')
        const res = await createApcProject({ name: sName.trim(), description: sDesc.trim(), dbSlot: sDbSlot })
        pid = res.project.id
      } else {
        const patch: Record<string, unknown> = {}
        if (sDirty) { patch.name = sName.trim(); patch.description = sDesc.trim(); patch.dbSlot = sDbSlot }
        if (Object.keys(patch).length > 0) await updateApcProject(pid, patch)
      }
      if (metaDirty && metaDraft) await saveApcConfig({ meta: metaDraft })

      // ② 监测项：先删后写（先做本地校验，避免半途失败留下不一致）
      const failures: string[] = []
      if (deletedIds.length > 0) {
        for (const id of deletedIds) {
          try { await deleteApcItem(pid, id) } catch (e: any) { failures.push(`删除监测项失败：${e?.message || e}`) }
        }
      }
      for (let i = 0; i < items.length; i++) {
        if (!dirtyIdx[i]) continue
        const bad = validateItem(items[i], i)
        if (bad) { failures.push(bad); continue }
        try {
          const payload = toPayload(items[i])
          if (items[i].id) await updateApcItem(pid, items[i].id, payload)
          else await createApcItem(pid, payload)
        } catch (e: any) {
          failures.push(`监测项「${items[i].name}」保存失败：${e?.message || e}`)
        }
      }

      await load()
      if (failures.length > 0) {
        setNotice({ kind: 'err', text: failures.join('；') })
      } else {
        setNotice({ kind: 'ok', text: '已保存并生效（缓存已刷新）' })
      }
      onSaved(pid)
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setSaving(false)
    }
  }, [dirtyCount, isNew, projectId, sName, sDesc, sDbSlot, sDirty, metaDirty, metaDraft, deletedIds, items, dirtyIdx, load, onSaved])

  const handleDeleteProject = useCallback(async () => {
    if (!projectId) return
    if (!window.confirm('确定删除该项目？项目内的全部监测项（SQL 模板 + 输出结果 + 参与参数）将一并清除。')) return
    setDeleting(true)
    setNotice(null)
    try {
      await deleteApcProject(projectId)
      onSaved()
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setDeleting(false)
    }
  }, [projectId, onSaved])

  const handleTokenSave = useCallback(() => {
    setAdminToken(tokenInput)
    setTokenInput('')
    void load()
  }, [tokenInput, load])

  // 槽位变量 → 系统显示名（在「数据库管理」页配置）
  const slotNameMap: Record<string, string> = Object.fromEntries(
    (config?.database?.slots || []).map(s => [s.id, s.name || s.id])
  )

  const warnings = useMemo(() => (current ? itemWarnings(current) : []), [current])

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-[1180px] h-full bg-mes-bg shadow-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* ===== 头部 ===== */}
        <div className="bg-white border-b border-mes-border px-5 py-3 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-mes-text">{isNew ? '新建监测项目' : `编辑项目 · ${sName || projectId}`}</h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText font-medium">
                保存即生效
              </span>
              {locked && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium">
                  参数目录已由 APC_CATALOG_FILE 锁定
                </span>
              )}
              {synthesized && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-medium">
                  由旧配置自动迁移（保存后落盘）
                </span>
              )}
            </div>
            <div className="text-[11px] text-mes-textTertiary mt-1 leading-relaxed">
              一个监测项 = 一条取数 SQL + 1 个输出结果（CV）+ N 个参与参数（MV）；
              数据库连接与查询限制是公用配置，在侧边栏「数据库管理」页维护。
              {config?.configFileError ? ` · 配置文件异常：${config.configFileError}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dirtyCount > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-600 font-medium">
                {dirtyCount} 处未保存
              </span>
            )}
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-mes-textTertiary">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* ===== 令牌提示 ===== */}
        {needsToken && (
          <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 shrink-0">
            <div className="text-xs text-amber-800 font-medium mb-1">需要管理员令牌才能查看与修改数据源配置</div>
            <div className="text-[11px] text-amber-700 mb-2 leading-relaxed">
              服务端已启用 ADMIN_TOKEN。请填写与管理端一致的令牌，保存在本机浏览器中（与知识库管理、用户管理共用同一个令牌）。
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder="粘贴 ADMIN_TOKEN"
                className="flex-1 max-w-[420px] text-xs px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white focus:outline-none focus:border-mes-primary font-mono"
              />
              <button onClick={handleTokenSave} className={btnPrimary}>保存令牌并重试</button>
            </div>
          </div>
        )}

        {/* ===== 页签 ===== */}
        <div className="bg-white border-b border-mes-border px-5 flex items-center gap-1 shrink-0">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.key ? 'border-mes-primary text-mes-primary' : 'border-transparent text-mes-textSecondary hover:text-mes-text'
              }`}
              title={t.desc}
            >
              {t.label}
              {t.key === 'items' && items.length > 0 && (
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText font-medium">{items.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* ===== 提示条 ===== */}
        {notice && (
          <div className={`px-5 py-2 text-xs shrink-0 leading-relaxed ${
            notice.kind === 'ok' ? 'bg-green-50 text-green-700 border-b border-green-200' : 'bg-red-50 text-red-700 border-b border-red-200'
          }`}>
            {notice.text}
          </div>
        )}

        {/* ===== 内容 ===== */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {loading && <div className="p-10 text-center text-sm text-mes-textTertiary animate-pulse">正在读取配置…</div>}
          {fatal && !loading && (
            <div className="m-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
              读取配置失败：{fatal}
            </div>
          )}
          {config?.catalogError && (
            <div className="mx-5 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700 shrink-0">
              参数目录异常：{config.catalogError}
            </div>
          )}

          {config && !loading && tab === 'settings' && (
            <div className="flex-1 overflow-y-auto p-5">
              <SectionCard title="项目信息" desc="项目 = 一套完整的监测设置：用哪个数据库、有哪些监测项">
                <div className="grid grid-cols-1 gap-3">
                  <FieldShell label="项目名称" hint="必填；将显示在「APC 和 RTO」页面与项目列表">
                    <input
                      type="text"
                      value={sName}
                      onChange={e => { setSName(e.target.value); setSDirty(true) }}
                      placeholder="如 注液量监测"
                      className={inputCls}
                    />
                  </FieldShell>
                  <FieldShell label="项目描述" hint="可选；一句话说明该项目的用途">
                    <input
                      type="text"
                      value={sDesc}
                      onChange={e => { setSDesc(e.target.value); setSDirty(true) }}
                      placeholder="如 监测注液工序的过程数据并给出设定值建议"
                      className={inputCls}
                    />
                  </FieldShell>
                  <FieldShell label="使用数据库" hint="该项目全部监测项的数据都从这个数据库系统读取（连接参数在「数据库管理」页配置）">
                    <div className="flex items-center gap-2">
                      <select
                        value={sDbSlot}
                        onChange={e => { setSDbSlot(e.target.value === 'db2' ? 'db2' : 'db1'); setSDirty(true) }}
                        className={`${inputCls} max-w-[260px]`}
                      >
                        {(config.database.slots.length > 0
                          ? config.database.slots.map(s => ({ id: s.id, name: s.name, configured: s.configured }))
                          : [
                              { id: 'db1', name: '数据库系统 1', configured: false },
                              { id: 'db2', name: '数据库系统 2', configured: false },
                            ]
                        ).map(s => (
                          <option key={s.id} value={s.id}>
                            {s.name}（{s.id}）{s.configured ? '' : ' · 未配置'}
                          </option>
                        ))}
                      </select>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        config.database.slots.find(s => s.id === sDbSlot)?.configured
                          ? 'bg-green-50 text-green-700'
                          : 'bg-gray-100 text-mes-textTertiary'
                      }`}>
                        {config.database.slots.find(s => s.id === sDbSlot)?.configured ? '已配置连接' : '尚未配置连接（取数不可用）'}
                      </span>
                    </div>
                  </FieldShell>
                </div>
              </SectionCard>

              {metaDraft && (
                <SectionCard title="目录元信息" desc="全局设置（对所有项目共用）：装置名 / 采样间隔 / 默认统计窗口 / 默认工艺死区">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldShell label="装置/产线名称" hint="仅用于「复制建议」文本，不参与取数">
                      <input type="text" value={metaDraft.station} onChange={e => { setMetaDraft({ ...metaDraft, station: e.target.value }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                    <FieldShell label="采样间隔（秒）" hint="用于趋势图与样本量估算">
                      <input type="number" min={10} max={86400} value={String(metaDraft.sampleIntervalSec)} onChange={e => { setMetaDraft({ ...metaDraft, sampleIntervalSec: Number(e.target.value) }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                    <FieldShell label="默认统计窗口（分钟）">
                      <input type="number" min={5} max={1440} value={String(metaDraft.defaultWindowMinutes)} onChange={e => { setMetaDraft({ ...metaDraft, defaultWindowMinutes: Number(e.target.value) }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                    <FieldShell label="默认工艺死区（%）" hint="新建监测项时的初始值；占规格带宽比例">
                      <input type="number" min={0} max={100} value={String(metaDraft.deadbandPctDefault)} onChange={e => { setMetaDraft({ ...metaDraft, deadbandPctDefault: Number(e.target.value) }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                  </div>
                  <div className="mt-3 text-[10px] text-mes-textTertiary">
                    配置更新时间：{fmtTime(config.updatedAt)}
                  </div>
                </SectionCard>
              )}
            </div>
          )}

          {config && !loading && tab === 'items' && (
            <div className="flex-1 overflow-hidden p-5 flex flex-col">
              {locked && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 mb-3 text-[11px] text-amber-800 leading-relaxed shrink-0">
                  当前由环境变量 <span className="font-mono">APC_CATALOG_FILE</span> 指定参数目录文件，
                  该模式下监测项配置不会被读取（运行期一律使用该文件的内容），因此这里禁止编辑。
                  如需在页面维护监测项，请移除该环境变量后重启服务。
                </div>
              )}
              <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[290px_1fr] gap-3">
                {/* ===== 左：监测项列表 ===== */}
                <div className="rounded-xl border border-mes-border bg-white overflow-hidden flex flex-col min-h-0">
                  <div className="px-3 py-2 border-b border-mes-border bg-gray-50/60 flex items-center justify-between shrink-0">
                    <span className="text-[11px] font-medium text-mes-textSecondary">
                      监测项<span className="ml-1 text-mes-textTertiary">{items.length} 个</span>
                    </span>
                    <div className="flex items-center gap-1">
                      <button onClick={addItem} disabled={locked} title="新增监测项" className={iconBtn + ' text-mes-primary'}>＋</button>
                      <button onClick={duplicateItem} disabled={locked || !current} title="复制当前监测项" className={iconBtn}>⧉</button>
                      <button onClick={removeItem} disabled={locked || !current} title="删除当前监测项" className={iconBtn + ' text-red-500'}>✕</button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto min-h-0">
                    {items.length === 0 && (
                      <div className="px-3 py-8 text-center text-[11px] text-mes-textTertiary leading-relaxed">
                        还没有监测项。<br />点右上角「＋」新建一个。
                      </div>
                    )}
                    {items.map((it, i) => (
                      <button
                        key={`${it.id || 'new'}-${i}`}
                        onClick={() => { setSelIdx(i); setPSel(0); setPreview(null); setPreviewErr('') }}
                        className={`w-full text-left px-3 py-2 border-b border-mes-border/60 transition-colors ${
                          i === selIdx ? 'bg-mes-tagBg/50' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-mes-text truncate">{it.name || '(未命名)'}</span>
                          {dirtyIdx[i] && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" title="有未保存的改动" />}
                        </div>
                        <div className="text-[10px] text-mes-textTertiary truncate mt-0.5">
                          {it.output?.code || '—'} ← {it.params?.length || 0} 个参与参数
                        </div>
                      </button>
                    ))}
                  </div>
                  {deletedIds.length > 0 && (
                    <div className="px-3 py-1.5 text-[10px] text-red-600 bg-red-50 border-t border-red-100 shrink-0">
                      待删除 {deletedIds.length} 项（保存后生效）
                    </div>
                  )}
                </div>

                {/* ===== 右：监测项详情 ===== */}
                <div className="rounded-xl border border-mes-border bg-white overflow-hidden flex flex-col min-h-0">
                  {!current && (
                    <div className="flex-1 flex items-center justify-center px-4 py-10 text-center text-xs text-mes-textTertiary leading-relaxed">
                      请选择左侧监测项，或点「＋」新增一个。<br />
                      一个监测项负责一段「参数 → 输出结果」的调优关系。
                    </div>
                  )}
                  {current && (
                    <>
                      <div className="px-4 py-2.5 border-b border-mes-border shrink-0">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <FieldShell label="监测项名称" hint="必填">
                            <input
                              type="text"
                              value={current.name}
                              onChange={e => patchCurrent(it => ({ ...it, name: e.target.value }))}
                              className={inputCls}
                              disabled={locked}
                            />
                          </FieldShell>
                          <FieldShell label="说明" hint="可选">
                            <input
                              type="text"
                              value={current.description}
                              onChange={e => patchCurrent(it => ({ ...it, description: e.target.value }))}
                              className={inputCls}
                              disabled={locked}
                              placeholder="如 张力回路：速度与收放卷张力共同影响卷径"
                            />
                          </FieldShell>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <div className="flex items-center gap-1">
                            {ITEM_TABS.map(t => (
                              <button
                                key={t.key}
                                onClick={() => setItemTab(t.key)}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                                  itemTab === t.key
                                    ? 'bg-mes-primary text-white'
                                    : 'bg-gray-50 text-mes-textSecondary hover:bg-gray-100'
                                }`}
                              >
                                {t.label}
                                {t.key === 'params' && current.params.length > 0 && (
                                  <span className="ml-1 opacity-80">{current.params.length}</span>
                                )}
                              </button>
                            ))}
                          </div>
                          {current.id && (
                            <span className="text-[10px] text-mes-textTertiary font-mono">id: {current.id}</span>
                          )}
                          {!current.id && <span className="text-[10px] text-orange-600">新建（保存后生成 id）</span>}
                        </div>
                      </div>

                      <div className="flex-1 overflow-y-auto p-4 min-h-0">
                        {itemTab === 'query' && (
                          <>
                            <SectionCard
                              title="取数 SQL 模板"
                              desc="只允许单条 SELECT / WITH；DDL、DML、多语句、SELECT INTO 等在保存与执行前都会被拒绝。一个监测项的 CV 与全部 MV 都取自这次查询结果的同一行"
                            >
                              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                                {PLACEHOLDERS.map(p => (
                                  <button
                                    key={p.token}
                                    onClick={() => insertPlaceholder(p.token)}
                                    title={p.desc}
                                    className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-mes-border bg-gray-50 text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary"
                                  >
                                    {p.token}
                                  </button>
                                ))}
                                <span className="text-[10px] text-mes-textTertiary ml-1">点击插入到光标处</span>
                                <button
                                  onClick={() => patchQuery({ history: SQL_EXAMPLE })}
                                  className="text-[10px] px-1.5 py-0.5 rounded border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary ml-auto"
                                >
                                  填入示例
                                </button>
                              </div>
                              <textarea
                                ref={sqlRef}
                                value={current.query.history}
                                onChange={e => patchQuery({ history: e.target.value })}
                                rows={8}
                                spellCheck={false}
                                className="w-full text-[11px] font-mono leading-relaxed px-3 py-2 rounded-lg border border-mes-border bg-gray-50 text-mes-text focus:outline-none focus:border-mes-primary resize-y"
                                placeholder={SQL_EXAMPLE}
                              />
                              <div className="mt-2 grid grid-cols-1 sm:grid-cols-[200px_auto_1fr] gap-3 items-end">
                                <FieldShell label="时间戳列" hint="必填；宽表按该列展开时间轴">
                                  <input
                                    type="text"
                                    value={current.query.columns?.ts || ''}
                                    onChange={e => patchQuery({ columns: { ...current.query.columns, ts: e.target.value } })}
                                    className={`${inputCls} font-mono`}
                                    placeholder="如 TS"
                                  />
                                </FieldShell>
                                <div className="flex items-center gap-2 pb-0.5">
                                  <label className="text-[11px] text-mes-textSecondary whitespace-nowrap">
                                    试运行行数
                                    <input
                                      type="number"
                                      min={1}
                                      max={200}
                                      value={previewRows}
                                      onChange={e => setPreviewRows(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                                      className="ml-1.5 w-16 text-[11px] px-2 py-1 rounded border border-mes-border bg-white focus:outline-none focus:border-mes-primary"
                                    />
                                  </label>
                                  <button
                                    onClick={handlePreview}
                                    disabled={previewing || !current.query.history.trim()}
                                    className={btnPrimary}
                                  >
                                    {previewing ? '正在执行…' : '试运行（只读）'}
                                  </button>
                                </div>
                                <div className="text-[10px] text-mes-textTertiary leading-relaxed pb-0.5">
                                  试运行会真实执行一次只读查询，用的是当前草稿（未保存）的列名与参数，不会改动配置。
                                </div>
                              </div>
                            </SectionCard>

                            <PreviewBlock
                              preview={preview}
                              previewErr={previewErr}
                              previewing={previewing}
                            />

                            <SectionCard
                              title="输出结果（CV）"
                              desc="多对 1 调优里唯一的被控量：规格上下限用于过程能力（Cpk）判定，RTO 理想操作点是寻优目标"
                            >
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <FieldShell label="输出结果编码" hint="必填；仅字母/数字/下划线">
                                  <input
                                    type="text"
                                    value={current.output.code}
                                    onChange={e => patchOutput({ code: e.target.value })}
                                    className={`${inputCls} font-mono`}
                                    disabled={locked}
                                  />
                                </FieldShell>
                                <FieldShell label="名称">
                                  <input type="text" value={current.output.name} onChange={e => patchOutput({ name: e.target.value })} className={inputCls} disabled={locked} />
                                </FieldShell>
                                <FieldShell label="数据列名" hint="必填；取数 SQL 结果中承载该值的列">
                                  <input
                                    type="text"
                                    value={current.output.column}
                                    onChange={e => patchOutput({ column: e.target.value })}
                                    className={`${inputCls} font-mono`}
                                    disabled={locked}
                                    placeholder="如 CAPACITY"
                                  />
                                </FieldShell>
                                <FieldShell label="单位">
                                  <input type="text" value={current.output.unit} onChange={e => patchOutput({ unit: e.target.value })} className={inputCls} disabled={locked} placeholder="如 Ah" />
                                </FieldShell>
                                <FieldShell label="小数位">
                                  <input
                                    type="number"
                                    min={0}
                                    max={6}
                                    value={String(current.output.decimals)}
                                    onChange={e => patchOutput({ decimals: Math.max(0, Math.min(6, Number(e.target.value) || 0)) })}
                                    className={inputCls}
                                    disabled={locked}
                                  />
                                </FieldShell>
                                <FieldShell label="优化目标">
                                  <select value={current.output.objective} onChange={e => patchOutput({ objective: e.target.value })} className={inputCls} disabled={locked}>
                                    {OBJECTIVE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}（{o.value}）</option>)}
                                  </select>
                                </FieldShell>
                              </div>

                              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <SpecField
                                  label="规格下限 LSL"
                                  hint="必填；数字，或列名表达式（如 LSL_COL）"
                                  value={current.output.spec.lsl}
                                  disabled={locked}
                                  onChange={v => patchOutput({ spec: { ...current.output.spec, lsl: v } })}
                                />
                                <SpecField
                                  label="规格上限 USL"
                                  hint="必填；数字，或列名表达式（如 USL_COL - 1）"
                                  value={current.output.spec.usl}
                                  disabled={locked}
                                  onChange={v => patchOutput({ spec: { ...current.output.spec, usl: v } })}
                                />
                                <SpecField
                                  label="RTO 理想操作点"
                                  hint="可留空；留空时取规格中值 (lsl+usl)/2"
                                  value={current.output.spec.target}
                                  disabled={locked}
                                  onChange={v => patchOutput({ spec: { ...current.output.spec, target: v } })}
                                />
                              </div>
                              <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-[10px] text-mes-textTertiary leading-relaxed">
                                列名表达式按<b>每一个数据行</b>求值，且会被自动并入 <span className="font-mono">{'{{columns}}'}</span>，
                                无需手写进 SELECT。判定口径：窗口级用最新一行、点级逐点用各自所在行。
                                想知道有哪些列名可用，先点上面的「试运行（只读）」。
                              </div>
                            </SectionCard>
                          </>
                        )}

                        {itemTab === 'params' && (
                          <ParamsTab
                            params={current.params}
                            selected={pSel}
                            current={currentParam}
                            decimalsHint={current.output.decimals}
                            locked={locked}
                            preview={preview}
                            onSelect={setPSel}
                            onPatch={patchParam}
                            onAdd={addParam}
                            onDuplicate={duplicateParam}
                            onRemove={removeParam}
                          />
                        )}

                        {itemTab === 'tuning' && (
                          <TuningTab
                            tuning={current.tuning}
                            warnings={warnings}
                            output={current.output}
                            params={current.params}
                            onPatch={patchTuning}
                            locked={locked}
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ===== 底部操作 ===== */}
        <div className="bg-white border-t border-mes-border px-5 py-3 flex items-center justify-between gap-3 shrink-0">
          <div className="text-[11px] text-mes-textTertiary leading-relaxed">
            只读边界不变：无论怎么改配置，取数只可能是单条 SELECT，且强制行数上限与语句超时。
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isNew && (
              <button
                onClick={handleDeleteProject}
                disabled={deleting || saving}
                className={btnDanger}
              >
                {deleting ? '删除中…' : '删除项目'}
              </button>
            )}
            <button
              onClick={() => void load()}
              disabled={dirtyCount === 0 || saving}
              className={btnGhost}
            >
              放弃改动
            </button>
            <button
              onClick={handleSave}
              disabled={dirtyCount === 0 || saving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover disabled:opacity-50"
            >
              {saving && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              )}
              {isNew ? '创建项目' : `保存${dirtyCount > 0 ? `（${dirtyCount} 处）` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ===== 通用小组件 =====

function SectionCard({ title, desc, children, actions }: {
  title: string
  desc?: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="rounded-xl border border-mes-border bg-white mb-4 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-mes-border bg-gray-50/60 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-mes-text">{title}</div>
          {desc && <div className="text-[11px] text-mes-textTertiary mt-0.5 leading-relaxed">{desc}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  )
}

function FieldShell({ label, source, hint, children }: {
  label: string
  source?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[11px] font-medium text-mes-textSecondary">{label}</span>
        {source && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            source === '页面配置' ? 'bg-blue-50 text-blue-600' : source === '环境变量' ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-500'
          }`}>
            {source}
          </span>
        )}
      </div>
      {children}
      {hint && <div className="text-[10px] text-mes-textTertiary mt-1 leading-relaxed">{hint}</div>}
    </label>
  )
}

/**
 * 规格类字段输入框：既能填数字，也能填**取数结果列名表达式**。
 * 空值不强制转 0 —— 清空就是清空，否则手一抖删掉内容就变成「规格 0」，比留空更危险。
 */
function SpecField({ label, hint, value, onChange, disabled, placeholder }: {
  label: string
  hint?: string
  value: ApcSpecValue | null | undefined
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const text = specText(value)
  const expr = isExprText(text)
  return (
    <FieldShell label={label} hint={hint}>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={e => onChange(e.target.value)}
        className={`${inputCls}${expr ? ' font-mono text-purple-700' : ''}`}
        placeholder={placeholder || '数字或列名表达式'}
        disabled={disabled}
      />
    </FieldShell>
  )
}

/** 取数 SQL 试运行结果（含逐列核对） */
function PreviewBlock({ preview, previewErr, previewing }: {
  preview: ApcItemPreview | null
  previewErr: string
  previewing: boolean
}) {
  if (previewErr) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 mb-4 text-xs text-red-700 leading-relaxed">
        <div className="font-medium mb-1">试运行失败</div>
        <div>{previewErr}</div>
      </div>
    )
  }
  if (!preview) return null
  return (
    <SectionCard
      title="试运行结果"
      desc={`${preview.rowCount} 行 · 耗时 ${preview.elapsedMs} ms${preview.truncated ? ' · 已按上限截断' : ''}${previewing ? ' · 正在刷新…' : ''}`}
    >
      {preview.columnCheck.length > 0 && (
        <div className="mb-3 rounded-lg border border-mes-border bg-gray-50 px-3 py-2">
          <div className="text-[10px] text-mes-textTertiary mb-1.5">
            列核对：页面要用的每一列是否真的被 SELECT 出来（写在 ORDER BY 里不算）
          </div>
          <div className="flex flex-wrap gap-1.5">
            {preview.columnCheck.map((c, i) => {
              const ok = c.present === true
              const unknown = c.present === null
              return (
                <span
                  key={`${c.role}-${c.code}-${i}`}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono border ${
                    unknown
                      ? 'border-gray-200 bg-white text-gray-500'
                      : ok
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-red-200 bg-red-50 text-red-700'
                  }`}
                  title={unknown ? '查询没返回数据，无法判断该列是否存在' : ok ? '已在结果列中' : '未出现在结果列中，该项取不到数据'}
                >
                  {unknown ? '? ' : ok ? '✓ ' : '✗ '}
                  {c.role === 'output' ? '输出' : '参数'} {c.code} · {c.column}
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="text-[10px] text-mes-textTertiary mb-1">实际执行的 SQL（占位符已替换）</div>
      <pre className="text-[10px] font-mono leading-relaxed bg-gray-50 border border-mes-border rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-mes-textSecondary mb-3">
        {preview.sql}
      </pre>

      {preview.warnings.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
          {preview.warnings.map((w, i) => <div key={i}>· {w}</div>)}
        </div>
      )}

      {preview.rows.length === 0 ? (
        <div className="text-xs text-mes-textTertiary py-4 text-center">
          查询成功但没返回数据。请确认时间窗口、表名与过滤条件；也可以调大统计窗口后再试。
        </div>
      ) : (
        <div className="overflow-x-auto border border-mes-border rounded-lg">
          <table className="min-w-full text-[11px]">
            <thead className="bg-gray-50">
              <tr>
                {preview.columns.map(c => (
                  <th key={c} className="px-2.5 py-1.5 text-left font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 12).map((row, i) => (
                <tr key={i} className="odd:bg-white even:bg-gray-50/50">
                  {preview.columns.map(c => (
                    <td key={c} className="px-2.5 py-1.5 text-mes-text whitespace-nowrap border-b border-mes-border/60 font-mono">
                      {cellText(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > 12 && (
            <div className="px-2.5 py-1.5 text-[10px] text-mes-textTertiary bg-gray-50">
              仅展示前 12 行，共返回 {preview.rows.length} 行
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}

// ===== ② 参与参数（MV）=====

function ParamsTab({
  params, selected, current, locked, preview,
  onSelect, onPatch, onAdd, onDuplicate, onRemove,
}: {
  params: ApcItemParam[]
  selected: number
  current: ApcItemParam | null
  /** 输出结果的小数位：仅作为默认值参考 */
  decimalsHint: number
  locked: boolean
  preview: ApcItemPreview | null
  onSelect: (i: number) => void
  onPatch: (patch: Partial<ApcItemParam>) => void
  onAdd: () => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const numField = (label: string, key: 'maxStepPct' | 'weight' | 'decimals', hint?: string, step = 'any') => (
    <FieldShell label={label} hint={hint}>
      <input
        type="number"
        step={step}
        value={current ? String(current[key] ?? '') : ''}
        onChange={e => onPatch({ [key]: e.target.value === '' ? 0 : Number(e.target.value) } as Partial<ApcItemParam>)}
        className={inputCls}
        disabled={!current || locked}
      />
    </FieldShell>
  )

  /** 该参数的数据列是否出现在最近一次试运行结果里 */
  const columnState = (code: string): boolean | null => {
    if (!preview) return null
    const hit = preview.columnCheck.find(c => c.role === 'param' && c.code === code)
    return hit ? hit.present : null
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold text-mes-text">
          参与参数（MV）<span className="ml-1.5 text-[11px] font-normal text-mes-textTertiary">{params.length} 个</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onAdd} disabled={locked} className={btnGhost}>＋ 新增参数</button>
          <button onClick={onDuplicate} disabled={locked || !current} className={btnGhost}>复制</button>
          <button onClick={onRemove} disabled={locked || !current} className={btnGhost + ' text-red-600 border-red-200 hover:bg-red-50'}>删除</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-3">
        {/* 参数列表 */}
        <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
          <div className="max-h-[520px] overflow-y-auto">
            {params.length === 0 && (
              <div className="px-3 py-8 text-center text-[11px] text-mes-textTertiary leading-relaxed">
                还没有参与参数。<br />没有 MV 时该监测项只能观察，不能调优。
              </div>
            )}
            {params.map((p, i) => {
              const cs = columnState(p.code)
              return (
                <button
                  key={`${p.code}-${i}`}
                  onClick={() => onSelect(i)}
                  className={`w-full text-left px-3 py-2 border-b border-mes-border/60 transition-colors ${
                    i === selected ? 'bg-mes-tagBg/50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-mes-text truncate">{p.name || p.code}</span>
                    {p.enabled === false && (
                      <span className="text-[9px] px-1 rounded bg-gray-100 text-gray-500 shrink-0">停用</span>
                    )}
                    {(p.k?.value || 0) === 0 && (
                      <span className="text-[9px] px-1 rounded bg-amber-50 text-amber-700 shrink-0" title="影响系数未标定">k=0</span>
                    )}
                  </div>
                  <div className="text-[10px] text-mes-textTertiary truncate mt-0.5 flex items-center gap-1">
                    <span className="truncate">{p.column ? `列 ${p.column}` : '未填列名'}</span>
                    {cs === false && <span className="text-red-500 shrink-0" title="该列未出现在试运行结果中">✗</span>}
                    {cs === true && <span className="text-emerald-600 shrink-0" title="该列已在试运行结果中">✓</span>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* 参数表单 */}
        <div>
          {!current && (
            <div className="rounded-xl border border-mes-border bg-white px-4 py-10 text-center text-xs text-mes-textTertiary">
              请选择左侧参数，或点「＋ 新增参数」
            </div>
          )}
          {current && (
            <>
              <SectionCard title="标识与取值" desc="编码用于展示与引用；真正决定取值的是「数据列名」">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <FieldShell label="参数编码" hint="必填；仅字母/数字/下划线，需在本监测项内唯一">
                    <input type="text" value={current.code} onChange={e => onPatch({ code: e.target.value })} className={`${inputCls} font-mono`} disabled={locked} />
                  </FieldShell>
                  <FieldShell label="参数名称">
                    <input type="text" value={current.name} onChange={e => onPatch({ name: e.target.value })} className={inputCls} disabled={locked} />
                  </FieldShell>
                  <FieldShell label="数据列名" hint="必填；取数 SQL 结果中承载该参数值的列">
                    <input
                      type="text"
                      value={current.column}
                      onChange={e => onPatch({ column: e.target.value })}
                      className={`${inputCls} font-mono`}
                      disabled={locked}
                      placeholder="如 TENSION_SET"
                    />
                  </FieldShell>
                  <FieldShell label="所属工序">
                    <input type="text" value={current.process} onChange={e => onPatch({ process: e.target.value })} className={inputCls} disabled={locked} placeholder="如 卷绕" />
                  </FieldShell>
                  <FieldShell label="单位">
                    <input type="text" value={current.unit} onChange={e => onPatch({ unit: e.target.value })} className={inputCls} disabled={locked} placeholder="如 N" />
                  </FieldShell>
                  {numField('小数位', 'decimals', '建议值与调整量按此取整')}
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-2 text-[11px] text-mes-textSecondary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={current.enabled !== false}
                      onChange={e => onPatch({ enabled: e.target.checked })}
                      className="accent-mes-primary"
                      disabled={locked}
                    />
                    参与调优（取消勾选后该参数只做展示，不参与求解）
                  </label>
                </div>
              </SectionCard>

              <SectionCard
                title="可调范围与工作点"
                desc="min / max 既可填数字，也可填取数结果里的列名表达式；工作点用于计算「当前值 → 建议值」"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <SpecField
                    label="可调下限 min"
                    hint="必填；数字或列名表达式"
                    value={current.min}
                    disabled={locked}
                    onChange={v => onPatch({ min: v })}
                  />
                  <SpecField
                    label="可调上限 max"
                    hint="必填；数字或列名表达式"
                    value={current.max}
                    disabled={locked}
                    onChange={v => onPatch({ max: v })}
                  />
                </div>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FieldShell
                    label="当前设定值"
                    hint="留空则用该参数在窗口内的实测均值作为工作点；填了就按它算「当前 → 建议」"
                  >
                    <input
                      type="text"
                      inputMode="decimal"
                      value={current.setpoint === null || current.setpoint === undefined ? '' : String(current.setpoint)}
                      onChange={e => onPatch({ setpoint: numOrNull(e.target.value) })}
                      className={inputCls}
                      disabled={locked}
                      placeholder="留空 = 用窗口均值"
                    />
                  </FieldShell>
                  {numField('单次调整上限（%）', 'maxStepPct', '一次调整超过该幅度就分步逼近')}
                </div>
              </SectionCard>

              <SectionCard
                title="影响系数与调整阻力"
                desc="多对 1 求解的两个关键权重：k 决定「谁影响输出」，w 决定「谁不愿意动」"
              >
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <FieldShell label="影响系数 k = ∂CV/∂MV" hint="缺省 0 ＝ 未标定；此时该参数被排除出求解集（不阻断保存）">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        step="any"
                        value={String(current.k?.value ?? 0)}
                        onChange={e => onPatch({ k: { ...current.k, mode: 'manual', value: e.target.value === '' ? 0 : Number(e.target.value) } })}
                        className={`${inputCls} font-mono`}
                        disabled={locked}
                      />
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                        current.k?.mode === 'calibrated' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-mes-textTertiary'
                      }`}>
                        {current.k?.mode === 'calibrated' ? '已标定' : '手工'}
                      </span>
                    </div>
                  </FieldShell>
                  {numField('调整阻力 w', 'weight', '越大越不愿意动（0.01 ~ 100），缺省 1')}
                  <FieldShell label="杠杆份额（预览）" hint="k²·量程²/w：份额越大，承担的调整量越多">
                    <div className="text-xs font-mono text-mes-textSecondary px-2.5 py-1.5 rounded-lg bg-gray-50 border border-mes-border">
                      {(() => {
                        const span = Math.abs(Number(current.max) - Number(current.min))
                        if (!Number.isFinite(span)) return '—（量程为表达式，运行期才能算）'
                        const lev = (current.k?.value || 0) ** 2 * span * span / Math.max(0.01, current.weight || 1)
                        return lev === 0 ? '0（k 未标定）' : lev.toPrecision(4)
                      })()}
                    </div>
                  </FieldShell>
                </div>
                <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-[10px] text-mes-textTertiary leading-relaxed">
                  求解目标：在 Σ kᵢ·ΔMVᵢ = ΔCV 的前提下，让 Σ wᵢ·(ΔMVᵢ/量程ᵢ)² 最小。闭式解为
                  ΔMVᵢ = (kᵢ·量程ᵢ²/wᵢ)·ΔCV / Σⱼ(kⱼ·量程ⱼ²/wⱼ)——即「按杠杆份额分摊偏差」。
                  只有一个参数时退化为 ΔMV = ΔCV / k。
                  <br />
                  自动标定（用历史数据做多元回归 + 共线性诊断）计划在第二期提供，当前请手工填写。
                </div>
              </SectionCard>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ===== ③ 调优策略 =====

function TuningTab({
  tuning, warnings, output, params, onPatch, locked,
}: {
  tuning: ApcItemTuning
  warnings: string[]
  output: ApcItemOutput
  params: ApcItemParam[]
  onPatch: (patch: Partial<ApcItemTuning>) => void
  locked: boolean
}) {
  const active = params.filter(p => p.enabled !== false && Number.isFinite(p.k?.value) && (p.k?.value || 0) !== 0)
  const numField = (label: string, key: keyof ApcItemTuning, hint: string, min: number, max: number) => (
    <FieldShell label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        step="any"
        value={String(tuning[key] ?? '')}
        onChange={e => onPatch({ [key]: e.target.value === '' ? 0 : Number(e.target.value) } as Partial<ApcItemTuning>)}
        className={inputCls}
        disabled={locked}
      />
    </FieldShell>
  )

  return (
    <div>
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 mb-4 text-[11px] text-amber-800 leading-relaxed">
          <div className="font-medium mb-1">配置自检（不阻断保存，但会导致算不出建议）</div>
          {warnings.map((w, i) => <div key={i}>· {w}</div>)}
        </div>
      )}

      <SectionCard
        title="调优策略"
        desc="约束优化结果：多久不动、一次能推多远、剩多少偏差需要在风险提示里讲清楚"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {numField(
            '工艺死区（%）',
            'deadbandPct',
            '占规格带宽比例。偏差落在死区内且过程能力正常时建议「保持不动」——这是 RTO 与「自动追目标」的分界线，不建议删',
            0,
            100
          )}
          {numField(
            '最大分摊轮数',
            'maxRounds',
            '某参数顶到可调上下限后，把未消除的偏差重新分摊给其它参数，最多迭代几轮（0~5）',
            0,
            5
          )}
          {numField(
            '残余偏差容忍度（%）',
            'residualTolerancePct',
            '受约束后剩余偏差占原偏差超过该比例时，在风险提示中明确说明（0~100）',
            0,
            100
          )}
        </div>
        <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-[10px] text-mes-textTertiary leading-relaxed">
          执行顺序：死区判定 → 加权最小调整求解 → 可调范围裁剪 → 单次幅度限幅 → 按小数位取整 →
          把顶限部分重新分摊（最多 {tuning.maxRounds} 轮）→ 报告残余偏差。
        </div>
      </SectionCard>

      <SectionCard title="本监测项求解范围预览" desc="保存后运行期的求解集就是这些参数">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <StatCell label="输出结果" value={`${output.code}${output.unit ? `（${output.unit}）` : ''}`} hint="唯一的被控量 CV" />
          <StatCell label="参与求解" value={`${active.length} 个`} hint="已启用且 k ≠ 0" tone={active.length === 0 ? 'warn' : 'normal'} />
          <StatCell label="被排除" value={`${params.length - active.length} 个`} hint="停用 / k 未标定" tone={params.length - active.length > 0 ? 'warn' : 'normal'} />
        </div>
        {params.length > 0 && (
          <div className="overflow-x-auto border border-mes-border rounded-lg">
            <table className="min-w-full text-[11px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2.5 py-1.5 text-left font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">参数</th>
                  <th className="px-2.5 py-1.5 text-left font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">数据列</th>
                  <th className="px-2.5 py-1.5 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">k</th>
                  <th className="px-2.5 py-1.5 text-right font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">w</th>
                  <th className="px-2.5 py-1.5 text-left font-medium text-mes-textSecondary whitespace-nowrap border-b border-mes-border">状态</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p, i) => {
                  const isActive = p.enabled !== false && Number.isFinite(p.k?.value) && (p.k?.value || 0) !== 0
                  return (
                    <tr key={`${p.code}-${i}`} className="odd:bg-white even:bg-gray-50/50">
                      <td className="px-2.5 py-1.5 text-mes-text whitespace-nowrap border-b border-mes-border/60">{p.name || p.code}</td>
                      <td className="px-2.5 py-1.5 text-mes-textSecondary whitespace-nowrap border-b border-mes-border/60 font-mono">{p.column || '—'}</td>
                      <td className="px-2.5 py-1.5 text-right text-mes-text whitespace-nowrap border-b border-mes-border/60 font-mono">{p.k?.value ?? 0}</td>
                      <td className="px-2.5 py-1.5 text-right text-mes-text whitespace-nowrap border-b border-mes-border/60 font-mono">{p.weight}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap border-b border-mes-border/60">
                        {isActive
                          ? <span className="text-emerald-700">参与求解</span>
                          : <span className="text-amber-700">{p.enabled === false ? '已停用' : 'k 未标定'}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

function StatCell({ label, value, hint, tone = 'normal' }: {
  label: string
  value: string
  hint?: string
  tone?: 'normal' | 'warn'
}) {
  return (
    <div className="rounded-lg border border-mes-border bg-gray-50 px-3 py-2">
      <div className="text-[10px] text-mes-textTertiary mb-0.5">{label}</div>
      <div className={`text-sm font-semibold truncate ${tone === 'warn' ? 'text-amber-700' : 'text-mes-text'}`}>{value}</div>
      {hint && <div className="text-[10px] text-mes-textTertiary mt-0.5">{hint}</div>}
    </div>
  )
}

const inputCls = 'w-full text-xs px-2.5 py-1.5 rounded-lg border border-mes-border bg-white text-mes-text focus:outline-none focus:border-mes-primary'
const btnGhost = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50'
const btnPrimary = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover disabled:opacity-50'
const btnDanger = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50'
const iconBtn = 'px-1.5 py-0.5 rounded text-[11px] hover:bg-gray-100 disabled:opacity-40'
