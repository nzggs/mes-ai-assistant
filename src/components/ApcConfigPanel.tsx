// 「APC 和 RTO」监测项目编辑器
//
// 每个监测项目自带一套完整设置：
//   ① 项目设置     —— 名称 / 描述 / 绑定哪个数据库系统（db1 / db2）+ 全局目录元信息
//   ② SQL 模板     —— 窄表/宽表两种取数模式、SQL 模板与占位符、字段映射、试运行预览
//   ③ 参数配置     —— 过程参数逐个编辑 / 增删 / JSON 批量导入导出（参数跟随项目绑定数据库）
//
// 数据库连接（怎么连）与查询限制（怎么限）是公用配置，在侧边栏「数据库管理」页维护。
// 全部接口在服务端挂 requireAdmin，需带 X-Admin-Token；
// 配置落在服务端数据卷（不入 git），任何配置改动都要过只读护栏与结构校验。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchApcConfig,
  fetchApcProject,
  createApcProject,
  updateApcProject,
  deleteApcProject,
  saveApcConfig,
  resetApcConfig,
  previewApcQuery,
  setAdminToken,
  hasAdminToken,
  type ApcConfigSection,
} from '../services/apcApi'
import type {
  ApcConfigResponse,
  ApcParamConfig,
  ApcQueryConfig,
  ApcQueryPreview,
} from '../types'

type TabKey = 'settings' | 'queries' | 'params'

