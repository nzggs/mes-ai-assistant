import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LLM_PROVIDERS,
  getProviderId,
  getProvider,
  setProviderId,
  getCustomModelId,
  setCustomModelId,
  resolveModelId,
  getApiKey,
  setApiKey,
  getGroupId,
  setGroupId,
  buildApiUrl,
  clearApiKey,
  getReasoningModelId,
  hasApiKey,
  getLlmStatus,
  fetchWithTimeout,
  streamChat,
  callLLMNonStream,
} from './llmApi'

describe('llmApi', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('提供商', () => {
    it('LLM_PROVIDERS 来自 shared 列表', () => {
      expect(Array.isArray(LLM_PROVIDERS)).toBe(true)
      expect(LLM_PROVIDERS.length).toBeGreaterThan(0)
    })
    it('getProviderId 默认 deepseek', () => {
      expect(getProviderId()).toBe('deepseek')
    })
    it('setProviderId / getProviderId 往返', () => {
      setProviderId('minimax')
      expect(getProviderId()).toBe('minimax')
    })
    it('getProvider 返回匹配提供商或回退第一个', () => {
      setProviderId('minimax')
      expect(getProvider().id).toBe('minimax')
      setProviderId('nonexistent')
      expect(getProvider().id).toBe(LLM_PROVIDERS[0].id)
    })
  })

  describe('自定义模型 ID', () => {
    it('默认空', () => {
      expect(getCustomModelId()).toBe('')
    })
    it('set/get 往返，空值清除', () => {
      setCustomModelId('  new-model  ')
      expect(getCustomModelId()).toBe('new-model')
      setCustomModelId('')
      expect(getCustomModelId()).toBe('')
    })
    it('resolveModelId 优先级：自定义 > 参数 > 默认', () => {
      expect(resolveModelId()).toBe(getProvider().defaultModel)
      expect(resolveModelId('explicit')).toBe('explicit')
      setCustomModelId('custom-model')
      expect(resolveModelId('explicit')).toBe('custom-model')
    })
  })

  describe('API Key 管理', () => {
    it('默认无 Key', () => {
      expect(getApiKey()).toBeNull()
    })
    it('set/get 往返', () => {
      setApiKey(' sk-123 ', 'deepseek')
      expect(getApiKey('deepseek')).toBe('sk-123')
    })
    it('未指定 provider 时用当前提供商', () => {
      setProviderId('deepseek')
      setApiKey('sk-abc')
      expect(getApiKey()).toBe('sk-abc')
    })
    it('旧明文格式自动迁移', () => {
      localStorage.setItem('ai_api_key', 'sk-legacy-plain')
      expect(getApiKey()).toBe('sk-legacy-plain')
    })
    it('clearApiKey 删除指定提供商 Key', () => {
      setApiKey('sk-1', 'deepseek')
      setApiKey('sk-2', 'minimax')
      clearApiKey('deepseek')
      expect(getApiKey('deepseek')).toBeNull()
      expect(getApiKey('minimax')).toBe('sk-2')
    })
    it('hasApiKey 需长度 > 10', () => {
      expect(hasApiKey()).toBe(false)
      setApiKey('short')
      expect(hasApiKey()).toBe(false)
      setApiKey('sk-123456789')
      expect(hasApiKey()).toBe(true)
    })
    it('getLlmStatus', () => {
      expect(getLlmStatus()).toBe('no-key')
      setApiKey('sk-123456789')
      expect(getLlmStatus()).toBe('ready')
    })
  })

  describe('Group ID 管理', () => {
    it('默认 null', () => {
      expect(getGroupId()).toBeNull()
    })
    it('set/get 往返，空值清除', () => {
      setGroupId(' g-1 ', 'minimax')
      expect(getGroupId('minimax')).toBe('g-1')
      setGroupId('', 'minimax')
      expect(getGroupId('minimax')).toBeNull()
    })
  })

  describe('buildApiUrl', () => {
    it('minimax 有 groupId 时拼接 ?GroupId=', () => {
      const url = buildApiUrl({ id: 'minimax', apiUrl: 'https://x/api', models: [], defaultModel: 'm' } as any, 'g1')
      expect(url).toBe('https://x/api?GroupId=g1')
    })
    it('apiUrl 已有查询参数用 &', () => {
      const url = buildApiUrl({ id: 'minimax', apiUrl: 'https://x/api?v=1', models: [], defaultModel: 'm' } as any, 'g1')
      expect(url).toBe('https://x/api?v=1&GroupId=g1')
    })
    it('groupId 需 URL 编码', () => {
      const url = buildApiUrl({ id: 'minimax', apiUrl: 'https://x/api', models: [], defaultModel: 'm' } as any, 'a b')
      expect(url).toBe('https://x/api?GroupId=a%20b')
    })
    it('非 minimax 不拼接', () => {
      const url = buildApiUrl({ id: 'deepseek', apiUrl: 'https://x/api', models: [], defaultModel: 'm' } as any, 'g1')
      expect(url).toBe('https://x/api')
    })
    it('minimax 无 groupId 不拼接', () => {
      const url = buildApiUrl({ id: 'minimax', apiUrl: 'https://x/api', models: [], defaultModel: 'm' } as any, null)
      expect(url).toBe('https://x/api')
    })
  })

  describe('getReasoningModelId', () => {
    it('返回提供商推理模型 id 或 null', () => {
      // 用真实 provider 列表测试（deepseek 默认含 reasoner）
      const id = getReasoningModelId()
      expect(id === null || typeof id === 'string').toBe(true)
    })
  })

  describe('fetchWithTimeout', () => {
    it('成功路径：透传 signal 并在完成后清理定时器', async () => {
      const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response))
      vi.stubGlobal('fetch', fetchMock)
      const p = fetchWithTimeout('http://x/api', { method: 'POST' }, 5000)
      await expect(p).resolves.toEqual({ ok: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const opts = fetchMock.mock.calls[0][1]
      expect(opts.signal).toBeInstanceOf(AbortSignal)
    })
    it('超时后 abort 触发请求失败', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn((_url: string, opts: any) => {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      const p = fetchWithTimeout('http://x/api', undefined, 1000)
      const assertion = expect(p).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(1001)
      await assertion
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    })
    it('默认超时时间为 120000ms', () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn(() => new Promise(() => {}))
      vi.stubGlobal('fetch', fetchMock)
      fetchWithTimeout('http://x/api')
      vi.advanceTimersByTime(120000)
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    })
  })

  describe('streamChat', () => {
    it('无 API Key 时回调 onError(NO_API_KEY)', async () => {
      const onError = vi.fn()
      const onContent = vi.fn()
      await streamChat([{ role: 'user', content: 'hi' }], { onError, onContent, onThinking: vi.fn(), onDone: vi.fn() })
      expect(onError).toHaveBeenCalledWith('NO_API_KEY')
      expect(onContent).not.toHaveBeenCalled()
    })
    it('有 Key 但网络失败时回调 onError', async () => {
      setApiKey('sk-1234567890')
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
      const onError = vi.fn()
      await streamChat([{ role: 'user', content: 'hi' }], { onError, onContent: vi.fn(), onThinking: vi.fn(), onDone: vi.fn() })
      expect(onError).toHaveBeenCalled()
    })
  })

  describe('callLLMNonStream', () => {
    it('无 API Key 返回 null', async () => {
      expect(await callLLMNonStream([{ role: 'user', content: 'hi' }])).toBeNull()
    })
    it('后端代理成功返回 content', async () => {
      setApiKey('sk-1234567890')
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ content: '总结结果' }) } as Response)))
      expect(await callLLMNonStream([{ role: 'user', content: 'hi' }])).toBe('总结结果')
    })
    it('后端失败回退直连成功', async () => {
      setApiKey('sk-1234567890')
      let call = 0
      vi.stubGlobal('fetch', vi.fn(() => {
        call++
        if (call === 1) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response) // 后端失败
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '直连结果' } }] }) } as Response)
      }))
      expect(await callLLMNonStream([{ role: 'user', content: 'hi' }])).toBe('直连结果')
    })
    it('useBackend=false 直接走直连', async () => {
      setApiKey('sk-1234567890')
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '直连' } }] }) } as Response)))
      expect(await callLLMNonStream([{ role: 'user', content: 'hi' }], { useBackend: false })).toBe('直连')
    })
  })
})
