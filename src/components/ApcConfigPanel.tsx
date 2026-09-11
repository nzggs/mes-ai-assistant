// 「APC 和 RTO」数据源配置面板
//
// 三个可手工灵活配置的窗口：
//   ① 数据库登录     —— 连接参数 + 测试连接 + 密码保持/清除，保存后立即生效（无需重启）
//   ② SQL 查询语句   —— 窄表/宽表两种取数模式、SQL 模板与占位符、字段映射、试运行预览
//   ③ 参数配置       —— 过程参数逐个编辑 / 增删 / JSON 批量导入导出，含目录元信息
//
// 全部接口在服务端挂 requireAdmin，需带 X-Admin-Token；
// 密码只进不出：读取回来的配置里没有密码原文，只有「是否已保存」。
// 配置落在服务端数据卷（不入 git），任何配置改动都要过只读护栏与结构校验。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchApcConfig,
  saveApcConfig,
  resetApcConfig,
  testApcDatabase,
  previewApcQuery,
  setAdminToken,
  hasAdminToken,
  type ApcConfigSection,
} from '../services/apcApi'
import type {
  ApcConfigResponse,
  ApcDatabaseDraft,
  ApcParamConfig,
  ApcQueryConfig,
  ApcQueryPreview,
  ApcTestDbResult,
} from '../types'

type TabKey = 'database' | 'queries' | 'params'

const TABS: { key: TabKey; label: string; desc: string }[] = [
  { key: 'database', label: '数据库登录', desc: '只读库连接参数' },
  { key: 'queries', label: 'SQL 查询语句', desc: '取数模板与字段映射' },
  { key: 'params', label: '参数配置', desc: '过程参数目录' },
]

const DB_TEXT_FIELDS: { key: keyof ApcDatabaseDraft; label: string; placeholder: string; hint: string }[] = [
  { key: 'host', label: '数据库地址', placeholder: '如 10.0.0.21', hint: 'HANA 主机名或 IP；地址与用户名齐备即视为已配置数据源' },
  { key: 'user', label: '用户名', placeholder: '如 READONLY_APC', hint: '务必使用仅授予 SELECT 权限的只读账号，不要复用管理员账号' },
  { key: 'databaseName', label: '租户库名', placeholder: '单库实例可留空', hint: 'MDC 多租户场景填写租户库名；单库实例留空' },
  { key: 'schema', label: '模式名 Schema', placeholder: '可留空，供 {{schema}} 使用', hint: '填写后会作为 SQL 模板里 {{schema}} 占位符的值' },
  { key: 'caFile', label: 'CA 证书路径', placeholder: '仅启用 TLS 且需校验时填写', hint: '需是容器内可访问的路径（已挂载到镜像里）' },
]

const DB_NUM_FIELDS: { key: keyof ApcDatabaseDraft; label: string; min: number; max: number; hint: string }[] = [
  { key: 'port', label: '端口', min: 1, max: 65535, hint: 'HANA SQL 端口，默认 30015' },
  { key: 'maxRows', label: '单次读取行数上限', min: 1, max: 20000, hint: '硬保护：任何一次取数都不会超过该行数' },
  { key: 'connectTimeoutMs', label: '连接超时（ms）', min: 1000, max: 60000, hint: '超时立刻放弃连接，不给数据库留挂起会话' },
  { key: 'statementTimeoutMs', label: '语句超时（ms）', min: 1000, max: 120000, hint: '查询超时即断开连接，释放数据库会话' },
]