const TABS: { key: TabKey; label: string; desc: string }[] = [
  { key: 'settings', label: '项目设置', desc: '名称与绑定的数据库系统' },
  { key: 'queries', label: 'SQL 模板', desc: '取数模板与字段映射' },
  { key: 'params', label: '参数配置', desc: '过程参数目录' },
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
  { token: '{{codeFilter}}', desc: '窄表：参数编码过滤片段' },
  { token: '{{columns}}', desc: '宽表：各参数数据列名列表' },
  { token: '{{schema}}', desc: '模式名（在数据库登录里配置）' },
]

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

  // 项目设置草稿（名称 / 描述 / 绑定的数据库槽位）
  const [sName, setSName] = useState('')
  const [sDesc, setSDesc] = useState('')
  const [sDbSlot, setSDbSlot] = useState<'db1' | 'db2'>('db1')
  const [sDirty, setSDirty] = useState(false)

  const [qDraft, setQDraft] = useState<ApcQueryConfig>({ mode: 'long', history: '', columns: {} })
  // 载入时的原始模板快照：用于判断草稿是否被改动过（qDirty 之外的精确比对）
  const [origQueries, setOrigQueries] = useState<ApcQueryConfig | null>(null)
  const [qDirty, setQDirty] = useState(false)
  const [preview, setPreview] = useState<ApcQueryPreview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewRows, setPreviewRows] = useState(20)

  const [pDraft, setPDraft] = useState<ApcParamConfig[]>([])
  const [pDirty, setPDirty] = useState(false)
  const [selected, setSelected] = useState(0)
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonErr, setJsonErr] = useState('')

  const [metaDraft, setMetaDraft] = useState<ApcConfigResponse['meta'] | null>(null)
  const [metaDirty, setMetaDirty] = useState(false)

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const sqlRef = useRef<HTMLTextAreaElement>(null)

  const isNew = !projectId

  // ===== 载入 =====
  const applyProject = useCallback((p: { name: string; description?: string; dbSlot?: string; queries?: ApcQueryConfig | null; params?: ApcParamConfig[] } | null) => {
    setSName(p?.name || '')
    setSDesc(p?.description || '')
    setSDbSlot(p?.dbSlot === 'db2' ? 'db2' : 'db1')
    setQDraft(p?.queries ? { ...p.queries, columns: { ...p.queries.columns } } : { mode: 'long', history: '', columns: {} })
    setOrigQueries(p?.queries ? { ...p.queries, columns: { ...p.queries.columns } } : null)
    setPDraft((p?.params || []).map(x => ({ ...x })))
    setSDirty(false)
    setQDirty(false)
    setPDirty(false)
    setMetaDirty(false)
    setSelected(0)
    setJsonMode(false)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setFatal('')
    try {
      const c = await fetchApcConfig()
      setConfig(c)
      setMetaDraft(c.meta ? { ...c.meta } : null)
      if (projectId) {
        const { project } = await fetchApcProject(projectId)
        applyProject(project)
      } else {
        applyProject(null)
      }
      setNeedsToken(false)
    } catch (err: any) {
      if (err?.status === 403) setNeedsToken(true)
      else setFatal(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [applyProject, projectId])

  useEffect(() => { load() }, [load])

  const locked = Boolean(config?.catalogFileLocked)
  const dirtySections = useMemo(() => {
    const out: Array<'settings' | 'queries' | 'params' | 'meta'> = []
    if (sDirty) out.push('settings')
    if (qDirty) out.push('queries')
    if (pDirty) out.push('params')
    if (metaDirty) out.push('meta')
    return out
  }, [sDirty, qDirty, pDirty, metaDirty])

  // ===== 保存 / 重置 / 删除 =====
  const handleSave = useCallback(async () => {
    if (dirtySections.length === 0) return
    setSaving(true)
    setNotice(null)
    try {
      if (isNew) {
        // 新建：名称必填，首次保存即创建项目并带上已填的模板/参数
        if (!sName.trim()) throw new Error('项目名称不能为空')
        const res = await createApcProject({
          name: sName.trim(),
          description: sDesc.trim(),
          dbSlot: sDbSlot,
          queries: qDirty || qDraft.history ? qDraft : undefined,
          params: pDirty || pDraft.length > 0 ? pDraft : undefined,
        })
        if (metaDirty && metaDraft) await saveApcConfig({ meta: metaDraft })
        setNotice({ kind: 'ok', text: `已创建项目「${res.project.name}」并生效` })
        onSaved(res.project.id)
      } else {
        const patch: Record<string, unknown> = {}
        if (sDirty) { patch.name = sName.trim(); patch.description = sDesc.trim(); patch.dbSlot = sDbSlot }
        if (qDirty) patch.queries = qDraft
        if (pDirty) patch.params = pDraft
        if (Object.keys(patch).length > 0) await updateApcProject(projectId!, patch)
        if (metaDirty && metaDraft) await saveApcConfig({ meta: metaDraft })
        setNotice({ kind: 'ok', text: `已保存：${dirtySections.map(s => TABS.find(t => t.key === s)?.label || s).join('、')}；配置已生效（缓存已刷新）` })
        onSaved(projectId!)
      }
      setSDirty(false); setQDirty(false); setPDirty(false); setMetaDirty(false)
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setSaving(false)
    }
  }, [dirtySections, isNew, sName, sDesc, sDbSlot, qDirty, qDraft, pDirty, pDraft, metaDirty, metaDraft, projectId, onSaved])

  const handleDelete = useCallback(async () => {
    if (!projectId) return
    if (!window.confirm('确定删除该项目？项目内的 SQL 模板与参数配置将一并清除。')) return
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

  const handleReset = useCallback(async (section: ApcConfigSection) => {
    setSaving(true)
    setNotice(null)
    try {
      await resetApcConfig(section, undefined, projectId || undefined)
      await load()
      setNotice({ kind: 'ok', text: `已清空：${TABS.find(t => t.key === section)?.label || section}` })
      onSaved(projectId || undefined)
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setSaving(false)
    }
  }, [projectId, load, onSaved])

  const handlePreview = useCallback(async () => {
    setPreviewing(true)
    setPreviewErr('')
    setPreview(null)
    try {
      setPreview(await previewApcQuery({ queries: qDraft, params: pDraft, minutes: 120, maxRows: previewRows, slot: sDbSlot }))
    } catch (err: any) {
      setPreviewErr(err?.message || String(err))
    } finally {
      setPreviewing(false)
    }
  }, [qDraft, pDraft, previewRows, sDbSlot])

  // ===== 令牌 =====
  const handleTokenSave = useCallback(() => {
    setAdminToken(tokenInput)
    setTokenInput('')
    load()
  }, [tokenInput, load])

  const insertPlaceholder = useCallback((token: string) => {
    const el = sqlRef.current
    if (!el) {
      setQDraft(d => ({ ...d, history: `${d.history}${token}` }))
      setQDirty(true)
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const next = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`
    setQDraft(d => ({ ...d, history: next }))
    setQDirty(true)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }, [])

  // ===== 参数编辑辅助 =====
  const currentParam = pDraft[selected] || null

  const patchParam = useCallback((patch: Partial<ApcParamConfig>) => {
    setPDraft(list => list.map((p, i) => (i === selected ? { ...p, ...patch } : p)))
    setPDirty(true)
  }, [selected])

  const addParam = useCallback(() => {
    const base = pDraft[0]
    const n = pDraft.length + 1
    const next: ApcParamConfig = {
      code: `PARAM_${n}`,
      name: `新过程参数 ${n}`,
      process: base ? base.process : '其他',
      unit: base ? base.unit : '',
      decimals: 2,
      setpoint: 1,
      optimalTarget: 1,
      lsl: 0.9,
      usl: 1.1,
      min: 0.5,
      max: 1.5,
      maxStepPct: 3,
      deadbandPct: 10,
      objective: 'quality',
      processGain: 1,
      column: '',
      sim: { sigmaScale: 9, offsetSigma: 0 },
    }
    setPDraft(list => [...list, next])
    setSelected(pDraft.length)
    setPDirty(true)
  }, [pDraft])

  const duplicateParam = useCallback(() => {
    if (!currentParam) return
    const copy: ApcParamConfig = { ...currentParam, code: `${currentParam.code}_COPY`, name: `${currentParam.name}（副本）` }
    setPDraft(list => [...list, copy])
    setSelected(pDraft.length)
    setPDirty(true)
  }, [currentParam, pDraft.length])

  const removeParam = useCallback(() => {
    if (!currentParam) return
    setPDraft(list => list.filter((_, i) => i !== selected))
    setSelected(s => Math.max(0, s - 1))
    setPDirty(true)
  }, [currentParam, selected])

  const applyJson = useCallback(() => {
    setJsonErr('')
    try {
      const parsed = JSON.parse(jsonText)
      if (!Array.isArray(parsed)) throw new Error('JSON 根节点必须是数组（参数列表）')
      setPDraft(parsed as ApcParamConfig[])
      setPDirty(true)
      setSelected(0)
      setJsonMode(false)
    } catch (err: any) {
      setJsonErr(err?.message || String(err))
    }
  }, [jsonText])

  const exportJson = useCallback(() => {
    const text = JSON.stringify(pDraft, null, 2)
    setJsonText(text)
    setJsonMode(true)
    setJsonErr('')
  }, [pDraft])

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-[1100px] h-full bg-mes-bg shadow-2xl overflow-hidden flex flex-col"
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
            </div>
            <div className="text-[11px] text-mes-textTertiary mt-1 leading-relaxed">
              数据库连接与查询限制是公用配置，在侧边栏「数据库管理」页维护；本项目只需选择用哪个数据库系统。
              {config?.configFileError ? ` · 配置文件异常：${config.configFileError}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dirtySections.length > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-600 font-medium">
                {dirtySections.length} 段未保存
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
              <button
                onClick={handleTokenSave}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover"
              >
                保存令牌并重试
              </button>
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
            </button>
          ))}
        </div>

        {/* ===== 提示条 ===== */}
        {notice && (
          <div className={`px-5 py-2 text-xs shrink-0 ${
            notice.kind === 'ok' ? 'bg-green-50 text-green-700 border-b border-green-200' : 'bg-red-50 text-red-700 border-b border-red-200'
          }`}>
            {notice.text}
          </div>
        )}

        {/* ===== 内容 ===== */}
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-10 text-center text-sm text-mes-textTertiary animate-pulse">正在读取配置…</div>}
          {fatal && !loading && (
            <div className="m-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
              读取配置失败：{fatal}
            </div>
          )}
          {config?.configFileError && (
            <div className="mx-5 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
              配置文件存在异常，已按默认值加载：{config.configFileError}
            </div>
          )}
          {config?.catalogError && (
            <div className="mx-5 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700">
              参数目录异常：{config.catalogError}
            </div>
          )}

          {config && tab === 'settings' && (
            <div className="p-5">
              <SectionCard title="项目信息" desc="项目 = 一套完整的监测设置：用哪个数据库、用哪条 SQL 取数、监测哪些参数">
                <div className="grid grid-cols-1 gap-3">
                  <FieldShell label="项目名称" hint="必填；将显示在主页与 APC和RTO 页面">
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
                  <FieldShell label="使用数据库" hint="该项目的参数数据从这个数据库系统读取（连接参数在「数据库管理」页配置）">
                    <div className="flex items-center gap-2">
                      <select
                        value={sDbSlot}
                        onChange={e => { setSDbSlot(e.target.value === 'db2' ? 'db2' : 'db1'); setSDirty(true) }}
                        className={`${inputCls} max-w-[260px]`}
                      >
                        {(config.database.slots.length > 0 ? config.database.slots : [{ id: 'db1', name: '数据库系统 1' }, { id: 'db2', name: '数据库系统 2' }])
                          .map(s => (
                            <option key={s.id} value={s.id}>
                              {s.name}（{s.id}）{'configured' in s && (s as { configured?: boolean }).configured === false ? ' · 未配置' : ''}
                            </option>
                          ))}
                      </select>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        config.database.slots.find(s => s.id === sDbSlot)?.configured
                          ? 'bg-green-50 text-green-700'
                          : 'bg-gray-100 text-mes-textTertiary'
                      }`}>
                        {config.database.slots.find(s => s.id === sDbSlot)?.configured ? '已配置连接' : '尚未配置连接（取数将回退仿真）'}
                      </span>
                    </div>
                  </FieldShell>
                </div>
              </SectionCard>

              {metaDraft && (
                <SectionCard title="目录元信息" desc="全局设置（对所有项目共用）：装置名 / 采样间隔 / 默认统计窗口 / 默认工艺死区">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldShell label="装置/产线名称">
                      <input type="text" value={metaDraft.station} onChange={e => { setMetaDraft({ ...metaDraft, station: e.target.value }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                    <FieldShell label="采样间隔（秒）">
                      <input type="number" min={10} max={86400} value={String(metaDraft.sampleIntervalSec)} onChange={e => { setMetaDraft({ ...metaDraft, sampleIntervalSec: Number(e.target.value) }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                    <FieldShell label="默认统计窗口（分钟）">
                      <input type="number" min={5} max={1440} value={String(metaDraft.defaultWindowMinutes)} onChange={e => { setMetaDraft({ ...metaDraft, defaultWindowMinutes: Number(e.target.value) }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                    <FieldShell label="默认工艺死区（%）">
                      <input type="number" min={0} max={100} value={String(metaDraft.deadbandPctDefault)} onChange={e => { setMetaDraft({ ...metaDraft, deadbandPctDefault: Number(e.target.value) }); setMetaDirty(true) }} className={inputCls} />
                    </FieldShell>
                  </div>
                </SectionCard>
              )}
            </div>
          )}

          {config && tab === 'queries' && (
            <QueriesTab
              effective={origQueries}
              draft={qDraft}
              params={pDraft}
              locked={locked}
              sqlRef={sqlRef}
              dirty={qDirty}
              onDraft={patch => { setQDraft(d => ({ ...d, ...patch })); setQDirty(true); setPreview(null) }}
              onColumns={patch => { setQDraft(d => ({ ...d, columns: { ...d.columns, ...patch } })); setQDirty(true) }}
              onInsert={insertPlaceholder}
              previewing={previewing}
              preview={preview}
              previewErr={previewErr}
              previewRows={previewRows}
              onPreviewRows={setPreviewRows}
              onPreview={handlePreview}
              onReset={() => handleReset('queries')}
            />
          )}

          {config && tab === 'params' && (
            <ParamsTab
              params={pDraft}
              selected={selected}
              current={currentParam}
              locked={locked}
              jsonMode={jsonMode}
              jsonText={jsonText}
              jsonErr={jsonErr}
              meta={metaDraft}
              dbSlotLabel={sDbSlot === 'db2' ? '数据库系统 2' : '数据库系统 1'}
              onSelect={setSelected}
              onPatch={patchParam}
              onAdd={addParam}
              onDuplicate={duplicateParam}
              onRemove={removeParam}
              onToggleJson={() => { setJsonText(JSON.stringify(pDraft, null, 2)); setJsonMode(m => !m); setJsonErr('') }}
              onExportJson={exportJson}
              onJsonText={setJsonText}
              onApplyJson={applyJson}
              onReset={() => handleReset('params')}
            />
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
                onClick={handleDelete}
                disabled={deleting || saving}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {deleting ? '删除中…' : '删除项目'}
              </button>
            )}
            <button
              onClick={load}
              disabled={dirtySections.length === 0 || saving}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50"
            >
              放弃改动
            </button>
            <button
              onClick={handleSave}
              disabled={dirtySections.length === 0 || saving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover disabled:opacity-50"
            >
              {saving && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              )}
              {isNew ? '创建项目' : `保存${dirtySections.length > 0 ? `（${dirtySections.length} 段）` : ''}`}
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
  children: React.ReactNode
  actions?: React.ReactNode
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
  children: React.ReactNode
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

const inputCls = 'w-full text-xs px-2.5 py-1.5 rounded-lg border border-mes-border bg-white text-mes-text focus:outline-none focus:border-mes-primary'
const btnGhost = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50'
const btnPrimary = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover disabled:opacity-50'
const btnDanger = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50'

// ===== ① 项目设置（在主组件内渲染，无需独立 Tab 组件） =====


function QueriesTab({
  effective, draft, params, locked, sqlRef, dirty, onDraft, onColumns, onInsert,
  previewing, preview, previewErr, previewRows, onPreviewRows, onPreview, onReset,
}: {
  /** 载入时的原始模板（未改动时用于显示「当前生效」提示） */
  effective: ApcQueryConfig | null
  draft: ApcQueryConfig
  params: ApcParamConfig[]
  locked: boolean
  sqlRef: React.RefObject<HTMLTextAreaElement>
  dirty: boolean
  onDraft: (patch: Partial<ApcQueryConfig>) => void
  onColumns: (patch: Partial<ApcQueryConfig['columns']>) => void
  onInsert: (token: string) => void
  previewing: boolean
  preview: ApcQueryPreview | null
  previewErr: string
  previewRows: number
  onPreviewRows: (n: number) => void
  onPreview: () => void
  onReset: () => void
}) {
  const wide = draft.mode === 'wide'
  const missingColumn = wide ? params.filter(p => !p.column || !String(p.column).trim()).map(p => p.code) : []

  function assign(column: string, target: 'code' | 'ts' | 'value') {
    onColumns({ [target]: column })
  }

  return (
    <div className="p-5">
      {locked && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 mb-4 text-[11px] text-amber-800 leading-relaxed">
          当前由环境变量 <span className="font-mono">APC_CATALOG_FILE</span> 指定参数目录文件，页面上的保存不会生效。
          如需在页面维护取数 SQL，请移除该环境变量后重启服务。
        </div>
      )}

      <SectionCard title="取数模式" desc="决定 SQL 返回的是「一行一个参数值」还是「一行一个时间戳」">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { key: 'long' as const, title: '窄表（一行一个参数值）', desc: '常见于历史库 TAG 表。SQL 需返回编码列、时间列、数值列；服务端用编码过滤参数。' },
            { key: 'wide' as const, title: '宽表（一行一个时间戳）', desc: '一行包含多个参数列。SQL 用 {{columns}} 展开各参数列名，参数配置里逐个填列名。' },
          ].map(o => (
            <label
              key={o.key}
              className={`rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                draft.mode === o.key ? 'border-mes-primary bg-mes-tagBg/40' : 'border-mes-border hover:border-mes-primary/40'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={draft.mode === o.key}
                  onChange={() => onDraft({ mode: o.key })}
                  className="accent-mes-primary"
                />
                <span className="text-xs font-medium text-mes-text">{o.title}</span>
              </div>
              <div className="text-[10px] text-mes-textTertiary mt-1 leading-relaxed">{o.desc}</div>
            </label>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="取数 SQL 模板"
        desc="只允许单条 SELECT / WITH；DDL、DML、多语句、SELECT INTO 等在保存与执行前都会被拒绝"
        actions={<button onClick={onReset} disabled={locked} className={btnGhost}>恢复默认模板</button>}
      >
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {PLACEHOLDERS.map(p => (
            <button
              key={p.token}
              onClick={() => onInsert(p.token)}
              title={p.desc}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-mes-border bg-gray-50 text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary"
            >
              {p.token}
            </button>
          ))}
          <span className="text-[10px] text-mes-textTertiary ml-1">点击插入到光标处</span>
        </div>
        <textarea
          ref={sqlRef}
          value={draft.history}
          onChange={e => onDraft({ history: e.target.value })}
          rows={7}
          spellCheck={false}
          className="w-full text-[11px] font-mono leading-relaxed px-3 py-2 rounded-lg border border-mes-border bg-gray-50 text-mes-text focus:outline-none focus:border-mes-primary resize-y"
          placeholder={`例如：SELECT "PARAM_CODE", "TS", "VALUE" FROM "MES_PROCESS_HIST" WHERE "TS" >= ADD_SECONDS(CURRENT_TIMESTAMP, -60 * {{minutes}}){{codeFilter}} ORDER BY "TS" LIMIT {{limit}}`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="text-[11px] text-mes-textSecondary">
            试运行行数
            <input
              type="number"
              min={1}
              max={200}
              value={previewRows}
              onChange={e => onPreviewRows(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
              className="ml-1.5 w-16 text-[11px] px-2 py-1 rounded border border-mes-border bg-white focus:outline-none focus:border-mes-primary"
            />
          </label>
          <button onClick={onPreview} disabled={previewing || !draft.history.trim()} className={btnPrimary}>
            {previewing ? '正在执行…' : '试运行（只读）'}
          </button>
          <span className="text-[10px] text-mes-textTertiary">
            试运行会真实执行一次只读查询，用当前草稿（未保存）的参数，不会改动配置
          </span>
        </div>
      </SectionCard>

      <SectionCard
        title="字段映射"
        desc={wide
          ? '宽表模式只需指定时间戳列；每个参数的取值列在「参数配置」里填写'
          : '窄表模式需指定：哪一列是参数编码、哪一列是时间戳、哪一列是数值'}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {!wide && (
            <FieldShell label="参数编码列" hint="值需与参数配置里的编码一致">
              <input type="text" value={draft.columns.code || ''} onChange={e => onColumns({ code: e.target.value })} className={inputCls} placeholder="如 PARAM_CODE" />
            </FieldShell>
          )}
          <FieldShell label="时间戳列" hint="支持时间类型或可解析的时间字符串">
            <input type="text" value={draft.columns.ts || ''} onChange={e => onColumns({ ts: e.target.value })} className={inputCls} placeholder="如 TS" />
          </FieldShell>
          {!wide && (
            <FieldShell label="数值列" hint="存储过程参数实测值的列">
              <input type="text" value={draft.columns.value || ''} onChange={e => onColumns({ value: e.target.value })} className={inputCls} placeholder="如 VALUE" />
            </FieldShell>
          )}
        </div>

        {wide && missingColumn.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
            以下参数还没填数据列名，保存会被拒绝：{missingColumn.join('、')}。请到「参数配置」逐个填写。
          </div>
        )}

        {preview && preview.columns.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] text-mes-textSecondary mb-1.5">检测到 {preview.columns.length} 个返回列，点一下即可指派为映射列：</div>
            <div className="flex flex-wrap gap-1.5">
              {preview.columns.map(col => (
                <span key={col} className="inline-flex items-center gap-1 rounded-lg border border-mes-border bg-gray-50 pl-2 pr-1 py-1">
                  <span className="text-[10px] font-mono text-mes-textSecondary">{col}</span>
                  {!wide && (
                    <>
                      <button onClick={() => assign(col, 'code')} className="text-[10px] px-1 py-0.5 rounded hover:bg-blue-50 hover:text-blue-600 text-mes-textTertiary">编码列</button>
                      <button onClick={() => assign(col, 'value')} className="text-[10px] px-1 py-0.5 rounded hover:bg-blue-50 hover:text-blue-600 text-mes-textTertiary">数值列</button>
                    </>
                  )}
                  <button onClick={() => assign(col, 'ts')} className="text-[10px] px-1 py-0.5 rounded hover:bg-blue-50 hover:text-blue-600 text-mes-textTertiary">时间列</button>
                </span>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      {previewErr && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 leading-relaxed">
          <div className="font-medium mb-1">试运行失败</div>
          <div>{previewErr}</div>
        </div>
      )}

      {preview && (
        <SectionCard
          title="试运行结果"
          desc={`${preview.rowCount} 行 · 耗时 ${preview.elapsedMs} ms${preview.truncated ? ' · 已按上限截断' : ''}${preview.mode === 'wide' ? ' · 宽表模式' : ' · 窄表模式'}`}
        >
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
      )}

      {dirty && (
        <div className="text-[11px] text-orange-600">取数配置有未保存的改动，确认无误后点右下角「保存」。</div>
      )}
      {!dirty && effective && (
        <div className="text-[11px] text-mes-textTertiary">
          当前生效：{effective.mode === 'wide' ? '宽表' : '窄表'}模式
          {effective.columns.ts ? ` · 时间列 ${effective.columns.ts}` : ''}
          {effective.columns.code ? ` · 编码列 ${effective.columns.code}` : ''}
          {effective.columns.value ? ` · 数值列 ${effective.columns.value}` : ''}
        </div>
      )}
    </div>
  )
}

// ===== ③ 参数配置 =====

function ParamsTab({
  params, selected, current, locked, jsonMode, jsonText, jsonErr, meta, dbSlotLabel,
  onSelect, onPatch, onAdd, onDuplicate, onRemove, onToggleJson, onExportJson, onJsonText, onApplyJson, onReset,
}: {
  params: ApcParamConfig[]
  selected: number
  current: ApcParamConfig | null
  locked: boolean
  jsonMode: boolean
  jsonText: string
  jsonErr: string
  meta: ApcConfigResponse['meta'] | null
  /** 项目绑定的数据库显示名（参数数据统一取自该系统） */
  dbSlotLabel: string
  onSelect: (i: number) => void
  onPatch: (patch: Partial<ApcParamConfig>) => void
  onAdd: () => void
  onDuplicate: () => void
  onRemove: () => void
  onToggleJson: () => void
  onExportJson: () => void
  onJsonText: (t: string) => void
  onApplyJson: () => void
  onReset: () => void
}) {
  const numField = (
    label: string, key: keyof ApcParamConfig, hint?: string, step = 'any'
  ) => (
    <FieldShell label={label} hint={hint}>
      <input
        type="number"
        step={step}
        value={current ? String(current[key] ?? '') : ''}
        onChange={e => onPatch({ [key]: e.target.value === '' ? 0 : Number(e.target.value) } as Partial<ApcParamConfig>)}
        className={inputCls}
        disabled={!current}
      />
    </FieldShell>
  )

  return (
    <div className="p-5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold text-mes-text">
          过程参数<span className="ml-1.5 text-[11px] font-normal text-mes-textTertiary">{params.length} 个</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onToggleJson} className={btnGhost}>{jsonMode ? '返回表单' : 'JSON 批量编辑'}</button>
          <button onClick={onExportJson} className={btnGhost}>导出为 JSON</button>
          <button onClick={onReset} disabled={locked} className={btnGhost}>清空参数</button>
        </div>
      </div>

      {jsonMode ? (
        <SectionCard title="JSON 批量编辑" desc="直接粘贴参数数组；点「应用」后需再点右下角「保存」才会落盘">
          <textarea
            value={jsonText}
            onChange={e => onJsonText(e.target.value)}
            rows={20}
            spellCheck={false}
            className="w-full text-[11px] font-mono leading-relaxed px-3 py-2 rounded-lg border border-mes-border bg-gray-50 text-mes-text focus:outline-none focus:border-mes-primary resize-y"
          />
          {jsonErr && <div className="mt-2 text-[11px] text-red-600">JSON 解析失败：{jsonErr}</div>}
          <div className="mt-2 flex items-center gap-2">
            <button onClick={onApplyJson} className={btnPrimary}>应用 JSON</button>
            <span className="text-[10px] text-mes-textTertiary">应用只是写入草稿，仍需保存才生效</span>
          </div>
        </SectionCard>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-3">
          {/* 参数列表 */}
          <div className="rounded-xl border border-mes-border bg-white overflow-hidden">
            <div className="px-3 py-2 border-b border-mes-border bg-gray-50/60 flex items-center justify-between">
              <span className="text-[11px] font-medium text-mes-textSecondary">参数列表</span>
              <div className="flex items-center gap-1">
                <button onClick={onAdd} disabled={locked} title="新增参数" className="px-1.5 py-0.5 rounded text-[11px] text-mes-primary hover:bg-mes-tagBg disabled:opacity-40">＋</button>
                <button onClick={onDuplicate} disabled={locked || !current} title="复制当前参数" className="px-1.5 py-0.5 rounded text-[11px] text-mes-textSecondary hover:bg-gray-100 disabled:opacity-40">⧉</button>
                <button onClick={onRemove} disabled={locked || !current || params.length <= 1} title="删除当前参数" className="px-1.5 py-0.5 rounded text-[11px] text-red-500 hover:bg-red-50 disabled:opacity-40">✕</button>
              </div>
            </div>
            <div className="max-h-[460px] overflow-y-auto">
              {params.map((p, i) => (
                <button
                  key={`${p.code}-${i}`}
                  onClick={() => onSelect(i)}
                  className={`w-full text-left px-3 py-2 border-b border-mes-border/60 transition-colors ${
                    i === selected ? 'bg-mes-tagBg/50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="text-xs font-medium text-mes-text truncate">{p.name || p.code}</div>
                  <div className="text-[10px] text-mes-textTertiary truncate">
                    {p.process} · {p.code}
                    {p.column ? ` · 列 ${p.column}` : ''}
                    {` · ${p.dbSlot === 'db2' ? '库2' : '库1'}`}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 参数表单 */}
          <div>
            {!current && (
              <div className="rounded-xl border border-mes-border bg-white px-4 py-10 text-center text-xs text-mes-textTertiary">
                请选择左侧参数，或点「＋」新增一个
              </div>
            )}
            {current && (
              <>
                <SectionCard title="标识" desc="编码会参与 SQL 白名单拼接，只允许字母/数字/下划线">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldShell label="参数编码" hint="必填；与库中记录编码一致">
                      <input type="text" value={current.code} onChange={e => onPatch({ code: e.target.value })} className={`${inputCls} font-mono`} disabled={locked} />
                    </FieldShell>
                    <FieldShell label="参数名称">
                      <input type="text" value={current.name} onChange={e => onPatch({ name: e.target.value })} className={inputCls} disabled={locked} />
                    </FieldShell>
                    <FieldShell label="所属工序">
                      <input type="text" value={current.process} onChange={e => onPatch({ process: e.target.value })} className={inputCls} disabled={locked} />
                    </FieldShell>
                    <FieldShell label="单位">
                      <input type="text" value={current.unit} onChange={e => onPatch({ unit: e.target.value })} className={inputCls} disabled={locked} />
                    </FieldShell>
                    <FieldShell label="使用数据库" hint="项目绑定的数据库系统（在「项目设置」里修改，全部参数统一使用）">
                      <input type="text" value={dbSlotLabel} className={inputCls} disabled />
                    </FieldShell>
                    {meta && (
                      <FieldShell label="宽表数据列名" hint="仅宽表取数模式需要；窄表模式留空">
                        <input type="text" value={current.column || ''} onChange={e => onPatch({ column: e.target.value })} className={`${inputCls} font-mono`} disabled={locked} placeholder="如 TAG_WINDING_TENSION" />
                      </FieldShell>
                    )}
                    <FieldShell label="小数位">
                      <input type="number" min={0} max={6} value={String(current.decimals)} onChange={e => onPatch({ decimals: Number(e.target.value) })} className={inputCls} disabled={locked} />
                    </FieldShell>
                  </div>
                </SectionCard>

                <SectionCard title="目标与规格" desc="RTO 理想操作点是寻优目标；规格上下限用于过程能力（Cpk）判定">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {numField('当前设定值', 'setpoint', '现场 DCS/PLC 上的设定值')}
                    {numField('RTO 理想操作点', 'optimalTarget', '该工况下的最优目标值')}
                    {numField('规格下限 LSL', 'lsl')}
                    {numField('规格上限 USL', 'usl')}
                  </div>
                </SectionCard>

                <SectionCard title="可调范围与算法" desc="约束优化结果，避免单次调整过大或超出工艺窗口">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {numField('可调下限', 'min')}
                    {numField('可调上限', 'max')}
                    {numField('单次调整上限（%）', 'maxStepPct', '超过则分步逼近')}
                    {numField('工艺死区（%）', 'deadbandPct', '占规格带宽比例，缺省用目录默认值')}
                    {numField('过程增益 K', 'processGain', '衡量 设定值变化 / 实测变化 的比例，默认 1')}
                    <FieldShell label="优化目标">
                      <select value={current.objective} onChange={e => onPatch({ objective: e.target.value })} className={inputCls} disabled={locked}>
                        {OBJECTIVE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}（{o.value}）</option>)}
                      </select>
                    </FieldShell>
                  </div>
                  <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-[10px] text-mes-textTertiary leading-relaxed">
                    建议值 = 当前设定值 +（理想操作点 − 实测均值）/ 过程增益，
                    再依次做可调范围裁剪、单次限幅、按小数位取整；偏差落在工艺死区内且过程能力正常时建议保持不动。
                  </div>
                </SectionCard>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
