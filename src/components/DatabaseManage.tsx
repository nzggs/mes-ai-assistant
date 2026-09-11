// 数据库管理（侧边栏入口，仅 IT 部管理员可见）
//
// 公用数据库配置集中在这里，与监测项目解耦：
//   ① 数据库连接 —— 两个 HANA 系统槽位（db1/db2）各自的连接参数、密码三态、测试连接
//   ② 查询限制   —— 只允许 SELECT（服务端硬护栏）、行数上限、连接/语句超时
//
// 监测项目只引用槽位（dbSlot），不重复存连接信息。
// 全部接口在服务端挂 requireAdmin；密码只进不出：读取回来的配置里没有密码原文。

import { useCallback, useEffect, useState } from 'react'
import {
  fetchApcConfig,
  saveApcConfig,
  resetApcConfig,
  testApcDatabase,
  setAdminToken,
  type ApcConfigSection,
} from '../services/apcApi'
import type {
  ApcConfigResponse,
  ApcDatabaseDraft,
  ApcTestDbResult,
} from '../types'

const DB_TEXT_FIELDS: { key: keyof ApcDatabaseDraft; label: string; placeholder: string; hint: string }[] = [
  { key: 'host', label: '数据库地址', placeholder: '如 10.0.0.21', hint: 'HANA 主机名或 IP；地址与用户名齐备即视为已配置数据源' },
  { key: 'user', label: '用户名', placeholder: '如 READONLY_APC', hint: '务必使用仅授予 SELECT 权限的只读账号，不要复用管理员账号' },
  { key: 'databaseName', label: '租户库名', placeholder: '单库实例可留空', hint: 'MDC 多租户场景填写租户库名；单库实例留空' },
  { key: 'schema', label: '模式名 Schema', placeholder: '可留空', hint: '部分取数模板会用 {{schema}} 引用模式名' },
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

const inputCls = 'w-full text-xs px-2.5 py-1.5 rounded-lg border border-mes-border bg-white text-mes-text focus:outline-none focus:border-mes-primary'
const btnGhost = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary hover:text-mes-primary disabled:opacity-50'
const btnPrimary = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-mes-primary text-white hover:bg-mes-primaryHover disabled:opacity-50'

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

export function DatabaseManage({ onSaved }: { onSaved?: () => void }) {
  const [config, setConfig] = useState<ApcConfigResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState('')
  const [needsToken, setNeedsToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const [dbEditId, setDbEditId] = useState<'db1' | 'db2'>('db1')
  const [dbDrafts, setDbDrafts] = useState<Record<string, ApcDatabaseDraft>>({})
  const [dbNames, setDbNames] = useState<Record<string, string>>({})
  const [pwInputs, setPwInputs] = useState<Record<string, string>>({})
  const [clearPwFlags, setClearPwFlags] = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<ApcTestDbResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [chatRows, setChatRows] = useState<number>(100)
  const [limitsDirty, setLimitsDirty] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const applyConfig = useCallback((c: ApcConfigResponse) => {
    setConfig(c)
    setDbDrafts(Object.fromEntries(c.database.slots.map(s => [s.id, { ...s.values }])))
    setDbNames(Object.fromEntries(c.database.slots.map(s => [s.id, s.name || s.id])))
    setPwInputs({})
    setClearPwFlags({})
    setChatRows(c.limits?.chatRows ?? 100)
    setLimitsDirty(false)
    setDirty(false)
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

  const handleTokenSave = useCallback(() => {
    setAdminToken(tokenInput)
    setTokenInput('')
    load()
  }, [tokenInput, load])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setNotice(null)
    try {
      const db = { ...(dbDrafts[dbEditId] || {}) }
      const name = (dbNames[dbEditId] || '').trim()
      if (name) (db as Record<string, unknown>).name = name
      if (clearPwFlags[dbEditId]) db.password = null
      else if (pwInputs[dbEditId]) db.password = pwInputs[dbEditId]
      else delete db.password
      const patch: Record<string, unknown> = { databases: { [dbEditId]: db } }
      if (limitsDirty) patch.limits = { chatRows }
      await saveApcConfig(patch as never)
      setNotice({ kind: 'ok', text: '已保存并生效（数据库连接缓存已刷新）' })
      await load()
      onSaved?.()
    } catch (err: any) {
      setNotice({ kind: 'err', text: err?.message || String(err) })
    } finally {
      setSaving(false)
    }
  }, [dbEditId, dbDrafts, dbNames, pwInputs, clearPwFlags, limitsDirty, chatRows, load, onSaved])

  const handleReset = useCallback(async (section: ApcConfigSection, databaseId?: string) => {
    setSaving(true)
    setNotice(null)
    try {
      const res = await resetApcConfig(section, databaseId)
      applyConfig(res.config)
      setNotice({ kind: 'ok', text: '已恢复默认' })
      onSaved?.()
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
      const db: ApcDatabaseDraft = { ...(dbDrafts[dbEditId] || {}) }
      if (!clearPwFlags[dbEditId] && pwInputs[dbEditId]) db.password = pwInputs[dbEditId]
      if (clearPwFlags[dbEditId]) db.password = null
      setTestResult(await testApcDatabase(db, dbEditId))
    } catch (err: any) {
      setTestResult({ ok: false, elapsedMs: 0, error: err?.message || String(err), target: { host: '', port: 0, user: '', databaseName: '', schema: '', useTLS: false, validateCert: true } })
    } finally {
      setTesting(false)
    }
  }, [dbEditId, dbDrafts, clearPwFlags, pwInputs])

  const slot = config?.database.slots.find(s => s.id === dbEditId) || config?.database.slots[0]
  const draft = dbDrafts[dbEditId] || {}
  const pwInput = pwInputs[dbEditId] || ''
  const clearPw = Boolean(clearPwFlags[dbEditId])
  const savedKeys = slot?.savedKeys || []
  const envValues = config?.database.envValues || {}
  const envConfigured = config?.database.envConfigured || false

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
    <div className="h-full overflow-y-auto bg-mes-bg">
      <div className="max-w-4xl mx-auto px-6 py-6">
        {/* ===== 头部 ===== */}
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-mes-text">数据库管理</h1>
          <p className="text-xs text-mes-textTertiary mt-1 leading-relaxed">
            公用数据库配置（仅 IT 部管理员可修改）：两个 HANA 系统的<b>连接方式</b>与<b>查询限制</b>。
            监测项目在「APC和RTO」里选择用哪个系统取数，问答环节在下拉菜单里选择查哪个系统。
          </p>
        </div>

        {/* ===== 令牌提示 ===== */}
        {needsToken && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
            <div className="text-xs text-amber-800 font-medium mb-1">需要管理员令牌才能查看与修改数据库配置</div>
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

        {fatal && !loading && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 mb-4">
            读取配置失败：{fatal}
          </div>
        )}
        {notice && (
          <div className={`rounded-xl px-4 py-2 text-xs mb-4 ${
            notice.kind === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {notice.text}
          </div>
        )}

        {loading && <div className="p-10 text-center text-sm text-mes-textTertiary animate-pulse">正在读取配置…</div>}

        {config && !loading && (
          <>
            {/* ===== 两个数据库系统分页 ===== */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {config.database.slots.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setDbEditId(s.id === 'db2' ? 'db2' : 'db1'); setTestResult(null) }}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    dbEditId === s.id
                      ? 'border-mes-primary bg-white text-mes-primary shadow-sm'
                      : 'border-mes-border bg-white text-mes-textSecondary hover:border-mes-primary/40'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {dbNames[s.id] || s.name || s.id}
                    {s.configured
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">已配置</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-mes-textTertiary">未配置</span>}
                  </span>
                </button>
              ))}
            </div>

            <SectionCard
              title={`连接参数 · ${dbNames[dbEditId] || dbEditId}`}
              desc="只读账号（仅授予 SELECT）；保存后立即生效、无需重启服务；密码只写服务端数据卷，不回显"
              actions={(
                <button onClick={() => handleReset('database', dbEditId)} className={btnGhost}>清空本系统</button>
              )}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <FieldShell label="系统显示名" hint="用于项目配置、问答下拉菜单里区分两个系统">
                  <input
                    type="text"
                    value={dbNames[dbEditId] || ''}
                    onChange={e => { setDbNames(m => ({ ...m, [dbEditId]: e.target.value })); setDirty(true) }}
                    placeholder="如 一厂HANA / 二厂HANA"
                    className={inputCls}
                  />
                </FieldShell>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {DB_TEXT_FIELDS.map(f => (
                  <FieldShell key={f.key} label={f.label} source={sourceOf(String(f.key))} hint={`${f.hint}${envHint(String(f.key)) ? '；' + envHint(String(f.key)) : ''}`}>
                    <input
                      type="text"
                      value={String((draft as Record<string, unknown>)[f.key as string] ?? '')}
                      onChange={e => { setDbDrafts(d => ({ ...d, [dbEditId]: { ...(d[dbEditId] || {}), [f.key]: e.target.value } })); setDirty(true) }}
                      placeholder={f.placeholder}
                      className={inputCls}
                    />
                  </FieldShell>
                ))}
                {DB_NUM_FIELDS.map(f => (
                  <FieldShell key={f.key} label={f.label} source={sourceOf(String(f.key))} hint={f.hint}>
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      value={String((draft as Record<string, unknown>)[f.key as string] ?? '')}
                      onChange={e => { setDbDrafts(d => ({ ...d, [dbEditId]: { ...(d[dbEditId] || {}), [f.key]: Number(e.target.value) } })); setDirty(true) }}
                      className={inputCls}
                    />
                  </FieldShell>
                ))}
                <FieldShell label="密码" hint={clearPw ? '将在保存时清除已保存的密码' : slot?.passwordSet ? '已保存密码（不回显）；留空表示保持不变' : '尚未设置密码'}>
                  <input
                    type="password"
                    value={clearPw ? '' : pwInput}
                    onChange={e => { setPwInputs(p => ({ ...p, [dbEditId]: e.target.value })); setDirty(true) }}
                    placeholder={slot?.passwordSet ? '••••••••（保持不变）' : '输入只读账号密码'}
                    disabled={clearPw}
                    className={inputCls}
                  />
                </FieldShell>
                {slot?.passwordSet && (
                  <FieldShell label="清除密码">
                    <label className="flex items-center gap-2 text-xs text-mes-textSecondary">
                      <input
                        type="checkbox"
                        checked={clearPw}
                        onChange={e => { setClearPwFlags(f => ({ ...f, [dbEditId]: e.target.checked })); setDirty(true) }}
                        className="accent-mes-primary"
                      />
                      保存时删除已存的密码
                    </label>
                  </FieldShell>
                )}
                {DB_BOOL_FIELDS.map(f => (
                  <FieldShell key={f.key} label={f.label} source={sourceOf(String(f.key))} hint={f.hint}>
                    <label className="flex items-center gap-2 text-xs text-mes-textSecondary">
                      <input
                        type="checkbox"
                        checked={Boolean((draft as Record<string, unknown>)[f.key as string])}
                        onChange={e => { setDbDrafts(d => ({ ...d, [dbEditId]: { ...(d[dbEditId] || {}), [f.key]: e.target.checked } })); setDirty(true) }}
                        className="accent-mes-primary"
                      />
                      {Boolean((draft as Record<string, unknown>)[f.key as string]) ? '启用' : '关闭'}
                    </label>
                  </FieldShell>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-4 pt-3 border-t border-mes-border">
                <button onClick={handleTest} disabled={testing} className={btnGhost}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                {testResult && (
                  <span className={`text-[11px] ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>
                    {testResult.ok
                      ? `连接成功（${testResult.elapsedMs}ms → ${testResult.target?.host}:${testResult.target?.port}）`
                      : `连接失败：${testResult.error}`}
                  </span>
                )}
              </div>
              {envConfigured && (
                <div className="mt-2 text-[10px] text-mes-textTertiary">
                  检测到环境变量里也有连接配置：<b>页面保存值优先</b>；如需回退环境变量，点上方「清空本系统」。
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="查询限制（公用）"
              desc="问答环节与 APC 取数共用的硬性要求，服务端强制执行，不依赖模型自觉"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FieldShell label="问答直查行数上限" hint="问答环节单次查询最多返回的行数（1 ~ 5000）">
                  <input
                    type="number"
                    min={1}
                    max={5000}
                    value={String(chatRows)}
                    onChange={e => { setChatRows(Number(e.target.value)); setLimitsDirty(true) }}
                    className={inputCls}
                  />
                </FieldShell>
                <div className="text-[11px] text-mes-textTertiary leading-relaxed self-end">
                  固定不变的限制：只允许单条 SELECT / WITH（增删改与 DDL 一律拦截）；行数同时受各系统
                  「单次读取行数上限」约束；连接与语句超时按各系统的超时配置执行，超时即断开会话。
                </div>
              </div>
            </SectionCard>

            {/* ===== 底部保存 ===== */}
            <div className="flex items-center justify-end gap-2 pb-6">
              <button onClick={load} disabled={!dirty || saving} className={btnGhost}>放弃改动</button>
              <button onClick={handleSave} disabled={!dirty || saving} className={btnPrimary}>
                {saving ? '保存中…' : '保存并生效'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
