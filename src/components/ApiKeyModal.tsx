import { useState, useEffect } from 'react'
import { setApiKey, clearApiKey, testApiKey, getApiKey, getProviderId, setProviderId, getProvider, getCustomModelId, setCustomModelId, getGroupId, setGroupId, LLM_PROVIDERS, type LlmProvider } from '../services/llmApi'

interface ApiKeyModalProps {
  onClose: () => void
  onSaved: () => void
  forceOpen?: boolean // 查询时无 Key 强制弹出
}

// 本地模型不需要真实 API Key；存一个占位串以满足既有「已配置」闸门，
// 真实请求不携带有效凭证（本地服务忽略 Authorization）。
const LOCAL_NOKEY_SENTINEL = 'ollama-local'

export function ApiKeyModal({ onClose, onSaved, forceOpen }: ApiKeyModalProps) {
  const [providerId, setProviderIdState] = useState(getProviderId())
  const [key, setKey] = useState(getApiKey() || '')
  const [groupId, setGroupIdState] = useState(getGroupId() || '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ valid: boolean; error?: string } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [customModel, setCustomModelState] = useState(getCustomModelId())

  const provider: LlmProvider = LLM_PROVIDERS.find(p => p.id === providerId) || LLM_PROVIDERS[0]
  const noKey = !!provider.noApiKey

  // 切换提供商时：加载该提供商自己保存的 Key / GroupId（按提供商分别存储，避免错配），重置测试结果
  const handleProviderChange = (newId: string) => {
    setProviderIdState(newId)
    setProviderId(newId)
    setKey(getApiKey(newId) || '')
    setGroupIdState(getGroupId(newId) || '')
    setTestResult(null)
  }

  const handleCustomModelChange = (value: string) => {
    setCustomModelState(value)
    setCustomModelId(value)
  }

  const handleSave = async () => {
    if (noKey) {
      // 本地模型无需真实 Key：存占位串即可（满足「已配置」闸门），不写 localStorage 真实凭证
      setApiKey(LOCAL_NOKEY_SENTINEL)
      setGroupId(groupId.trim(), providerId)
      onSaved()
      onClose()
      return
    }
    if (!key.trim() || key.trim().length < 10) {
      setTestResult({ valid: false, error: 'API Key 格式不正确，请检查后重新输入' })
      return
    }
    setApiKey(key.trim())
    setGroupId(groupId.trim(), providerId)
    onSaved()
    onClose()
  }

  const handleTest = async () => {
    const testKey = noKey ? LOCAL_NOKEY_SENTINEL : key.trim()
    if (!testKey) {
      setTestResult({ valid: false, error: '请先输入 API Key' })
      return
    }
    // 测试前先把当前 GroupId 写入存储，确保 testApiKey 读取到最新值
    if (provider.groupRequired) setGroupId(groupId.trim(), providerId)
    setTesting(true)
    setTestResult(null)
    const result = await testApiKey(testKey, providerId)
    setTestResult(result)
    setTesting(false)
  }

  const handleClear = () => {
    clearApiKey()
    setKey('')
    setGroupId('', providerId)
    setGroupIdState('')
    setTestResult(null)
    onSaved()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-2xl bg-white shadow-2xl animate-slide-up overflow-hidden max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-mes-border shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
              </div>
              <div>
                <h2 className="text-base font-semibold text-mes-text leading-tight">配置 AI 模型</h2>
                <p className="text-xs text-mes-textTertiary mt-0.5 leading-tight">选择模型提供商并输入 API Key</p>
              </div>
            </div>
            <button onClick={onClose} title="关闭" aria-label="关闭" className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="px-5 py-3 space-y-2.5 overflow-y-auto">
          {forceOpen && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" className="mt-0 shrink-0">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <p className="text-xs text-amber-700 leading-snug">
                {noKey
                  ? '请选择模型提供商。当前所选为离线模型，无需 API，直接保存即可使用。'
                  : '需要配置 API Key 才能使用 AI 问答功能。请选择模型提供商并粘贴你的 Key。'}
              </p>
            </div>
          )}

          {/* 模型提供商选择 */}
          <div>
            <label className="text-sm font-medium text-mes-textSecondary mb-1 block">
              模型提供商
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {LLM_PROVIDERS.map(p => (
                <button
                  key={p.id}
                  onClick={() => handleProviderChange(p.id)}
                  className={`px-2 py-2 rounded-lg text-xs font-medium transition-all-smooth border ${
                    providerId === p.id
                      ? 'bg-mes-primary text-white border-mes-primary shadow-sm'
                      : 'bg-gray-50 text-mes-textSecondary border-mes-border hover:bg-gray-100'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* 当前选中提供商的信息 */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" className="shrink-0">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <p className="text-xs text-blue-700 leading-snug">
              当前选择：<span className="font-semibold">{provider.name}</span>，默认模型：{provider.models.find(m => m.id === provider.defaultModel)?.name || provider.defaultModel}
              <br />
              保存后，所有请求将发往：<span className="font-mono break-all">{provider.apiUrl}</span>
            </p>
          </div>

          {/* 自定义模型 ID（可选，用于使用提供商的最新模型） */}
          <div>
            <label className="text-sm font-medium text-mes-textSecondary mb-1 block">
              自定义模型 ID（可选）
            </label>
            <input
              type="text"
              value={customModel}
              onChange={e => handleCustomModelChange(e.target.value)}
              placeholder="留空则使用默认模型（即当前提供商的默认模型）"
              className="w-full px-3 py-2 text-sm rounded-lg border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors font-mono"
            />
            <p className="mt-0.5 text-[11px] leading-snug text-mes-textTertiary">
              留空时使用提供商默认模型；填写后优先于默认列表。建议填提供商公布的系列别名（如 deepseek-chat、qwen-plus），其升级时会自动指向最新版本，无需改代码。
            </p>
          </div>

          {/* API Key 输入框 */}
          {noKey ? (
            <div className="p-2.5 rounded-lg bg-green-50 border border-green-200">
              <p className="text-xs text-green-700 leading-snug flex items-start gap-2">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" className="mt-0 shrink-0">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                离线模型，运行在本地服务器。<span className="font-semibold">无需 API</span> 直接点击「保存」即可使用，自定义模型 ID 可填本地已拉取的其他模型。
              </p>
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium text-mes-textSecondary mb-1 block">
                {provider.keyLabel}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={e => { setKey(e.target.value); setTestResult(null) }}
                  placeholder={provider.keyPlaceholder}
                  className="w-full px-3 py-2 pr-20 text-sm rounded-lg border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors font-mono"
                  autoFocus
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-mes-textTertiary hover:text-mes-primary"
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
          )}

          {/* Group ID 输入框（仅部分厂商需要，如 MiniMax） */}
          {provider.groupRequired && (
            <div>
              <label className="text-sm font-medium text-mes-textSecondary mb-1 block">
                {provider.groupLabel}
              </label>
              <input
                type="text"
                value={groupId}
                onChange={e => { setGroupIdState(e.target.value); setTestResult(null) }}
                placeholder={provider.groupPlaceholder}
                className="w-full px-3 py-2 text-sm rounded-lg border border-mes-border bg-gray-50 focus:bg-white focus:border-mes-primary focus:outline-none transition-colors font-mono"
              />
              <p className="text-xs text-mes-textTertiary mt-1 leading-snug">
                该厂商接口需在 URL 携带 Group ID（<code className="font-mono">?GroupId=xxx</code>）。未填或填写错误会导致调用失败。
              </p>
            </div>
          )}

          {/* 测试结果 */}
          {testResult && (
            <div className={`flex items-start gap-2 p-2.5 rounded-lg ${
              testResult.valid
                ? 'bg-green-50 border border-green-200'
                : 'bg-red-50 border border-red-200'
            }`}>
              {testResult.valid ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" className="mt-0 shrink-0">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" className="mt-0 shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              )}
              <p className={`text-xs ${testResult.valid ? 'text-green-700' : 'text-red-700'} leading-snug`}>
                {testResult.valid ? `${provider.name} API Key 验证成功，可以正常使用` : testResult.error}
              </p>
            </div>
          )}

          {/* 隐私提示 */}
          <div className="p-2.5 rounded-lg bg-blue-50 border border-blue-100">
            <div className="flex items-start gap-2">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" className="mt-0 shrink-0">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <div className="text-xs text-blue-700 space-y-0.5 leading-snug flex-1">
                <p>API Key 以明文存储在你浏览器的 localStorage 中（前端直连模式所必需），不会上传到服务器。</p>
                <p>每条查询直接从浏览器发送到 {provider.name} API，不经第三方中转。</p>
              </div>
            </div>
            <div className="flex items-start gap-2 mt-1">
              <span className="w-[15px] shrink-0 text-center leading-tight">⚠️</span>
              <p className="text-xs text-amber-700 leading-snug flex-1">请勿在公共或共享电脑上使用，以免 Key 被他人读取。用完可在设置中清除。</p>
            </div>
          </div>

          {/* 获取 Key 链接（本地模型无需 Key，隐藏） */}
          {!noKey && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-mes-textTertiary">没有 API Key？</span>
              <a
                href={provider.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-mes-primary hover:underline font-medium flex items-center gap-1"
              >
                点击获取 {provider.name} API Key
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-mes-border bg-gray-50 shrink-0">
          {getApiKey() ? (
            <button
              onClick={handleClear}
              className="px-3.5 py-1.5 rounded-lg text-sm font-medium text-mes-danger border border-red-200 hover:bg-red-50 transition-colors"
            >
              清除已保存的 Key
            </button>
          ) : (
            <span className="text-xs text-mes-textTertiary">Key 保存在本浏览器中</span>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testing || (!noKey && !key.trim())}
              className="px-3.5 py-1.5 rounded-lg text-sm font-medium text-mes-primary border border-mes-primary hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {testing ? '验证中...' : '测试连接'}
            </button>
            <button
              onClick={handleSave}
              disabled={!noKey && (!key.trim() || key.trim().length < 10)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-mes-primary hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
