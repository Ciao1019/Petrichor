import { api } from "@/lib/api-client"
import type { TableDataInfo } from "@/lib/api-core"

// ===== AI 模型接入：凭证 / 供应商 / 模型 / 用途绑定 =====

/** 模型用途 */
export type AiPurpose = "CHAT" | "VISION" | "DOC_QA" | "EMBEDDING"

/** 模型类型：语言模型（含多模态）/ 向量模型 */
export type AiModelKind = "LANGUAGE" | "EMBEDDING"

export type AiModelCapability = "tools" | "vision" | "reasoning" | "json"

export type AiProviderAccent =
  | "emerald" | "orange" | "blue" | "violet" | "amber" | "rose" | "cyan" | "slate"

/**
 * 语言模型协议。`chat` = /chat/completions，`responses` = /responses。
 * 只有 OpenAI / Azure / xAI 两套都支持，其余供应商固定一套。
 */
export type AiApiProtocol = "chat" | "responses"

/** 供应商目录里的额外凭证字段（Bedrock AK/SK、Vertex 服务账号等） */
export interface AiCredentialField {
  key: string
  label: string
  placeholder?: string
  required: boolean
  secret: boolean
}

export interface AiCatalogModel {
  id: string
  kind: AiModelKind
  label?: string
  contextWindow?: number
  capabilities?: AiModelCapability[]
}

/** 内置供应商目录条目 */
export interface AiProviderCatalogItem {
  key: string
  name: string
  description: string
  accent: AiProviderAccent
  defaultBaseUrl: string | null
  baseUrlRequired: boolean
  kinds: AiModelKind[]
  /** 可选协议；长度为 1 时界面不展示选择器 */
  apiProtocols: AiApiProtocol[]
  supportsModelListing: boolean
  credentialFields: AiCredentialField[]
  presetModels: AiCatalogModel[]
  docUrl: string
}

// ----- 凭证 -----

