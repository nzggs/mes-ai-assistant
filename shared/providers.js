// 模型提供商统一配置（单一数据源）
// 前端（src/services/llmApi.ts）与后端（server/index.js）都从这里引入，
// 避免两端各维护一份导致 apiUrl / 模型列表漂移（I1）。
// 后端只需 name / apiUrl / defaultModel，其余字段为前端展示/交互所需，后端会忽略多余字段。

// 本地 Ollama 地址可被环境变量覆盖。
// 注意：变量名不带 VITE_ 前缀 → 仅服务端（Node）生效，不会改变前端产物，
// 浏览器仍直连 127.0.0.1:11434（宿主机已映射端口即可）。
// 容器内 127.0.0.1 指向容器自身，需通过 docker-compose 设为 http://ollama:11434/v1/chat/completions。
const OLLAMA_API_URL =
  (typeof process !== 'undefined' && process.env && process.env.OLLAMA_API_URL) ||
  'http://127.0.0.1:11434/v1/chat/completions'

export const PROVIDER_LIST = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (深度思考)' },
    ],
    defaultModel: 'deepseek-chat',
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyLabel: 'DeepSeek API Key',
    contextWindow: 65536,
  },
  {
    id: 'qwen',
    name: '通义千问',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen3-max', name: 'Qwen3 Max' },
      { id: 'qwen3-plus', name: 'Qwen3 Plus' },
      { id: 'qwen3-turbo', name: 'Qwen3 Turbo' },
      { id: 'qwq-32b-preview', name: 'QwQ-32B (深度思考)' },
    ],
    defaultModel: 'qwen-plus',
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    keyUrl: 'https://bailian.console.aliyun.com/#/api-key',
    keyLabel: '通义千问 API Key',
    contextWindow: 131072,
  },
  {
    id: 'glm',
    name: '智谱GLM',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    models: [
      { id: 'glm-4-plus', name: 'GLM-4-Plus' },
      { id: 'glm-4', name: 'GLM-4' },
      { id: 'glm-4-flash', name: 'GLM-4-Flash (免费)' },
      { id: 'glm-4-air', name: 'GLM-4-Air' },
      { id: 'glm-4.5', name: 'GLM-4.5' },
      { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
      { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash' },
    ],
    defaultModel: 'glm-4-plus',
    keyPlaceholder: 'xxxxxxxx.xxxxxxxxxxxxxxxx',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyLabel: '智谱GLM API Key',
    contextWindow: 131072,
  },
  {
    id: 'moonshot',
    name: 'Kimi (月之暗面)',
    apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    models: [
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K' },
      { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K' },
      { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K' },
    ],
    defaultModel: 'moonshot-v1-128k',
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyLabel: 'Kimi API Key',
    contextWindow: 128000,
  },
  {
    id: 'doubao',
    name: '豆包 (字节)',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    models: [
      { id: 'doubao-pro-32k', name: 'Doubao Pro 32K' },
      { id: 'doubao-pro-128k', name: 'Doubao Pro 128K' },
      { id: 'doubao-lite-32k', name: 'Doubao Lite 32K' },
    ],
    defaultModel: 'doubao-pro-32k',
    keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    keyLabel: '豆包 API Key',
    contextWindow: 128000,
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    // 腾讯已将混元迁移至 TokenHub。本账号为国际站（新加坡地域），需用 tokenhub-intl 端点
    // （广州地域为 tokenhub.tencentmaas.com，两者 key 不通用）。
    apiUrl: 'https://tokenhub-intl.tencentmaas.com/v1/chat/completions',
    models: [
      { id: 'hy3', name: 'Hy3 (最新, 256k)' },
      { id: 'hy3-preview', name: 'Hy3 Preview' },
      { id: 'hy-mt2-lite', name: 'Hy-MT2-Lite (轻量)' },
      { id: 'hy-mt2-plus', name: 'Hy-MT2-Plus' },
      { id: 'hy-mt2-pro', name: 'Hy-MT2-Pro' },
      { id: 'hy-role', name: 'Hy-Role' },
    ],
    defaultModel: 'hy3',
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    keyUrl: 'https://console.intl.cloud.tencent.com/tokenhub',
    keyLabel: '腾讯混元(TokenHub 国际站) API Key',
    contextWindow: 256000,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    apiUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    models: [
      { id: 'MiniMax-Text-01', name: 'MiniMax Text 01' },
      { id: 'abab6.5s-chat', name: 'abab6.5s Chat' },
      { id: 'abab6.5-chat', name: 'abab6.5 Chat' },
    ],
    defaultModel: 'MiniMax-Text-01',
    keyPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    keyLabel: 'MiniMax API Key',
    contextWindow: 200000,
    groupRequired: true,
    groupLabel: 'MiniMax Group ID',
    groupPlaceholder: '从账号中心「接口密钥」页获取 Group ID',
  },
  {
    id: 'ollama',
    name: '本地 DeepSeek',
    // 本地服务器部署的 OpenAI 兼容模型服务接口；模型跑在本地，无需联网、无需 API。
    // 自定义模型 ID 可填本地已拉取的其他模型（如 qwen2.5:3b、llama3 等）。
    apiUrl: OLLAMA_API_URL,
    models: [
      { id: 'deepseek-r1:1.5b', name: 'DeepSeek-R1 1.5B' },
      { id: 'deepseek-r1:7b', name: 'DeepSeek-R1 7B' },
      { id: 'qwen2.5:3b', name: 'Qwen2.5 3B' },
      { id: 'qwen2.5:7b-instruct', name: 'Qwen2.5 7B Instruct' },
    ],
    defaultModel: 'deepseek-r1:1.5b',
    // 离线模型不需要 API；前端存一个占位串以满足既有「已配置」闸门，真实请求不携带有效凭证。
    noApiKey: true,
    keyLabel: '（本地模型无需 Key）',
    keyPlaceholder: '本地模型无需 API，可留空',
    keyUrl: '',
    contextWindow: 32768,
  },
]

// 后端使用的「按 id 索引」映射（保持与原有 PROVIDERS 结构一致）
export const PROVIDERS = Object.fromEntries(PROVIDER_LIST.map(p => [p.id, p]))
