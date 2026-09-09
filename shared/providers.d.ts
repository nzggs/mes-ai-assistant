// 与 providers.js 配套的类型声明，供 TypeScript 在前端导入时解析类型。
// providers.js 为运行时单数据源（前后端共用），此处仅提供类型，不参与打包。

export interface ProviderModel {
  id: string
  name: string
}

export interface ProviderConfig {
  id: string
  name: string
  apiUrl: string
  models: ProviderModel[]
  defaultModel: string
  keyPlaceholder: string
  keyUrl: string
  keyLabel: string
  contextWindow: number
  groupRequired?: boolean
  groupLabel?: string
  groupPlaceholder?: string
}

export declare const PROVIDER_LIST: ProviderConfig[]
export declare const PROVIDERS: Record<string, ProviderConfig>