export interface AiCredentialResponse {
  id: string
  name: string
  providerKey: string | null
  providerName: string | null
  apiKeyMasked: string | null
  extraKeys: string[]
  usageCount: number
  lastUsedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface AiCredentialSaveRequest {
  id?: string
  name: string
  providerKey?: string | null
  /** 更新时留空表示不修改 */
  apiKey?: string
  extra?: Record<string, string>
}

// ----- 供应商实例 -----

export interface AiProviderResponse {
  id: string
  providerKey: string
  providerName: string
  accent: AiProviderAccent
  name: string
  baseUrl: string | null
  effectiveBaseUrl: string | null
  supportsModelListing: boolean
  kinds: AiModelKind[]
  apiProtocols: AiApiProtocol[]
  apiProtocol: AiApiProtocol
  credentialId: string
  credentialName: string | null
  enabled: boolean
  headers: Record<string, string>
  options: Record<string, unknown>
  modelCount: number
  enabledModelCount: number
  lastCheckedAt: string | null
  lastCheckStatus: string | null
  lastCheckMessage: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface AiProviderSaveRequest {
  id?: string
  providerKey: string
  name: string
  baseUrl?: string | null
  credentialId: string
  enabled?: boolean
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

/** 拉取模型列表：已保存的传 id，新建表单里的草稿传 providerKey + credentialId */
export interface AiProviderProbeRequest {
  id?: string
  providerKey?: string
  credentialId?: string
  baseUrl?: string | null
  headers?: Record<string, string>
  modelId?: string
  /** 连通性测试时临时切协议，不传则用供应商已保存的设置 */
  apiProtocol?: AiApiProtocol
}

export interface AiDiscoveredModel {
  modelId: string
  kind: AiModelKind
  label: string | null
  contextWindow: number
  /** 来自内置清单而非在线接口 */
  preset: boolean
  saved: boolean
  enabled: boolean
  /** 向量模型已探测到的维度；null 表示还没探测 */
  dimensions: number | null
}

export interface AiFetchModelsResponse {
  fetched: boolean
  warning: string | null
  items: AiDiscoveredModel[]
}

export interface AiProviderTestResponse {
  status: "OK" | "FAILED"
  latencyMs: number
  message: string
  sample: string | null
}

// ----- 模型 -----

export interface AiModelResponse {
  id: string
  providerId: string
  providerName: string | null
  providerKey: string | null
  modelId: string
  displayName: string | null
  kind: AiModelKind
  contextWindow: number | null
  /** 向量模型的输出维度；null 表示还没探测过 */
  dimensions: number | null
  capabilities: AiModelCapability[]
  enabled: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface AiModelSyncRequest {
  providerId: string
  models: {
    modelId: string
    displayName?: string | null
    kind: AiModelKind
    contextWindow?: number | null
    capabilities?: AiModelCapability[]
    enabled?: boolean
  }[]
}

// ----- 用途绑定 -----

export interface AiGenerationOptions {
  maxTokens: number | null
  temperature: number | null
  thinking: "enabled" | "disabled" | null
  disableThinkingForTools: boolean
}

export interface AiBindingResponse {
  id: string
  purpose: AiPurpose
  modelRefId: string
  modelId: string | null
  modelDisplayName: string | null
  providerId: string | null
  providerName: string | null
  providerKey: string | null
  contextWindow: number | null
  dimensions: number | null
  options: AiGenerationOptions
  updatedAt: string | null
}

export interface AiBindingSlot {
  purpose: AiPurpose
  requiredKind: AiModelKind
  binding: AiBindingResponse | null
}

export interface AiBindingSetRequest {
  purpose: AiPurpose
  modelRefId: string
  options?: Partial<AiGenerationOptions>
}

export const aiCredentialApi = {
  list: () => api.post<{ items: AiCredentialResponse[] }>("/ai/credential/list", {}),
  create: (data: AiCredentialSaveRequest) => api.post<AiCredentialResponse>("/ai/credential/create", data),
  update: (data: AiCredentialSaveRequest) => api.post<AiCredentialResponse>("/ai/credential/update", data),
  delete: (data: { id: string }) => api.post<void>("/ai/credential/delete", data),
}

export const aiProviderApi = {
  catalog: () => api.post<{ items: AiProviderCatalogItem[] }>("/ai/provider/catalog", {}),
  list: () => api.post<{ items: AiProviderResponse[] }>("/ai/provider/list", {}),
  create: (data: AiProviderSaveRequest) => api.post<AiProviderResponse>("/ai/provider/create", data),
  update: (data: AiProviderSaveRequest) => api.post<AiProviderResponse>("/ai/provider/update", data),
  delete: (data: { id: string }) => api.post<void>("/ai/provider/delete", data),
  test: (data: AiProviderProbeRequest) => api.post<AiProviderTestResponse>("/ai/provider/test", data),
  fetchModels: (data: AiProviderProbeRequest) => api.post<AiFetchModelsResponse>("/ai/provider/fetch-models", data),
  syncModels: (data: AiModelSyncRequest) => api.post<{ items: AiModelResponse[] }>("/ai/provider/sync-models", data),
}

export interface AiProbeDimensionsResponse {
  id: string
  modelId: string
  dimensions: number
  /** 维度超过 pgvector 的 HNSW 上限时为 false，检索会退化为顺序扫描 */
  indexable: boolean
  warning: string | null
}

export const aiModelApi = {
  list: (data: { providerId?: string; kind?: AiModelKind; enabledOnly?: boolean } = {}) =>
    api.post<{ items: AiModelResponse[] }>("/ai/model/list", data),
  toggle: (data: { id: string; enabled: boolean }) => api.post<AiModelResponse>("/ai/model/toggle", data),
  probeDimensions: (data: { id: string }) =>
    api.post<AiProbeDimensionsResponse>("/ai/model/probe-dimensions", data),
}

export const aiBindingApi = {
  list: () => api.post<{ items: AiBindingSlot[] }>("/ai/binding/list", {}),
  set: (data: AiBindingSetRequest) => api.post<AiBindingResponse>("/ai/binding/set", data),
  clear: (data: { purpose: AiPurpose }) => api.post<void>("/ai/binding/clear", data),
}

export interface NotificationSummaryResponse {
  unreadCount: number
  latestUnreadId?: string | null
}

export type NotificationReadStatus = "ALL" | "UNREAD" | "READ"

export interface NotificationListRequest {
  pageNum?: number
  pageSize?: number
  orderByColumn?: string
  isAsc?: string
  category?: string
  readStatus?: NotificationReadStatus
}

export interface NotificationItem {
  id: string
  category: string
  bizType: string
  bizId: string
  title: string
  content: string
  payload: Record<string, unknown>
  read: boolean
  readAt?: string | null
  createdAt: string
}

export interface NotificationReadRequest {
  notificationId: string
}

export interface NotificationReadResponse {
  notificationId: string
  readAt?: string | null
}

export interface NotificationReadAllRequest {
  category?: string
}

export interface NotificationReadAllResponse {
  updatedCount: number
  readAt?: string | null
}

export const notificationApi = {
  summary: () => api.get<NotificationSummaryResponse>("/notification/summary"),
  list: (data: NotificationListRequest) => api.post<TableDataInfo<NotificationItem>>("/notification/list", data),
  read: (data: NotificationReadRequest) => api.post<NotificationReadResponse>("/notification/read", data),
  readAll: (data: NotificationReadAllRequest) => api.post<NotificationReadAllResponse>("/notification/read-all", data),
}
