// 模型分级预算配置的回归用例。
// 需求：**云端模型按各家云端配置、本地模型按参数量分档**，让注入规模与模型能力匹配。
// 小模型（1.5B）灌太多上下文只会稀释注意力，而且会直接撞上 Ollama 的 num_ctx 上限报 HTTP 400；
// 云端大模型（128k~256k）则应当尽量吃满召回。
import { describe, it, expect } from 'vitest'
import {
  parseParamBillions, localTierOf, resolveModelProfile, hasSqlIntent,
  LOCAL_TIERS, LOCAL_LIMIT_CAP, OLLAMA_SAFE_CTX_TOKENS,
} from './modelProfile.js'
import { PROVIDERS } from './providers.js'

describe('parseParamBillions', () => {
  it('识别常见本地模型写法', () => {
    expect(parseParamBillions('deepseek-r1:1.5b')).toBe(1.5)
    expect(parseParamBillions('qwen2.5:7b-instruct')).toBe(7)
    expect(parseParamBillions('deepseek-r1:7b')).toBe(7)
    expect(parseParamBillions('llama3:8b')).toBe(8)
    expect(parseParamBillions('gemma2:27b')).toBe(27)
  })

  it('不会把版本号当参数量（qwen2.5 / glm-4.5 / abab6.5s）', () => {
    expect(parseParamBillions('glm-4.5-air')).toBe(null)
    expect(parseParamBillions('abab6.5s-chat')).toBe(null)
    expect(parseParamBillions('hy-mt2-lite')).toBe(null)
    expect(parseParamBillions('deepseek-chat')).toBe(null)
  })
})

describe('localTierOf 参数量分档', () => {
  it('按参数量落到对应档位', () => {
    expect(localTierOf('deepseek-r1:1.5b').id).toBe('tiny')
    expect(localTierOf('qwen2.5:3b').id).toBe('small')
    expect(localTierOf('qwen2.5:7b-instruct').id).toBe('medium')
    expect(localTierOf('qwen2.5:32b').id).toBe('large')
  })

  it('参数量未知时保守取小档（不把大上下文灌给小模型）', () => {
    const t = localTierOf('some-unknown-model')
    expect(LOCAL_TIERS.indexOf(t)).toBeLessThan(LOCAL_TIERS.length - 1)
  })

  it('档位预算随参数量单调不减', () => {
    for (let i = 1; i < LOCAL_TIERS.length; i++) {
      expect(LOCAL_TIERS[i].limit).toBeGreaterThanOrEqual(LOCAL_TIERS[i - 1].limit)
      expect(LOCAL_TIERS[i].topK).toBeGreaterThanOrEqual(LOCAL_TIERS[i - 1].topK)
    }
  })
})

describe('resolveModelProfile：云端', () => {
  it('按各家真实 contextWindow 取 80% 作为注入上限', () => {
    const p = resolveModelProfile({ providerId: 'glm', modelId: 'glm-4-plus', provider: PROVIDERS.glm })
    expect(p.kind).toBe('cloud')
    expect(p.contextWindow).toBe(131072)
    expect(p.limit).toBe(Math.round(131072 * 0.8))
  })

  it('同提供商内按单模型窗口区分（Kimi 8K / 128K）', () => {
    const k8 = resolveModelProfile({ providerId: 'moonshot', modelId: 'moonshot-v1-8k', provider: PROVIDERS.moonshot })
    const k128 = resolveModelProfile({ providerId: 'moonshot', modelId: 'moonshot-v1-128k', provider: PROVIDERS.moonshot })
    expect(k8.contextWindow).toBe(8192)
    expect(k128.contextWindow).toBe(128000)
    expect(k8.limit).toBeLessThan(k128.limit)
  })

  it('超大窗口仍封顶 160000 字符', () => {
    const p = resolveModelProfile({ providerId: 'hunyuan', modelId: 'hy3', provider: PROVIDERS.hunyuan })
    expect(p.contextWindow).toBe(256000)
    expect(p.limit).toBe(160000)
  })

  it('检索参数按云端档给足（topK 30 / 单页 9000）', () => {
    const p = resolveModelProfile({ providerId: 'deepseek', modelId: 'deepseek-chat', provider: PROVIDERS.deepseek })
    expect(p.topK).toBe(30)
    expect(p.perHitChars).toBe(9000)
  })
})

describe('resolveModelProfile：本地', () => {
  it('1.5B 走 tiny 档，且注入量被 Ollama 实际 num_ctx 卡住', () => {
    const p = resolveModelProfile({ providerId: 'ollama', modelId: 'deepseek-r1:1.5b', provider: PROVIDERS.ollama })
    expect(p.kind).toBe('local')
    expect(p.tier).toBe('tiny')
    expect(p.params).toBe(1.5)
    // 关键：本地预算必须 ≤ Ollama 可用窗口换算出的字符上限，否则请求会 400
    expect(p.limit).toBeLessThanOrEqual(LOCAL_LIMIT_CAP)
    expect(p.limit).toBe(6000)
  })

  it('本地各档位都不超过 Ollama 安全上限', () => {
    for (const id of ['deepseek-r1:1.5b', 'qwen2.5:3b', 'qwen2.5:7b-instruct', 'qwen2.5:32b']) {
      const p = resolveModelProfile({ providerId: 'ollama', modelId: id, provider: PROVIDERS.ollama })
      expect(p.limit).toBeLessThanOrEqual(LOCAL_LIMIT_CAP)
      expect(p.limit).toBeGreaterThan(0)
    }
  })

  it('Ollama 安全上限与 4096 的默认值相比留足了余量', () => {
    // 4096 token 是 Ollama 缺省；实测 5877 token 就会 400。这里必须高于它才有意义。
    expect(OLLAMA_SAFE_CTX_TOKENS).toBeGreaterThan(4096)
  })

  it('本地小模型的注入量明显小于云端（避免"一个参数套所有模型"）', () => {
    const local = resolveModelProfile({ providerId: 'ollama', modelId: 'deepseek-r1:1.5b', provider: PROVIDERS.ollama })
    const cloud = resolveModelProfile({ providerId: 'glm', modelId: 'glm-4-plus', provider: PROVIDERS.glm })
    expect(local.limit).toBeLessThan(cloud.limit / 10)
    expect(local.topK).toBeLessThan(cloud.topK)
  })
})

describe('hasSqlIntent', () => {
  it('识别 SQL 类问题', () => {
    expect(hasSqlIntent('给出查询作业指导书明细有哪些文件上传过的SQL')).toBe(true)
    expect(hasSqlIntent('这个功能的 sql 怎么写')).toBe(true)
    expect(hasSqlIntent('SELECT 语句怎么改')).toBe(true)
  })

  it('普通界面/业务问题不误判', () => {
    expect(hasSqlIntent('作业指导书维护界面有哪些控件')).toBe(false)
    expect(hasSqlIntent('注液量偏低怎么排查')).toBe(false)
  })
})