const DB_BOOL_FIELDS: { key: keyof ApcDatabaseDraft; label: string; hint: string }[] = [
  { key: 'useTLS', label: '启用 TLS', hint: '生产环境建议开启' },
  { key: 'validateCert', label: '校验证书', hint: '使用自签证书的内网环境可关闭' },
  { key: 'useLimit', label: '自动追加 LIMIT', hint: '少数老版本 HANA 不支持 LIMIT 时可关闭' },
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

export function ApcConfigPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState<TabKey>('database')
  const [config, setConfig] = useState<ApcConfigResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState('')
  const [needsToken, setNeedsToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 各段草稿与脏标记（数据库按槽位 db1/db2 分别保存，可手动切换使用哪个）
  const [dbEditId, setDbEditId] = useState<string>('db1')
  const [dbDrafts, setDbDrafts] = useState<Record<string, ApcDatabaseDraft>>({})
  const [dbActiveId, setDbActiveId] = useState<string>('db1')
  const [dbDirty, setDbDirty] = useState(false)
  const [pwInputs, setPwInputs] = useState<Record<string, string>>({})
  const [clearPwFlags, setClearPwFlags] = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<ApcTestDbResult | null>(null)
  const [testing, setTesting] = useState(false)

  const [qDraft, setQDraft] = useState<ApcQueryConfig>({ mode: 'long', history: '', columns: {} })
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
  const sqlRef = useRef<HTMLTextAreaElement>(null)

  // ===== 载入 =====
  const applyConfig = useCallback((c: ApcConfigResponse) => {
    setConfig(c)
    setDbDrafts(Object.fromEntries(c.database.slots.map(s => [s.id, { ...s.values }])))
    setDbEditId(c.database.activeId)
    setDbActiveId(c.database.activeId)
    setPwInputs({})
    setClearPwFlags({})
    setDbDirty(false)
    setQDraft(c.queries ? { ...c.queries, columns: { ...c.queries.columns } } : { mode: 'long', history: '', columns: {} })
    setPDraft(c.params.map(p => ({ ...p })))
    setMetaDraft(c.meta ? { ...c.meta } : null)
    setDbDirty(false)
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
      applyConfig(c)
      setNeedsToken(false)
    } catch (err: any) {
      if (err?.status === 403) setNeedsToken(true)
      else setFatal(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [applyConfig])

  useEffect(() => { load() }, [load])

  const locked = Boolean(config?.catalogFileLocked)
  const dirtySections = useMemo(() => {
    const out: ApcConfigSection[] = []
    if (dbDirty) out.push('database')
    if (qDirty) out.push('queries')
    if (pDirty) out.push('params')
    if (metaDirty) out.push('meta')
    return out
  }, [dbDirty, qDirty, pDirty, metaDirty])

  // ===== 保存 / 重置 =====
  const handleSave = useCallback(async () => {
    if (dirtySections.length === 0) return
    setSaving(true)
    setNotice(null)
    try {
      const patch: Record<string, unknown> = {}
      if (dbDirty) {
        const id = dbEditId
        const db: ApcDatabaseDraft = { ...(dbDrafts[id] || {}) }
        if (clearPwFlags[id]) db.password = null
        else if (pwInputs[id]) db.password = pwInputs[id]
        else delete db.password
        patch.databases = { [id]: db }
      }
      if (dbActiveId !== config?.database.activeId) patch.activeDatabase = dbActiveId
      if (qDirty) patch.queries = qDraft
      if (pDirty) patch.params = pDraft
      if (metaDirty && metaDraft) patch.meta = metaDraft

      const res = await saveApcConfig(patch)
      applyConfig(res.config)
      setNotice({ kind: 'ok', text: `已保存：${res.saved.map(s => TABS.find(t => t.key === s)?.label || s).join('、')}；配置已生效（缓存与数据库连接已刷新）` })
      onSaved()
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setSaving(false)
    }
  }, [dirtySections, dbDirty, dbEditId, dbDrafts, pwInputs, clearPwFlags, dbActiveId, config, qDirty, qDraft, pDirty, pDraft, metaDirty, metaDraft, applyConfig, onSaved])

  const handleReset = useCallback(async (section: ApcConfigSection, databaseId?: string) => {
    setSaving(true)
    setNotice(null)
    try {
      const res = await resetApcConfig(section, databaseId)
      applyConfig(res.config)
      setNotice({ kind: 'ok', text: `已恢复默认：${TABS.find(t => t.key === section)?.label || section}` })
      onSaved()
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setSaving(false)
    }
  }, [applyConfig, onSaved])

  /** 切换「当前使用」的数据库系统（下次取数 / 测试均走该槽位） */
  const handleSetActive = useCallback(async (id: string) => {
    setSaving(true)
    setNotice(null)
    try {
      const res = await saveApcConfig({ activeDatabase: id })
      setDbActiveId(id)
      applyConfig(res.config)
      const name = res.config.database.slots.find(s => s.id === id)?.name || id
      setNotice({ kind: 'ok', text: `已切换当前使用的数据源为「${name}」（配置已生效）` })
      onSaved()
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setSaving(false)
    }
  }, [applyConfig, onSaved])

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    setNotice(null)
    try {
      const id = dbEditId
      const db: ApcDatabaseDraft = { ...(dbDrafts[id] || {}) }
      if (!clearPwFlags[id] && pwInputs[id]) db.password = pwInputs[id]
      if (clearPwFlags[id]) db.password = null
      setTestResult(await testApcDatabase(db, id))
    } catch (err: any) {
      setTestResult({ ok: false, elapsedMs: 0, error: err?.message || String(err), target: { host: '', port: 0, user: '', databaseName: '', schema: '', useTLS: false, validateCert: true } })
    } finally {
      setTesting(false)
    }
  }, [dbEditId, dbDrafts, clearPwFlags, pwInputs])

  const handlePreview = useCallback(async () => {
    setPreviewing(true)
    setPreviewErr('')
    setPreview(null)
    try {
      setPreview(await previewApcQuery({ queries: qDraft, params: pDraft, minutes: previewRows > 0 ? 120 : 120, maxRows: previewRows }))
    } catch (err: any) {
      setPreviewErr(err?.message || String(err))
    } finally {
      setPreviewing(false)
    }
  }, [qDraft, pDraft, previewRows])

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
              <h2 className="text-base font-semibold text-mes-text">数据源配置</h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-mes-tagBg text-mes-tagText font-medium">
                手工配置 · 保存即生效
              </span>
              {locked && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium">
                  参数目录已由 APC_CATALOG_FILE 锁定
                </span>
              )}
            </div>
            <div className="text-[11px] text-mes-textTertiary mt-1 leading-relaxed">
              配置文件：<span className="font-mono">{config?.configFile || '—'}</span>
              {config?.updatedAt ? ` · 最近保存 ${fmtTime(config.updatedAt)}` : ' · 尚未保存过任何改动'}
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

          {config && tab === 'database' && (
            <DatabaseTab
              config={config}
              dbEditId={dbEditId}
              dbActiveId={dbActiveId}
              drafts={dbDrafts}
              pwInputs={pwInputs}
              clearPwFlags={clearPwFlags}
              onSwitchSlot={setDbEditId}
              onDraft={patch => { setDbDrafts(d => ({ ...d, [dbEditId]: { ...(d[dbEditId] || {}), ...patch } })); setDbDirty(true) }}
              onPassword={v => { setPwInputs(p => ({ ...p, [dbEditId]: v })); setDbDirty(true) }}
              onClearPassword={v => { setClearPwFlags(f => ({ ...f, [dbEditId]: v })); setDbDirty(true) }}
              onSetActive={handleSetActive}
              testing={testing}
              testResult={testResult}
              onTest={handleTest}
              onReset={(id) => handleReset('database', id)}
              saving={saving}
            />
          )}

          {config && tab === 'queries' && (
            <QueriesTab
              config={config}
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
              onSelect={setSelected}
              onPatch={patchParam}
              onAdd={addParam}
              onDuplicate={duplicateParam}
              onRemove={removeParam}
              onToggleJson={() => { setJsonText(JSON.stringify(pDraft, null, 2)); setJsonMode(m => !m); setJsonErr('') }}
              onExportJson={exportJson}
              onJsonText={setJsonText}
              onApplyJson={applyJson}
              onMeta={patch => { setMetaDraft(m => (m ? { ...m, ...patch } : m)); setMetaDirty(true) }}
              onReset={() => handleReset('params')}
            />
          )}
        </div>

        {/* ===== 底部操作 ===== */}
        <div className="bg-white border-t border-mes-border px-5 py-3 flex items-center justify-between gap-3 shrink-0">
          <div className="text-[11px] text-mes-textTertiary leading-relaxed">
            只读边界不变：无论怎么改配置，取数只可能是单条 SELECT，且强制行数上限与语句超时；
            账号密码只保存在服务端数据卷（不入 git），页面不回显密码。
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { if (config) applyConfig(config) }}
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
              保存{dirtySections.length > 0 ? `（${dirtySections.length} 段）` : ''}
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

