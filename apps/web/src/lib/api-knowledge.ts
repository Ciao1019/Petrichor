import { api } from "@/lib/api-client"
import type {
  KnowledgeBaseCreateRequest,
  KnowledgeBaseDeleteResponse,
  KnowledgeBaseListRequest,
  KnowledgeBaseResponse,
  KnowledgeBaseUpdateRequest,
  TableDataInfo,
} from "@/lib/api-core"

export type AgentApiKeyScope =
  | "article:write"
  | "article:delete"
  | "doc:read"
  | "qa:read"
  | "share:write"
  | "ai:write"
  | "wiki:read"
  | "wiki:write"

export interface AgentApiKeyItem {
  id: string
  name: string
  keyPrefix: string
  scopes: AgentApiKeyScope[]
  expiresAt?: string | null
  lastUsedAt?: string | null
  revokedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface AgentApiKeyListResponse {
  items: AgentApiKeyItem[]
}

export interface AgentApiKeyCreateRequest {
  name: string
  scopes?: AgentApiKeyScope[]
  expiresAt?: string | null
}

export interface AgentApiKeyCreateResponse {
  apiKey: string
  item: AgentApiKeyItem
}

export interface AgentApiKeyRevokeResponse {
  item: AgentApiKeyItem
}

export interface AgentCallLogItem {
  id: string
  apiKeyId: string
  apiKeyPrefix: string
  method: string
  path: string
  ip?: string | null
  userAgent?: string | null
  statusCode: number
  durationMs: number
  errorMessage?: string | null
  request: unknown
  response: unknown
  requestText?: string | null
  responseText?: string | null
  createdAt?: string | null
}

export interface AgentCallLogListResponse {
  items: AgentCallLogItem[]
}

export const agentApi = {
  listKeys: () => api.post<AgentApiKeyListResponse>("/agent/api-key/list", {}),
  createKey: (data: AgentApiKeyCreateRequest) => api.post<AgentApiKeyCreateResponse>("/agent/api-key/create", data),
  revokeKey: (id: string) => api.post<AgentApiKeyRevokeResponse>("/agent/api-key/revoke", { id }),
  listCallLogs: (data?: { limit?: number }) =>
    api.post<AgentCallLogListResponse>("/agent/call-log/list", data ?? {}),
}

export const knowledgeBaseApi = {
  list: (data: KnowledgeBaseListRequest) => api.post<TableDataInfo<KnowledgeBaseResponse>>("/kb/knowledge-base/list", data),
  create: (data: KnowledgeBaseCreateRequest) => api.post<KnowledgeBaseResponse>("/kb/knowledge-base/create", data),
  detail: (knowledgeBaseId: string) => api.post<KnowledgeBaseResponse>("/kb/knowledge-base/detail", { knowledgeBaseId }),
  update: (data: KnowledgeBaseUpdateRequest) => api.post<KnowledgeBaseResponse>("/kb/knowledge-base/update", data),
  delete: (knowledgeBaseId: string) => api.post<KnowledgeBaseDeleteResponse>("/kb/knowledge-base/delete", { knowledgeBaseId }),
}

export type KnowledgeBaseNodeType = "FOLDER" | "ARTICLE"

/** 文章公开分享状态：未分享 / 已公开 / 需密码 / 已过期 */
export type ArticleTreeShareStatus = "none" | "public" | "password" | "expired"

/** 文章在 LLM Wiki 中的编译状态：未收录 / 已同步 / 源文已更新待重编 */
export type ArticleTreeWikiStatus = "none" | "ready" | "stale"

/** 文章节点在知识库树中的状态徽标数据 */
export interface ArticleTreeStatus {
  hasMindmap: boolean
  shareStatus: ArticleTreeShareStatus
  wikiStatus: ArticleTreeWikiStatus
}

export interface KnowledgeBaseTreeNode {
  id: string
  parentId: string | null
  type: KnowledgeBaseNodeType
  name: string
  articleId?: string | null
  sortOrder: number
  hasChildren?: boolean
  children?: KnowledgeBaseTreeNode[]
  /** 仅文章节点返回：分享 / 思维导图 / LLM Wiki 状态 */
  status?: ArticleTreeStatus
}

export interface KnowledgeBaseTreeResponse {
  knowledgeBaseId: string
  pageNum?: number
  pageSize?: number
  totalFolders?: number
  roots: KnowledgeBaseTreeNode[]
}

export interface KnowledgeBaseChildrenResponse {
  knowledgeBaseId: string
  parentId: string | null
  nodes: KnowledgeBaseTreeNode[]
}

export interface KnowledgeBaseNodeDetailRequest {
  knowledgeBaseId: string
  nodeId: string
}

export interface KnowledgeBaseNodeDetailResponse {
  knowledgeBaseId: string
  nodeId: string
  parentId: string | null
  type: KnowledgeBaseNodeType
  name: string
  path: string
  articleId?: string | null
}

export interface CreateFolderRequest {
  knowledgeBaseId: string
  parentId?: string | null
  name: string
}

export interface CreateFolderResponse {
  nodeId: string
}

export interface UpdateFolderRequest {
  nodeId: string
  name: string
}

export interface UpdateFolderResponse {
  nodeId: string
}

export interface DeleteFolderResponse {
  nodeId: string
}

export interface MoveKnowledgeBaseNodeRequest {
  knowledgeBaseId: string
  nodeId: string
  targetParentId?: string | null
  targetIndex?: number
}

export interface MoveKnowledgeBaseNodeResponse {
  knowledgeBaseId: string
  nodeId: string
  parentId: string | null
  orderedNodeIds: string[]
}

export const knowledgeBaseNodeApi = {
  tree: (
    knowledgeBaseId: string,
    options?: {
      pageNum?: number
      pageSize?: number
      keyword?: string
      articleCreatedDateFrom?: string
      articleCreatedDateTo?: string
    },
  ) =>
    api.post<KnowledgeBaseTreeResponse>("/kb/node/tree", {
      knowledgeBaseId,
      ...(options || {}),
    }),
  roots: (
    knowledgeBaseId: string,
    options?: {
      pageNum?: number
      pageSize?: number
      keyword?: string
      articleCreatedDateFrom?: string
      articleCreatedDateTo?: string
    },
  ) =>
    api.post<KnowledgeBaseTreeResponse>("/kb/node/roots", {
      knowledgeBaseId,
      ...(options || {}),
    }),
  children: (knowledgeBaseId: string, options?: { parentId?: string | null }) =>
    api.post<KnowledgeBaseChildrenResponse>("/kb/node/children", {
      knowledgeBaseId,
      ...(options || {}),
    }),
  detail: (data: KnowledgeBaseNodeDetailRequest) => api.post<KnowledgeBaseNodeDetailResponse>("/kb/node/detail", data),
  createFolder: (data: CreateFolderRequest) => api.post<CreateFolderResponse>("/kb/node/create-folder", data),
  updateFolder: (data: UpdateFolderRequest) => api.post<UpdateFolderResponse>("/kb/node/update-folder", data),
  deleteFolder: (nodeId: string) => api.post<DeleteFolderResponse>("/kb/node/delete-folder", { nodeId }),
  move: (data: MoveKnowledgeBaseNodeRequest) => api.post<MoveKnowledgeBaseNodeResponse>("/kb/node/move", data),
}

export interface ArticleDetailResponse {
  articleId: string
  nodeId: string
  knowledgeBaseId: string
  parentId: string | null
  title: string
  contentMd: string
  contentJson?: string | null
  contentMetaJson?: string | null
  aiSummary?: string | null
  aiSummaryGeneratedAt?: string | null
  aiSummaryStale?: boolean
  tags: string[]
  path: string
  permission: "OWNER" | "EDITOR" | "VIEWER"
  readOnly: boolean
  createdAt: string
  updatedAt: string
}

export interface UpdateArticleRequest {
  articleId: string
  title: string
  contentMd: string
  contentJson?: string | null
  contentMetaJson?: string | null
  tags: string[]
}

export interface UpdateArticleResponse {
  articleId: string
  nodeId: string
}

export interface CreateArticleRequest {
  knowledgeBaseId: string
  parentId?: string | null
  title: string
  contentMd: string
  contentJson?: string | null
  contentMetaJson?: string | null
  tags?: string[]
}

export interface CreateArticleResponse {
  articleId: string
  nodeId: string
}

export interface DeleteArticleResponse {
  articleId: string
  nodeId: string
}

export interface ArticleSummaryGenerateRequest {
  articleId: string
  forceRebuild?: boolean
}

export interface ArticleSummaryGenerateResponse {
  articleId: string
  fromCache: boolean
  summary: string
  generatedAt?: string | null
}

export interface ArticlePublicCacheRefreshResponse {
  articleId: string
  refreshedAt: string
}

export const knowledgeBaseArticleApi = {
  create: (data: CreateArticleRequest) => api.post<CreateArticleResponse>("/kb/article/create", data),
  detail: (articleId: string) => api.post<ArticleDetailResponse>("/kb/article/detail", { articleId }),
  update: (data: UpdateArticleRequest) => api.post<UpdateArticleResponse>("/kb/article/update", data),
  delete: (articleId: string) => api.post<DeleteArticleResponse>("/kb/article/delete", { articleId }),
  generateSummary: (data: ArticleSummaryGenerateRequest) =>
    api.post<ArticleSummaryGenerateResponse>("/kb/article/summary/generate", data),
  refreshPublicCache: (articleId: string) =>
    api.post<ArticlePublicCacheRefreshResponse>("/kb/article/public-cache/refresh", { articleId }),
}

export interface ArticleShareCreateRequest {
  articleId: string
  expiresAt?: string | null
  passwordEnabled?: boolean | null
  accessPassword?: string | null
  isRepost?: boolean | null
  originalUrl?: string | null
  originalAuthorName?: string | null
  isInternalLink?: boolean | null
  internalUrl?: string | null
}

export interface ArticleShareCreateResponse {
  articleId: string
  shareCode: string
  enabled: boolean
  hasPassword: boolean
  expiresAt?: string | null
  isRepost: boolean
  originalUrl?: string | null
  originalAuthorName?: string | null
  internalUrl?: string | null
  updatedAt?: string | null
}

export interface ArticleShareRevokeRequest {
  articleId: string
}

export interface ArticleShareRevokeResponse {
  articleId: string
  enabled: boolean
  revokedAt?: string | null
}

export interface ArticleShareInfoRequest {
  articleId: string
}

export interface ArticleShareInfoResponse {
  articleId: string
  shareCode?: string | null
  enabled: boolean
  hasPassword: boolean
  expiresAt?: string | null
  isRepost: boolean
  originalUrl?: string | null
  originalAuthorName?: string | null
  internalUrl?: string | null
  pinOrder?: number | null
  isPinned?: boolean
  updatedAt?: string | null
}

export interface ArticleSharePinRequest {
  articleId: string
  pinOrder: number | null
}

export interface ArticleSharePinResponse {
  articleId: string
  pinOrder: number | null
  isPinned: boolean
  updatedAt?: string | null
}

export const knowledgeBaseArticleShareApi = {
  create: (data: ArticleShareCreateRequest) => api.post<ArticleShareCreateResponse>("/kb/article/share/create", data),
  revoke: (data: ArticleShareRevokeRequest) => api.post<ArticleShareRevokeResponse>("/kb/article/share/revoke", data),
  info: (data: ArticleShareInfoRequest) => api.post<ArticleShareInfoResponse>("/kb/article/share/info", data),
  setPin: (data: ArticleSharePinRequest) => api.post<ArticleSharePinResponse>("/kb/article/share/pin", data),
}

// 阅后即焚链接：与永久分享完全独立的一次性 / N 次访问通道。
export type BurnLinkStatus = "ACTIVE" | "BURNED" | "REVOKED"

export interface BurnLinkRecordResponse {
  id: string
  articleId: string
  linkCode: string
  maxViews: number
  viewCount: number
  hasPassword: boolean
  expiresAt?: string | null
  status: BurnLinkStatus
  burnedAt?: string | null
  revokedAt?: string | null
  createdAt: string
}

export interface BurnLinkCreateRequest {
  articleId: string
  maxViews?: number | null
  passwordEnabled?: boolean | null
  accessPassword?: string | null
  expiresAt?: string | null
}

export interface BurnLinkListResponse {
  items: BurnLinkRecordResponse[]
}

export const knowledgeBaseArticleBurnLinkApi = {
  create: (data: BurnLinkCreateRequest) => api.post<BurnLinkRecordResponse>("/kb/burn-link/create", data),
  list: (data: { articleId: string }) => api.post<BurnLinkListResponse>("/kb/burn-link/list", data),
  revoke: (data: { id: string }) => api.post<BurnLinkRecordResponse>("/kb/burn-link/revoke", data),
}

export interface ArticleMindMapGenerateRequest {
  articleId: string
  forceRebuild?: boolean
  mode?: ArticleMindMapMode
}

export type ArticleMindMapMode = "MINDMAP" | "KNOWLEDGE_GRAPH"

export interface ArticleMindMapGenerateResponse {
  articleId: string
  fromCache: boolean
  generatedAt: string | null
  data: unknown
}

export const knowledgeBaseArticleMindMapApi = {
  generate: (data: ArticleMindMapGenerateRequest) =>
    api.post<ArticleMindMapGenerateResponse>("/kb/article/mindmap/generate", data),
}