// ===== ① 数据库登录 =====

function DatabaseTab({
  config, dbEditId, dbActiveId, drafts, pwInputs, clearPwFlags,
  onSwitchSlot, onDraft, onPassword, onClearPassword, onSetActive,
  testing, testResult, onTest, onReset, saving,
}: {
  config: ApcConfigResponse
  dbEditId: string
  dbActiveId: string
  drafts: Record<string, ApcDatabaseDraft>
  pwInputs: Record<string, string>
  clearPwFlags: Record<string, boolean>
  onSwitchSlot: (id: string) => void
  onDraft: (patch: ApcDatabaseDraft) => void
  onPassword: (v: string) => void
  onClearPassword: (v: boolean) => void
  onSetActive: (id: string) => void
  testing: boolean
  testResult: ApcTestDbResult | null
  onTest: () => void
  onReset: (id: string) => void
  saving: boolean
}) {
  const { envValues, defaults, envConfigured } = config.database
  const slot = config.database.slots.find(s => s.id === dbEditId) || config.database.slots[0]
  const draft = drafts[dbEditId] || {}
  const pwInput = pwInputs[dbEditId] || ''
  const clearPw = Boolean(clearPwFlags[dbEditId])
  const passwordSet = slot.passwordSet
  const savedKeys = slot.savedKeys

  function sourceOf(key: string): string {
    if (savedKeys.includes(key)) return '页面配置'
    const v = (envValues as Record<string, unknown>)[key]
    if (v !== undefined && v !== null && v !== '') return '环境变量'
    return '默认值'
  }

  function envHint(key: string): string | undefined {
    const v = (envValues as Record<string, unknown>)[key]
    if (v === undefined || v === null || v === '') return undefined
    if (String(v) === String((draft as Record<string, unknown>)[key])) return undefined
    return `环境变量当前取值：${String(v)}`
  }

  return (
    <div className="p-5">
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 mb-4 text-[11px] text-blue-800 leading-relaxed">
        <div className="font-medium mb-1">只读接入说明</div>
        这里填写的是<b>只读账号</b>（仅授予 SELECT）。保存后立即生效、无需重启服务；账号密码只写入服务端数据卷
        <span className="font-mono mx-1">{config.configFile}</span>，不会进入 git，也不会回显到页面。
        {envConfigured && <div className="mt-1">检测到环境变量里也有连接配置：<b>页面保存值优先</b>；如需回退，点下方「清空本系统」。</div>}
        <div className="mt-1">本系统支持接入 <b>两个数据库系统</b>（db1 / db2），可分别配置后在下方手动切换「当前使用」的数据源；SQL 取数模板与监测项两个系统共享。</div>
      </div>

      {/* 两个数据库系统分页 */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {config.database.slots.map(s => (
          <button
            key={s.id}
            onClick={() => onSwitchSlot(s.id)}
            className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
              dbEditId === s.id
                ? 'border-mes-primary bg-white text-mes-primary shadow-sm'
                : 'border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary/40'
            }`}
          >
            <span className="inline-flex items-center gap-2">
              {s.name || s.id}
              {dbActiveId === s.id
                ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">当前使用</span>
                : !s.configured
                  ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-mes-textTertiary">未配置</span>
                  : null}
            </span>
          </button>
        ))}
      </div>

      {/* 当前编辑系统的名称 + 切换为当前使用 */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <input
          type="text"
          value={String((draft as Record<string, unknown>).name ?? slot.name ?? '')}
          placeholder="数据库系统显示名（如 一厂HANA / 二厂HANA）"
          onChange={e => onDraft({ name: e.target.value } as ApcDatabaseDraft)}
          className={`${inputCls} max-w-[360px]`}
        />
        {dbActiveId === dbEditId ? (
          <span className="text-[11px] px-2.5 py-1 rounded-full bg-green-50 text-green-700 font-medium whitespace-nowrap">✓ 当前正在使用此系统</span>
        ) : (
          <button
            onClick={() => onSetActive(dbEditId)}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover disabled:opacity-50 whitespace-nowrap"
          >
            切换为当前使用
          </button>
        )}
      </div>

      <SectionCard
        title="连接与账号"
        desc="地址与用户名齐备即视为已配置数据源；未配置时页面回退到内置仿真数据源"
        actions={
          <>
            <button onClick={onTest} disabled={testing} className={btnGhost}>
              {testing ? '正在测试…' : '测试连接'}
            </button>
            <button onClick={() => onReset(dbEditId)} disabled={saving || savedKeys.length === 0} className={btnGhost}>
              清空本系统
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3">
          {DB_TEXT_FIELDS.map(f => (
            <FieldShell key={String(f.key)} label={f.label} source={sourceOf(String(f.key))} hint={envHint(String(f.key)) || f.hint}>
              <input
                type="text"
                value={String((draft as Record<string, unknown>)[String(f.key)] ?? '')}
                placeholder={f.placeholder}
                onChange={e => onDraft({ [f.key]: e.target.value } as ApcDatabaseDraft)}
                className={inputCls}
              />
            </FieldShell>
          ))}

          <FieldShell
            label="密码"
            source={savedKeys.includes('password') ? '页面配置' : (envValues.passwordSet ? '环境变量' : '未设置')}
            hint={passwordSet ? '服务端已保存密码；留空表示不修改，勾选下方选项可清除' : '当前没有可用密码，请填写'}
          >
            <input
              type="password"
              value={pwInput}
              disabled={clearPw}
              onChange={e => onPassword(e.target.value)}
              placeholder={passwordSet ? '••••••（留空表示不修改）' : '请输入只读账号密码'}
              className={`${inputCls} ${clearPw ? 'opacity-50' : ''}`}
              autoComplete="new-password"
            />
            <label className="flex items-center gap-1.5 mt-1.5 text-[11px] text-mes-textSecondary cursor-pointer">
              <input type="checkbox" checked={clearPw} onChange={e => onClearPassword(e.target.checked)} className="accent-mes-primary" />
              清除已保存的密码
            </label>
          </FieldShell>
        </div>
      </SectionCard>

      <SectionCard title="连接与读取保护" desc="限制单次读取规模与执行时长，避免把生产库拖垮">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3">
          {DB_NUM_FIELDS.map(f => (
            <FieldShell key={String(f.key)} label={f.label} source={sourceOf(String(f.key))} hint={`${f.hint}（范围 ${f.min} ~ ${f.max}）`}>
              <input
                type="number"
                value={String((draft as Record<string, unknown>)[String(f.key)] ?? '')}
                min={f.min}
                max={f.max}
                onChange={e => {
                  const raw = e.target.value
                  onDraft({ [f.key]: raw === '' ? '' : Number(raw) } as ApcDatabaseDraft)
                }}
                className={inputCls}
              />
            </FieldShell>
          ))}
          <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {DB_BOOL_FIELDS.map(f => (
              <label key={String(f.key)} className="flex items-start gap-2 rounded-lg border border-mes-border px-3 py-2 cursor-pointer hover:border-mes-primary/40">
                <input
                  type="checkbox"
                  checked={Boolean((draft as Record<string, unknown>)[String(f.key)])}
                  onChange={e => onDraft({ [f.key]: e.target.checked } as ApcDatabaseDraft)}
                  className="accent-mes-primary mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-[11px] font-medium text-mes-textSecondary">{f.label}</span>
                  <span className="block text-[10px] text-mes-textTertiary leading-relaxed">{f.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="mt-3 text-[10px] text-mes-textTertiary leading-relaxed">
          默认值参考：端口 {defaults.port} · 读取上限 {defaults.maxRows} 行 · 连接超时 {defaults.connectTimeoutMs} ms · 语句超时 {defaults.statementTimeoutMs} ms
        </div>
      </SectionCard>

      {testResult && (
        <div className={`rounded-xl border px-4 py-3 text-xs leading-relaxed ${
          testResult.ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'
        }`}>
          <div className="font-medium mb-1">
            {testResult.ok ? '连接成功' : '连接失败'}（耗时 {testResult.elapsedMs} ms）
          </div>
          <div>
            目标：{testResult.target.host || '—'}:{testResult.target.port || '—'}
            {testResult.target.databaseName ? ` · 租户库 ${testResult.target.databaseName}` : ''}
            {' · '}用户 {testResult.target.user || '—'}
            {testResult.target.useTLS ? ' · TLS' : ''}
          </div>
          {testResult.serverVersion && <div>服务端版本：{testResult.serverVersion}</div>}
          {testResult.error && <div className="mt-1">原因：{testResult.error}</div>}
          {testResult.ok && (
            <div className="mt-1 text-[11px] opacity-80">
              测试连接使用的是页面上的草稿值，尚未保存；确认无误后点右下角「保存」。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ===== ② SQL 查询语句 =====

function QueriesTab({
  config, draft, params, locked, sqlRef, dirty, onDraft, onColumns, onInsert,
  previewing, preview, previewErr, previewRows, onPreviewRows, onPreview, onReset,
}: {
  config: ApcConfigResponse
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
      {!dirty && config.queries && (
        <div className="text-[11px] text-mes-textTertiary">
          当前生效：{config.queries.mode === 'wide' ? '宽表' : '窄表'}模式
          {config.queries.columns.ts ? ` · 时间列 ${config.queries.columns.ts}` : ''}
          {config.queries.columns.code ? ` · 编码列 ${config.queries.columns.code}` : ''}
          {config.queries.columns.value ? ` · 数值列 ${config.queries.columns.value}` : ''}
        </div>
      )}
    </div>
  )
}

// ===== ③ 参数配置 =====

function ParamsTab({
  params, selected, current, locked, jsonMode, jsonText, jsonErr, meta,
  onSelect, onPatch, onAdd, onDuplicate, onRemove, onToggleJson, onExportJson, onJsonText, onApplyJson, onMeta, onReset,
}: {
  params: ApcParamConfig[]
  selected: number
  current: ApcParamConfig | null
  locked: boolean
  jsonMode: boolean
  jsonText: string
  jsonErr: string
  meta: ApcConfigResponse['meta'] | null
  onSelect: (i: number) => void
  onPatch: (patch: Partial<ApcParamConfig>) => void
  onAdd: () => void
  onDuplicate: () => void
  onRemove: () => void
  onToggleJson: () => void
  onExportJson: () => void
  onJsonText: (t: string) => void
  onApplyJson: () => void
  onMeta: (patch: Partial<NonNullable<ApcConfigResponse['meta']>>) => void
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
      <SectionCard
        title="目录元信息"
        desc="装置名、默认统计窗口与默认工艺死区；死区是「建议保持不动」的判定阈值"
        actions={<button onClick={onReset} disabled={locked} className={btnGhost}>恢复默认目录</button>}
      >
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <FieldShell label="装置/产线名称">
            <input type="text" value={meta?.station || ''} onChange={e => onMeta({ station: e.target.value })} className={inputCls} disabled={!meta || locked} />
          </FieldShell>
          <FieldShell label="采样间隔（秒）" hint="用于仿真数据源与曲线点数估算">
            <input type="number" value={meta ? String(meta.sampleIntervalSec) : ''} onChange={e => onMeta({ sampleIntervalSec: Number(e.target.value) })} className={inputCls} disabled={!meta || locked} />
          </FieldShell>
          <FieldShell label="默认统计窗口（分钟）">
            <input type="number" value={meta ? String(meta.defaultWindowMinutes) : ''} onChange={e => onMeta({ defaultWindowMinutes: Number(e.target.value) })} className={inputCls} disabled={!meta || locked} />
          </FieldShell>
          <FieldShell label="默认工艺死区（%）" hint="占规格带宽比例；参数未单独设置时用它">
            <input type="number" value={meta ? String(meta.deadbandPctDefault) : ''} onChange={e => onMeta({ deadbandPctDefault: Number(e.target.value) })} className={inputCls} disabled={!meta || locked} />
          </FieldShell>
        </div>
      </SectionCard>

      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold text-mes-text">
          过程参数<span className="ml-1.5 text-[11px] font-normal text-mes-textTertiary">{params.length} 个</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onToggleJson} className={btnGhost}>{jsonMode ? '返回表单' : 'JSON 批量编辑'}</button>
          <button onClick={onExportJson} className={btnGhost}>导出为 JSON</button>
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
