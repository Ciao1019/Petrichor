import axios, { type AxiosResponse } from "axios"

import { installDemoAdapter } from "@/lib/demo/demo-adapter"

const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
})

// 演示模式（/demo）下把所有请求拦到内存 mock，非演示模式零开销直通网络。
installDemoAdapter(api)

export interface ApiErrorResponse {
  code: number
  msg: string
  path?: string
  timestamp?: string
}

function isAuthEndpoint(url: string) {
  return url.includes("/auth/login")
    || url.includes("/auth/register")
    || url.includes("/auth/linuxdo/callback")
}

function shouldRedirectToLoginOnUnauthorized(pathname: string) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/")
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status: number | undefined = error?.response?.status
    const data: ApiErrorResponse | undefined = error?.response?.data
    const code = data?.code

    const url: string = error?.config?.url || ""
    const browserLocation = typeof window === "undefined" ? null : window.location
    const shouldRedirectToLogin =
      browserLocation !== null &&
      !isAuthEndpoint(url) &&
      (status === 401 || code === 401) &&
      shouldRedirectToLoginOnUnauthorized(browserLocation.pathname)

    if (shouldRedirectToLogin && browserLocation) {
      const currentPath = browserLocation.pathname + browserLocation.search + browserLocation.hash
      const redirect = encodeURIComponent(currentPath)
      browserLocation.replace(`/login?redirect=${redirect}`)
    }

    return Promise.reject(error)
  },
)

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
  name: string
}

export type SystemRole = "USER" | "SUPER_ADMIN"

export interface UserResponse {
  id: string
  email: string
  systemRole: SystemRole
  userType: string
  linuxDoBound: boolean
  linuxDoUsername: string | null
  linuxDoEmail: string | null
  username: string | null
  nickname: string | null
  avatar: string | null
}

export interface UserProfileResponse extends UserResponse {
  signature?: string | null
  createdAt: string
  updatedAt: string
}

export interface AuthResponse {
  mode?: "login" | "bind"
  token: string
  user: UserResponse
}

export interface UserProfileUpdateRequest {
  nickname?: string | null
  avatar?: string | null
  signature?: string | null
}

export interface ChangePasswordRequest {
  currentPassword: string
  newPassword: string
}

export const authApi = {
  login: (data: LoginRequest) => api.post<AuthResponse>("/auth/login", data),
  register: (data: RegisterRequest) => api.post<AuthResponse>("/auth/register", data),
  logout: () => api.post("/auth/logout"),
  me: () => api.get<UserResponse>("/auth/me"),
  profile: () => api.get<UserProfileResponse>("/auth/profile"),
  updateProfile: (data: UserProfileUpdateRequest) => api.post<UserProfileResponse>("/auth/profile/update", data),
  changePassword: (data: ChangePasswordRequest) => api.post<void>("/auth/password/change", data),
  linuxDoCallback: (code: string, state?: string | null) => api.post<AuthResponse>("/auth/linuxdo/callback", { code, state }),
}

// 登录会话（多地登录）管理相关类型
export interface AuthSessionItem {
  id: string
  ip: string | null
  userAgent: string | null
  createdAt: string
  lastActiveAt: string
  expiresAt: string
  current: boolean
}

export interface AuthSessionListResponse {
  sessions: AuthSessionItem[]
  currentSessionId: string | null
}

export const authSessionApi = {
  list: () => api.get<AuthSessionListResponse>("/auth/sessions"),
  revoke: (data: { sessionId: string }) =>
    api.post<{ success: boolean }>("/auth/sessions/revoke", data),
  revokeOthers: () =>
    api.post<{ success: boolean; revokedCount: number }>("/auth/sessions/revoke-others", {}),
}

// 知识库相关类型
export interface KnowledgeBaseResponse {
  id: string
  name: string
  description: string
  chunkStrategy: KnowledgeBaseChunkStrategy
  chunkSize: number
  chunkOverlap: number
  chunkSeparators: string[]
  enableParentChild: boolean
  parentChunkSize: number
  childChunkSize: number
  chatModelId: string | null
  embeddingModelId: string | null
  rerankModelId: string | null
  wikiEnabled: boolean
  documentCount: number
  wikiPageCount: number
  createdAt: string
  updatedAt: string
}

export type KnowledgeBaseChunkStrategy = "auto" | "heading" | "heuristic" | "recursive" | "paragraph" | "fixed"

export interface ChunkPreviewItem {
  chunkIndex: number
  /** text 为可召回分片，parent_text 为仅回填上下文的父块。 */
  chunkType: "text" | "parent_text"
  text: string
  charCount: number
  tokenEstimate: number
  startOffset: number
  endOffset: number
  contextHeader: string
  parentChunkIndex: number | null
}

export interface KnowledgeBaseListRequest {
  pageNum?: number
  pageSize?: number
  orderByColumn?: string
  isAsc?: string
}

export interface KnowledgeBaseCreateRequest {
  name: string
  description?: string | null
  chunkStrategy?: KnowledgeBaseChunkStrategy
  chunkSize?: number
  chunkOverlap?: number
  chunkSeparators?: string[]
  enableParentChild?: boolean
  parentChunkSize?: number
  childChunkSize?: number
  chatModelId?: string | null
  embeddingModelId?: string | null
  rerankModelId?: string | null
  wikiEnabled?: boolean
}

export interface KnowledgeBaseUpdateRequest {
  knowledgeBaseId: string
  name: string
  description?: string | null
  chunkStrategy?: KnowledgeBaseChunkStrategy
  chunkSize?: number
  chunkOverlap?: number
  chunkSeparators?: string[]
  enableParentChild?: boolean
  parentChunkSize?: number
  childChunkSize?: number
  chatModelId?: string | null
  embeddingModelId?: string | null
  rerankModelId?: string | null
  wikiEnabled?: boolean
}

export interface KnowledgeBaseDeleteResponse {
  knowledgeBaseId: string
  storageCleanup: DocStorageCleanupSummary
}

export interface TableDataInfo<T> {
  total: number
  rows: T[]
  code: number
  msg: string
}

export interface AdminUserListRequest {
  pageNum?: number
  pageSize?: number
  orderByColumn?: string
  isAsc?: string
  keyword?: string
}

export interface AdminUserCreateRequest {
  email: string
  password: string
  name: string
  systemRole?: SystemRole
}

export interface AdminUserDeleteRequest {
  userId: string
}

export interface AdminUserItem {
  id: string
  email: string
  systemRole: SystemRole
  userType: string
  username?: string | null
  nickname?: string | null
  avatar?: string | null
  signature?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export const adminUserApi = {
  list: (data: AdminUserListRequest) => api.post<TableDataInfo<AdminUserItem>>("/admin/user/list", data),
  create: (data: AdminUserCreateRequest) => api.post<AdminUserItem>("/admin/user/create", data),
  delete: (data: AdminUserDeleteRequest) => api.post<void>("/admin/user/delete", data),
}

// 正文注记样式：red/orange/green/teal/blue/purple/pink 为手绘波浪下划线，yellow 为荧光笔高亮。
export type AboutAccentStyle = "red" | "orange" | "green" | "teal" | "blue" | "purple" | "pink" | "yellow"

export interface AboutAccent {
  phrase: string
  style: AboutAccentStyle
  note?: string
}

export interface AboutProfileResponse {
  displayName: string
  roleTitle: string
  intro: string
  expertise: string[]
  toolkit: string[]
  quote: string
  accents: AboutAccent[]
  contactText: string
  contactLabel: string
  contactHref: string
  createdAt?: string | null
  updatedAt?: string | null
}

export interface AboutProfileUpdateRequest {
  displayName: string
  roleTitle: string
  intro: string
  expertise: string[]
  toolkit: string[]
  quote: string
  accents: AboutAccent[]
  contactText: string
  contactLabel: string
  contactHref: string
}

export const publicAboutProfileApi = {
  detail: () => api.get<AboutProfileResponse>("/public/about/profile"),
}

export const adminAboutProfileApi = {
  detail: () => api.get<AboutProfileResponse>("/admin/about/profile"),
  update: (data: AboutProfileUpdateRequest) => api.post<AboutProfileResponse>("/admin/about/profile", data),
}

// 开源项目展示页：手绘马克笔圈词的墨色，与正文注记同色板。
export type ProjectStampColor = "red" | "orange" | "green" | "teal" | "blue" | "purple" | "pink"

export interface ProjectItem {
  name: string
  year: string
  stack: string[]
  stamp: string
  stampColor: ProjectStampColor
  blurb: string
  repoUrl: string
  siteUrl: string
}

export interface ProjectShowcaseResponse {
  heading: string
  intro: string
  items: ProjectItem[]
  createdAt?: string | null
  updatedAt?: string | null
}

export interface ProjectShowcaseUpdateRequest {
  heading: string
  intro: string
  items: ProjectItem[]
}

export const publicProjectShowcaseApi = {
  detail: (options?: { forceRefresh?: boolean }) => fetchPublicProjectShowcase(Boolean(options?.forceRefresh)),
  getCachedDetail: () => getFreshClientCacheValue(publicProjectShowcaseCache),
  invalidateClientCache: invalidatePublicProjectShowcaseClientCache,
}

export const adminProjectShowcaseApi = {
  detail: () => api.get<ProjectShowcaseResponse>("/admin/projects"),
  update: (data: ProjectShowcaseUpdateRequest) => api.post<ProjectShowcaseResponse>("/admin/projects", data),
}

export interface SiteAppearanceResponse {
  publicQaEnabled: boolean
  createdAt?: string | null
  updatedAt?: string | null
}

export interface SiteAppearanceUpdateRequest {
  publicQaEnabled: boolean
}

export const publicSiteAppearanceApi = {
  detail: () => api.get<SiteAppearanceResponse>("/public/appearance"),
}

export const adminSiteAppearanceApi = {
  detail: () => api.get<SiteAppearanceResponse>("/admin/appearance"),
  update: (data: SiteAppearanceUpdateRequest) => api.post<SiteAppearanceResponse>("/admin/appearance", data),
}

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

/** 文章节点在知识库树中的状态徽标数据 */
export interface ArticleTreeStatus {
  hasMindmap: boolean
  shareStatus: ArticleTreeShareStatus
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
  /** 仅文章节点返回：分享 / 思维导图状态 */
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

export type ArticleMindMapMode = "MINDMAP"

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

// 知识库文件 Wiki 与页面双链
export type KnowledgeBaseWikiPageKind = "index" | "summary" | "entity" | "concept"

export type KnowledgeBaseWikiJobStatus = "pending" | "running" | "completed" | "failed"
export type KnowledgeBaseWikiJobPhase = "queued" | "mapping" | "applying" | "reducing" | "organizing" | "finalizing" | "completed" | "failed"

export interface KnowledgeBaseWikiIngestJob {
  jobId: string
  knowledgeBaseId: string
  status: KnowledgeBaseWikiJobStatus
  totalDocuments: number
  processedDocuments: number
  phase: KnowledgeBaseWikiJobPhase
  currentDocument?: string | null
  totalPages: number
  processedPages: number
  warnings: string[]
  error?: string | null
  availableAt: string
  startedAt?: string | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgeBaseWikiPageResponse {
  id: string
  knowledgeBaseId: string
  pageKey: string
  title: string
  kind: KnowledgeBaseWikiPageKind
  contentMd: string
  frontmatter: unknown
  summary?: string | null
  contentHash: string
  /** 页面在 Wiki 目录树中的层级路径，空数组表示挂在根目录下。 */
  categoryPath: string[]
  sortOrder: number
  version: number
  archivedAt?: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface KnowledgeBaseWikiDocumentRef {
  id: string
  documentId: string
  documentTitle: string
  fileName: string
  chunkIndexes: number[]
  note?: string | null
}

export interface KnowledgeBaseWikiLink {
  id: string
  toPageKey: string
  linkType: string
}

export interface KnowledgeBaseWikiPageDetailResponse extends KnowledgeBaseWikiPageResponse {
  documentRefs: KnowledgeBaseWikiDocumentRef[]
  links: KnowledgeBaseWikiLink[]
}

export interface KnowledgeBaseWikiGraphNode {
  pageKey: string
  title: string
  kind: KnowledgeBaseWikiPageKind
  summary?: string | null
  linkCount: number
}

export interface KnowledgeBaseWikiGraphEdge {
  source: string
  target: string
  linkType: string
}

export interface KnowledgeBaseWikiLintIssue {
  severity: "error" | "warning" | "info"
  code: string
  pageKey: string
  title: string
  message: string
}

export interface KnowledgeBaseWikiLintResponse {
  score: number
  pageCount: number
  linkCount: number
  documentRefCount: number
  issueCount: number
  issues: KnowledgeBaseWikiLintIssue[]
  checkedAt: string
}

export interface KnowledgeBaseQaSummary {
  id: string
  name: string
  description?: string | null
}

export const knowledgeBaseWikiAgentApi = {
  pages: (knowledgeBaseId: string) =>
    api.post<{ knowledgeBaseId: string; pages: KnowledgeBaseWikiPageResponse[] }>("/kb/wiki/page/list", { knowledgeBaseId }),
  pageDetail: (knowledgeBaseId: string, pageKey: string) =>
    api.post<KnowledgeBaseWikiPageDetailResponse>("/kb/wiki/page/detail", { knowledgeBaseId, pageKey }),
  documentIngest: (data: { knowledgeBaseId: string; documentIds?: string[]; forceRebuild?: boolean }) =>
    api.post<KnowledgeBaseWikiIngestJob>("/kb/wiki/document-ingest", data),
  ingestStatus: (knowledgeBaseId: string, jobId?: string) =>
    api.post<{ job: KnowledgeBaseWikiIngestJob | null }>("/kb/wiki/ingest-status", { knowledgeBaseId, jobId }),
  graph: (knowledgeBaseId: string) =>
    api.post<{ nodes: KnowledgeBaseWikiGraphNode[]; edges: KnowledgeBaseWikiGraphEdge[] }>("/kb/wiki/graph", { knowledgeBaseId }),
  lint: (knowledgeBaseId: string) =>
    api.post<KnowledgeBaseWikiLintResponse>("/kb/wiki/lint", { knowledgeBaseId }),
}

export interface KnowledgeBaseQaModelOption {
  configId: string
  modelId: string
  modelName: string
  contextWindow: number | null
  isDefault: boolean
}

export interface KnowledgeBaseQaModelInfo {
  configId: string | null
  modelId: string | null
  modelName: string | null
  contextWindow: number | null
  availableModels: KnowledgeBaseQaModelOption[]
}

export const knowledgeBaseQaApi = {
  knowledgeBaseList: () =>
    api.post<{ knowledgeBases: KnowledgeBaseQaSummary[] }>("/kb/qa/knowledge-base/list", {}),
  modelInfo: () =>
    api.post<KnowledgeBaseQaModelInfo>("/kb/qa/model-info", {}),
}

// AI 模型配置相关类型
export type AiConfigType = "CHAT" | "VISION" | "EMBEDDING" | "RERANK" | "SPEECH"

export type AiProtocol = "OPENAI" | "DEEPSEEK" | "OPENAI_COMPAT" | "SILICONFLOW" | "GEMINI"

export interface AiModelConfigResponse {
  id: string
  configType: AiConfigType
  protocol: AiProtocol
  name: string
  baseUrl?: string | null
  hasApiKey: boolean
  apiKeyMasked?: string | null
  model: string
  enabled: boolean
  isDefault: boolean
  extraJson?: string | null
  createdAt: string
  updatedAt: string
}

export interface AiModelConfigListRequest {
  pageNum?: number
  pageSize?: number
  orderByColumn?: string
  isAsc?: string
  configType?: AiConfigType
  protocol?: AiProtocol
  enabled?: boolean
  keyword?: string
}

export interface AiModelConfigCreateRequest {
  configType: AiConfigType
  protocol: AiProtocol
  name: string
  baseUrl?: string
  apiKey?: string
  model: string
  enabled?: boolean
  isDefault?: boolean
  extraJson?: string
}

export interface AiModelConfigDetailRequest {
  id: string
}

export interface AiModelConfigUpdateRequest {
  id: string
  configType?: AiConfigType
  protocol?: AiProtocol
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  enabled?: boolean
  isDefault?: boolean
  extraJson?: string
}

export interface AiModelConfigDeleteRequest {
  id: string
}

export interface AiModelConfigSetDefaultRequest {
  id: string
}

export const aiModelConfigApi = {
  list: (data: AiModelConfigListRequest) => api.post<TableDataInfo<AiModelConfigResponse>>("/ai/config/list", data),
  create: (data: AiModelConfigCreateRequest) => api.post<AiModelConfigResponse>("/ai/config/create", data),
  detail: (data: AiModelConfigDetailRequest) => api.post<AiModelConfigResponse>("/ai/config/detail", data),
  update: (data: AiModelConfigUpdateRequest) => api.post<AiModelConfigResponse>("/ai/config/update", data),
  delete: (data: AiModelConfigDeleteRequest) => api.post<void>("/ai/config/delete", data),
  setDefault: (data: AiModelConfigSetDefaultRequest) => api.post<AiModelConfigResponse>("/ai/config/set-default", data),
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

export type AiReviewPeriod = "WEEK" | "MONTH"

export interface AiReviewStatsTopArticle {
  id: string
  title: string
  charCount: number
  isNew: boolean
  knowledgeBaseId: string | null
  knowledgeBaseName: string | null
  updatedAt: string
}

export interface AiReviewStatsTopTag {
  tag: string
  count: number
}

export interface AiReviewStatsKnowledgeBase {
  id: string
  name: string
  articleCount: number
}

export interface AiReviewEvolutionEntry {
  period: string
  title: string
  note: string
}

export interface AiReviewEvolution {
  topic: string
  synthesis: string
  entries: AiReviewEvolutionEntry[]
}

export interface AiReviewStats {
  newArticles: number
  updatedArticles: number
  totalChars: number
  knowledgeBaseCount: number
  topTags: AiReviewStatsTopTag[]
  topArticles: AiReviewStatsTopArticle[]
  knowledgeBases: AiReviewStatsKnowledgeBase[]
  evolution?: AiReviewEvolution | null
}

export interface AiReviewResponse {
  id: string | null
  period: AiReviewPeriod
  periodKey: string
  periodStart: string
  periodEnd: string
  stats: AiReviewStats
  narrative: string
  generatedAt: string | null
  modelConfigId: string | null
  regenerateCount: number
  canRegenerate: boolean
  hasActivity: boolean
  fromCache: boolean
}

export interface AiReviewGetRequest {
  period: AiReviewPeriod
  periodKey?: string
  forceRebuild?: boolean
}

export interface AiReviewListItem {
  id: string
  period: AiReviewPeriod
  periodKey: string
  periodStart: string
  periodEnd: string
  generatedAt: string
  statsSummary: {
    newArticles: number
    updatedArticles: number
    totalChars: number
  }
  narrativeExcerpt: string
}

export interface AiReviewListRequest {
  period?: AiReviewPeriod | ""
  pageNum?: number
  pageSize?: number
}

export interface AiReviewPeriodOption {
  key: string
  label: string
  isCurrent: boolean
  isDefault: boolean
}

export interface AiReviewPeriodOptionsResponse {
  week: AiReviewPeriodOption[]
  month: AiReviewPeriodOption[]
}

export const aiReviewApi = {
  get: (data: AiReviewGetRequest) => api.post<AiReviewResponse>("/ai/review/get", data),
  regenerate: (data: { period: AiReviewPeriod; periodKey?: string }) =>
    api.post<AiReviewResponse>("/ai/review/regenerate", data),
  list: (data: AiReviewListRequest) =>
    api.post<TableDataInfo<AiReviewListItem>>("/ai/review/list", data),
  periodOptions: () =>
    api.post<AiReviewPeriodOptionsResponse>("/ai/review/period-options", {}),
}

export const notificationApi = {
  summary: () => api.get<NotificationSummaryResponse>("/notification/summary"),
  list: (data: NotificationListRequest) => api.post<TableDataInfo<NotificationItem>>("/notification/list", data),
  read: (data: NotificationReadRequest) => api.post<NotificationReadResponse>("/notification/read", data),
  readAll: (data: NotificationReadAllRequest) => api.post<NotificationReadAllResponse>("/notification/read-all", data),
}

export interface PublicSharedArticleDetailRequest {
  shareCode: string
  accessPassword?: string | null
}

export interface PublicArticleTocItem {
  id: string
  level: number
  text: string
}

export interface PublicSharedArticleDetailResponse {
  title: string
  contentMd: string
  contentJson?: string | null
  contentMetaJson?: string | null
  tocJson?: PublicArticleTocItem[] | null
  aiSummary?: string | null
  aiSummaryGeneratedAt?: string | null
  aiSummaryStale?: boolean
  tags: string[]
  createdAt: string
  updatedAt: string
  isRepost: boolean
  originalUrl?: string | null
  originalAuthorName?: string | null
  mindmapData?: unknown | null
  mindmapGeneratedAt?: string | null
}

export interface PublicArticleListItem {
  articleId: string
  shareCode: string
  title: string
  excerpt: string
  updatedAt: string
  readingMinutes: number
  tags: string[]
  href: string
  expired: boolean
  expiresAt?: string | null
  hasPassword: boolean
  isRepost: boolean
  isInternalLink?: boolean
  isPinned?: boolean
  pinOrder?: number | null
}

export interface PublicArticleListResponse {
  items: PublicArticleListItem[]
}

export interface PublicArticleSearchItem extends PublicArticleListItem {
  score: number
}

export interface PublicArticleSearchResponse {
  keyword: string
  limit: number
  offset: number
  items: PublicArticleSearchItem[]
  hasMore: boolean
}

type ClientCacheEntry<T> = {
  expiresAt: number
  value: T
}

const publicArticleListCacheTtlMs = 60_000
const publicArticleDetailCacheTtlMs = 300_000
let publicArticleListCache: ClientCacheEntry<PublicArticleListResponse> | null = null
let publicArticleListRequest: Promise<AxiosResponse<PublicArticleListResponse>> | null = null
const publicArticleDetailCache = new Map<string, ClientCacheEntry<PublicSharedArticleDetailResponse>>()
const publicArticleDetailRequests = new Map<string, Promise<AxiosResponse<PublicSharedArticleDetailResponse>>>()

function createCachedAxiosResponse<T>(value: T): AxiosResponse<T> {
  return {
    data: value,
    status: 200,
    statusText: "OK",
    headers: {},
    config: {},
  } as AxiosResponse<T>
}

function getFreshClientCacheValue<T>(entry: ClientCacheEntry<T> | null | undefined, now = Date.now()) {
  return entry && entry.expiresAt > now ? entry.value : null
}

function fetchPublicArticleList(forceRefresh = false) {
  const cached = forceRefresh ? null : getFreshClientCacheValue(publicArticleListCache)
  if (cached) {
    return Promise.resolve(createCachedAxiosResponse(cached))
  }
  if (!forceRefresh && publicArticleListRequest) {
    return publicArticleListRequest
  }

  publicArticleListRequest = api.get<PublicArticleListResponse>("/public/article/list")
    .then((response) => {
      publicArticleListCache = {
        expiresAt: Date.now() + publicArticleListCacheTtlMs,
        value: response.data,
      }
      return response
    })
    .finally(() => {
      publicArticleListRequest = null
    })

  return publicArticleListRequest
}

function fetchPublicArticleDetailWithoutPassword(shareCode: string, forceRefresh = false) {
  const normalizedShareCode = shareCode.trim()
  const cached = forceRefresh ? null : getFreshClientCacheValue(publicArticleDetailCache.get(normalizedShareCode))
  if (cached) {
    return Promise.resolve(createCachedAxiosResponse(cached))
  }
  const inFlight = publicArticleDetailRequests.get(normalizedShareCode)
  if (!forceRefresh && inFlight) {
    return inFlight
  }

  const request = api.get<PublicSharedArticleDetailResponse>("/public/article/share/detail", {
    params: {
      shareCode: normalizedShareCode,
      ...(forceRefresh ? { _t: Date.now() } : {}),
    },
    ...(forceRefresh ? { headers: { "Cache-Control": "no-cache" } } : {}),
  })
    .then((response) => {
      publicArticleDetailCache.set(normalizedShareCode, {
        expiresAt: Date.now() + publicArticleDetailCacheTtlMs,
        value: response.data,
      })
      return response
    })
    .finally(() => {
      publicArticleDetailRequests.delete(normalizedShareCode)
    })
  publicArticleDetailRequests.set(normalizedShareCode, request)

  return request
}

function invalidatePublicArticleClientCache() {
  publicArticleListCache = null
  publicArticleListRequest = null
  publicArticleDetailCache.clear()
  publicArticleDetailRequests.clear()
}

const publicProjectShowcaseCacheTtlMs = 300_000
let publicProjectShowcaseCache: ClientCacheEntry<ProjectShowcaseResponse> | null = null
let publicProjectShowcaseRequest: Promise<AxiosResponse<ProjectShowcaseResponse>> | null = null

function fetchPublicProjectShowcase(forceRefresh = false) {
  const cached = forceRefresh ? null : getFreshClientCacheValue(publicProjectShowcaseCache)
  if (cached) {
    return Promise.resolve(createCachedAxiosResponse(cached))
  }
  if (!forceRefresh && publicProjectShowcaseRequest) {
    return publicProjectShowcaseRequest
  }

  publicProjectShowcaseRequest = api.get<ProjectShowcaseResponse>("/public/projects")
    .then((response) => {
      publicProjectShowcaseCache = {
        expiresAt: Date.now() + publicProjectShowcaseCacheTtlMs,
        value: response.data,
      }
      return response
    })
    .finally(() => {
      publicProjectShowcaseRequest = null
    })

  return publicProjectShowcaseRequest
}

function invalidatePublicProjectShowcaseClientCache() {
  publicProjectShowcaseCache = null
  publicProjectShowcaseRequest = null
}

export const publicArticleShareApi = {
  list: (options?: { forceRefresh?: boolean }) => fetchPublicArticleList(Boolean(options?.forceRefresh)),
  getCachedList: () => getFreshClientCacheValue(publicArticleListCache),
  search: (params: { keyword: string; limit?: number; offset?: number; signal?: AbortSignal }) =>
    api.get<PublicArticleSearchResponse>("/public/article/search", {
      params: {
        q: params.keyword,
        ...(params.limit != null ? { limit: params.limit } : {}),
        ...(params.offset != null ? { offset: params.offset } : {}),
      },
      signal: params.signal,
    }),
  detail: (shareCode: string, accessPassword?: string | null, options?: { forceRefresh?: boolean }) =>
    accessPassword?.trim()
      ? api.post<PublicSharedArticleDetailResponse>("/public/article/share/detail", {
        shareCode,
        accessPassword: accessPassword.trim(),
      }).then((response) => {
        publicArticleDetailCache.delete(shareCode.trim())
        return response
      })
      : fetchPublicArticleDetailWithoutPassword(shareCode, Boolean(options?.forceRefresh)),
  getCachedDetail: (shareCode: string) => getFreshClientCacheValue(publicArticleDetailCache.get(shareCode.trim())),
  prefetchDetail: (shareCode: string) => {
    const normalizedShareCode = shareCode.trim()
    if (!normalizedShareCode || getFreshClientCacheValue(publicArticleDetailCache.get(normalizedShareCode))) {
      return Promise.resolve()
    }
    return fetchPublicArticleDetailWithoutPassword(normalizedShareCode)
      .then(() => undefined)
      .catch(() => undefined)
  },
  invalidateClientCache: invalidatePublicArticleClientCache,
  resetClientCacheForTests: invalidatePublicArticleClientCache,
}

// ===== 阅后即焚公开访问（不缓存、不预取，焚毁靠用户显式确认触发）=====

export type PublicBurnState = "ACTIVE" | "BURNED" | "REVOKED" | "EXPIRED" | "NOT_FOUND"

export interface PublicBurnMetaResponse {
  state: PublicBurnState
  requiresPassword: boolean
  remainingViews?: number
  coverImageUrl?: string | null
}

export interface PublicBurnConsumeResponse extends PublicSharedArticleDetailResponse {
  burn: {
    viewCount: number
    maxViews: number
    burned: boolean
  }
}

export const publicBurnApi = {
  // GET 仅返回状态/是否需要密码，绝不返回正文，禁用一切缓存。
  meta: (code: string) =>
    api.get<PublicBurnMetaResponse>("/public/burn/meta", {
      params: { code },
      headers: { "Cache-Control": "no-cache" },
    }),
  // POST 显式消费一次阅读：命中返回正文，达上限即焚。
  consume: (code: string, accessPassword?: string | null) =>
    api.post<PublicBurnConsumeResponse>("/public/burn/consume", {
      code,
      ...(accessPassword?.trim() ? { accessPassword: accessPassword.trim() } : {}),
    }),
}

export default api

// ===== S3 文件上传 =====

export interface PresignPutRequest {
  filename: string
}

export interface PresignPutResponse {
  presignedUrl: string
  objectKey: string
}

export interface PresignGetRequest {
  objectKey: string
}

export interface PresignGetResponse {
  url: string
}

export const uploadApi = {
  /** 获取预签名上传 URL，前端直接 PUT 文件到 S3 */
  presignPut: (data: PresignPutRequest) =>
    api.post<PresignPutResponse>("/upload/presign-put", data),

  /** 获取具有时效的预签名下载 URL（防盗链，需要登录） */
  presignGet: (objectKey: string) =>
    api.post<PresignGetResponse>("/upload/presign-get", { objectKey }),

  /** 公开版：获取预签名下载 URL，用于公开分享文章的附件（无需登录） */
  publicPresignGet: (objectKey: string) =>
    api.post<PresignGetResponse>("/public/upload/presign-get", { objectKey }),
}

// ===== 文档导入（PDF / Word → 多模态 → 文章） =====

export type DocumentImportSourceType = "pdf"

/** 页内容来源：pdf = pdf-inspector 本地抽取，vision = 多模态识别兜底 */
export type DocumentImportExtractedBy = "pdf" | "vision"

export type DocumentImportJobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "canceled"

export type DocumentImportPageStatus = "pending" | "done" | "failed"

export interface DocumentImportJobResponse {
  id: string
  knowledgeBaseId: string
  knowledgeBaseName: string | null
  parentNodeId: string | null
  parentFolderName: string | null
  sourceType: DocumentImportSourceType
  fileName: string
  title: string
  totalPages: number
  processedPages: number
  donePages: number
  failedPages: number
  pendingPages: number
  status: DocumentImportJobStatus
  modelConfigId: string | null
  articleId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface DocumentImportPageResponse {
  pageNo: number
  /** 仅 OCR 兜底页有整页图，本地抽取的文字页为 null */
  imageKey: string | null
  extractedBy: DocumentImportExtractedBy
  status: DocumentImportPageStatus
  markdown: string | null
  error: string | null
}

export interface DocumentImportCreateRequest {
  knowledgeBaseId: string
  parentId?: string | null
  fileName: string
  title: string
  /** 原始 PDF 预签名直传后的对象 key */
  sourceKey: string
  modelConfigId?: string | null
  concurrency?: number
}

export interface DocumentImportCreateResponse {
  job: DocumentImportJobResponse
  /** 需要多模态兜底的 1-indexed 页码；为空表示本地抽取已全量完成 */
  ocrPageNos: number[]
  /** 检测到表格或多栏排版 */
  isComplex: boolean
  /** 无 OCR 页时服务端已直接生成文章 */
  articleId: string | null
}

export interface DocumentImportConvertResponse {
  page: DocumentImportPageResponse
  processedPages: number
  status: DocumentImportJobStatus
}

export const documentImportApi = {
  createJob: (data: DocumentImportCreateRequest) =>
    api.post<DocumentImportCreateResponse>("/kb/import/create", data),
  attachOcrPages: (data: {
    jobId: string
    pages: { pageNo: number; imageKey: string }[]
    concurrency?: number
  }) => api.post<{ attached: number; status: DocumentImportJobStatus }>("/kb/import/attach-ocr", data),
  convertPage: (data: { jobId: string; pageNo: number }) =>
    api.post<DocumentImportConvertResponse>("/kb/import/page-convert", data),
  retryPage: (data: { jobId: string; pageNo: number }) =>
    api.post<DocumentImportConvertResponse>("/kb/import/retry-page", data),
  retryFailedPages: (data: { jobId: string }) =>
    api.post<{ retried: number; status: DocumentImportJobStatus }>("/kb/import/retry-failed", data),
  finalize: (data: { jobId: string }) =>
    api.post<{ articleId: string; nodeId: string | null }>("/kb/import/finalize", data),
  cancel: (data: { jobId: string }) =>
    api.post<{ id: string; status: DocumentImportJobStatus }>("/kb/import/cancel", data),
  deleteMany: (data: { ids: string[] }) =>
    api.post<{ deleted: string[] }>("/kb/import/delete", data),
  list: (data: { knowledgeBaseId?: string; pageNum?: number; pageSize?: number }) =>
    api.post<TableDataInfo<DocumentImportJobResponse>>("/kb/import/list", data),
  detail: (data: { jobId: string }) =>
    api.post<{ job: DocumentImportJobResponse; pages: DocumentImportPageResponse[] }>(
      "/kb/import/detail",
      data,
    ),
}

// 仪表盘总览相关类型
export interface DashboardHeatmapPoint {
  date: string
  count: number
}

export interface DashboardTrendPoint {
  date: string
  article: number
  qa: number
  agent: number
  total: number
}

export interface DashboardDistributionItem {
  label: string
  count: number
}

export interface DashboardGrowthPoint {
  month: string
  articles: number
  words: number
}

/** 创作节律格子：星期与小时都是 UTC，前端按浏览器时区折算后再展示 */
export interface DashboardRhythmCell {
  weekday: number
  hour: number
  count: number
}

export interface DashboardKpiTile {
  key: string
  label: string
  /** 累计总量 */
  value: number
  /** 近 7 天新增 */
  current: number
  /** 前 7 天新增 */
  previous: number
  /** 环比百分比；上一周期为 0 时为 null（无可比基数） */
  delta: number | null
  /** 最近 14 天迷你走势 */
  spark: number[]
  unit?: string
}

export interface DashboardStatItem {
  key: string
  label: string
  value: number
  hint?: string
}

export interface DashboardAgentPathStat {
  path: string
  method: string
  count: number
  avgMs: number
  errorCount: number
}

export interface DashboardAgentDailyPoint {
  date: string
  count: number
  avgMs: number
  errors: number
}

export interface DashboardToolStat {
  name: string
  count: number
  okCount: number
  avgMs: number
}

export interface DashboardStatusBucket {
  status: string
  count: number
}

export interface DashboardActivityItem {
  kind: "article" | "thread"
  id: string
  title: string
  subtitle: string | null
  at: string
}

export interface DashboardOverviewResponse {
  generatedAt: string
  kpis: {
    primary: DashboardKpiTile[]
    secondary: DashboardStatItem[]
  }
  heatmap: {
    points: DashboardHeatmapPoint[]
    start: string
    end: string
    total: number
  }
  /** 365 天全量，前端按所选范围切片 */
  trend: DashboardTrendPoint[]
  growth: DashboardGrowthPoint[]
  rhythm: {
    cells: DashboardRhythmCell[]
    total: number
  }
  distribution: {
    knowledgeBases: DashboardDistributionItem[]
    tags: DashboardDistributionItem[]
  }
  assets: DashboardDistributionItem[]
  agent: {
    windowDays: number
    totalCalls: number
    successCalls: number
    clientErrors: number
    serverErrors: number
    successRate: number
    avgDurationMs: number
    maxDurationMs: number
    topPaths: DashboardAgentPathStat[]
    daily: DashboardAgentDailyPoint[]
  }
  tools: {
    windowDays: number
    items: DashboardToolStat[]
  }
  pipeline: {
    documents: DashboardStatusBucket[]
    imports: DashboardStatusBucket[]
    documentTotal: number
    documentBytes: number
    documentPages: number
    importTotal: number
  }
  recentActivity: DashboardActivityItem[]
  recentThreads: AssistantThreadSummary[]
}

export const dashboardApi = {
  /** 加载仪表盘大屏总览：KPI、热力图、趋势、增长、节律、分布、Agent 健康与最近动态 */
  overview: () => api.post<DashboardOverviewResponse>("/dashboard/overview", {}),
}

export interface DocStorageCleanupFailure {
  errorMessage: string
  objectKey: string
  status?: number
}

export interface DocStorageCleanupSummary {
  deletedObjectKeys: string[]
  failedObjectKeys: DocStorageCleanupFailure[]
}

export interface DocDeleteResponse {
  id: string
  storageCleanup: DocStorageCleanupSummary
}

// ===== 知识库文件语料 =====

export type KBDocumentFileType = "md" | "markdown" | "pdf" | "docx" | "xlsx" | "xls" | "csv" | "tsv"
export type KBDocumentStatus = "pending" | "processing" | "ready" | "partial" | "failed"

export interface KBDocumentFolder {
  id: string
  knowledgeBaseId: string
  parentId: string | null
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface KBDocument {
  id: string
  knowledgeBaseId: string
  folderId: string | null
  fileName: string
  title: string
  fileType: KBDocumentFileType
  contentType: string | null
  objectKey: string
  sizeBytes: number | null
  pageCount: number | null
  charCount: number | null
  chunkCount: number
  summary: string | null
  status: KBDocumentStatus
  error: string | null
  tags?: string[] | null
  createdAt: string
  updatedAt: string
}

export interface KBDocumentChunk {
  id: string
  chunkIndex: number
  page: number | null
  locator: string | null
  contextHeader: string | null
  startOffset: number | null
  endOffset: number | null
  text: string
  charCount: number
  tokenEstimate: number
  /** text = 可召回文本片，parent_text = 只回填上下文，image = 多模态识别出的整页文本 */
  chunkType?: string
  /** 父块在同一文档内的 chunkIndex；开启父子分块时才有 */
  parentChunkIndex?: number | null
  /** AI 为该分片生成的辅助召回问题 */
  questions?: KBChunkQuestion[] | null
}

export interface KBChunkQuestion {
  id: string
  question: string
}

export interface KBDocumentDetail extends KBDocument {
  charCount: number | null
  blocks: unknown[]
  extractedText: string | null
  chunks: KBDocumentChunk[]
  summary: string | null
  parseConfig?: KBDocumentParseConfig
  parseAttempt?: number
}

/** 解析引擎：auto = 本地优先、扫描页交给图像处理，local = 只做本地抽取，scan = 整份按扫描件逐页识别 */
export type KBParseEngine = "auto" | "local" | "scan"

export interface KBDocumentParseConfig {
  tags?: string[]
  parseEngine: KBParseEngine
  chunking: {
    strategy?: KnowledgeBaseChunkStrategy
    chunkSize?: number
    chunkOverlap?: number
    separators?: string[]
    enableParentChild?: boolean
    parentChunkSize?: number
    childChunkSize?: number
  }
  multimodal: { enabled: boolean; modelConfigId?: string | null }
  questionGeneration: { enabled: boolean; questionCount: number; customInstructions?: string }
}

/** 浏览器栅格化后直传对象存储的整页图片，交给多模态识别阶段 */
export interface KBDocumentPageImage {
  pageNo: number
  imageKey: string
}

export interface KBDocumentRegisterRequest {
  knowledgeBaseId: string
  folderId?: string | null
  fileName: string
  title?: string | null
  fileType: KBDocumentFileType
  contentType?: string | null
  objectKey: string
  sizeBytes?: number | null
  pageCount?: number | null
  blocks?: unknown[]
  extractedText?: string | null
  /** 正文里的页 / 工作表边界；分块由服务端按知识库配置执行。 */
  segments?: { startOffset: number; page?: number | null; locator?: string | null }[]
  summary?: string | null
  parseConfig?: KBDocumentParseConfig
  pageImages?: KBDocumentPageImage[]
}

// ===== 解析流水线 =====

export type KBSpanKind = "root" | "stage" | "subspan" | "generation"
export type KBSpanStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled"

export interface KBSpanNode {
  spanId: string
  parentSpanId?: string
  name: string
  kind: KBSpanKind
  status: KBSpanStatus
  input?: unknown
  output?: unknown
  errorCode?: string
  errorMessage?: string
  startedAt?: string
  finishedAt?: string
  durationMs: number
  /** 该阶段没有真实记录，只是为了让时间线保持五段而合成的占位节点 */
  placeholder?: boolean
  children?: KBSpanNode[]
}

export interface KBDocumentSpansResponse {
  documentId: string
  status: KBDocumentStatus
  attempt: number
  latestAttempt: number
  currentStage: string
  parseConfig: KBDocumentParseConfig
  trace: KBSpanNode
  lastError?: { stage: string; code: string; message: string }
}

export const knowledgeBaseDocumentApi = {
  listFolders: (knowledgeBaseId: string) =>
    api.post<{ folders: KBDocumentFolder[] }>("/kb/document-folder/list", { knowledgeBaseId }),
  saveFolder: (data: { id?: string; knowledgeBaseId: string; parentId?: string | null; name: string }) =>
    api.post<{ id: string }>("/kb/document-folder/save", data),
  deleteFolder: (id: string, recursive = false) =>
    api.post<{ id: string; movedDocuments: number; movedFolders: number }>("/kb/document-folder/delete", { id, recursive }),
  listDocuments: (knowledgeBaseId: string) =>
    api.post<{ documents: KBDocument[] }>("/kb/document/list", { knowledgeBaseId }),
  /** 登记文件后立即返回；解析、向量化、多模态与问题生成在服务端后台跑，用 documentSpans 轮询进度。 */
  registerDocument: (data: KBDocumentRegisterRequest) =>
    api.post<{ id: string; attempt: number; status: KBDocumentStatus }>("/kb/document/register", data),
  documentSpans: (id: string, attempt?: number) =>
    api.post<KBDocumentSpansResponse>("/kb/document/spans", { id, attempt }),
  /** 手工补一条辅助召回问题，服务端会立即向量化 */
  addChunkQuestion: (chunkId: string, question: string) =>
    api.post<{ chunkId: string; questions: KBChunkQuestion[] }>("/kb/chunk/question/add", { chunkId, question }),
  deleteChunkQuestion: (id: string) =>
    api.post<{ chunkId: string; questions: KBChunkQuestion[] }>("/kb/chunk/question/delete", { id }),
  /** 只为这一个分片重新生成问题，不需要重解析整份文档 */
  regenerateChunkQuestions: (chunkId: string) =>
    api.post<{ chunkId: string; questions: KBChunkQuestion[] }>("/kb/chunk/question/regenerate", { chunkId }),
  listTags: (knowledgeBaseId: string) =>
    api.post<{ tags: Array<{ tag: string; count: number }> }>("/kb/document/tag/list", { knowledgeBaseId }),
  saveTags: (id: string, tags: string[]) =>
    api.post<{ id: string; tags: string[] }>("/kb/document/tag/save", { id, tags }),
  documentDetail: (id: string) => api.post<{ document: KBDocumentDetail }>("/kb/document/detail", { id }),
  moveDocument: (id: string, folderId: string | null) =>
    api.post<{ id: string }>("/kb/document/move", { id, folderId }),
  deleteDocument: (id: string) => api.post<DocDeleteResponse>("/kb/document/delete", { id }),
  chunkPreview: (data: {
    knowledgeBaseId: string
    text: string
    strategy?: KnowledgeBaseChunkStrategy
    chunkSize?: number
    chunkOverlap?: number
    separators?: string[]
    enableParentChild?: boolean
    parentChunkSize?: number
    childChunkSize?: number
  }) => api.post<{ chunks: ChunkPreviewItem[]; retrievableCount: number }>("/kb/chunk/preview", data),
  /** 重新解析：尝试号 +1 并重跑完整流水线，parseConfig 省略时沿用上次的配置。 */
  rechunkDocument: (data: { id: string; parseConfig?: KBDocumentParseConfig; pageImages?: KBDocumentPageImage[] }) =>
    api.post<{ id: string; attempt: number; status: KBDocumentStatus }>("/kb/document/rechunk", data),
  embeddingStatus: (knowledgeBaseId: string) =>
    api.post<{ status: { supported: boolean; total: number; embedded: number; pending: number } }>("/kb/document/embedding/status", { knowledgeBaseId }),
  runEmbedding: (knowledgeBaseId: string, documentId?: string, rebuild = false) =>
    api.post<{ embedded: number; status: { supported: boolean; total: number; embedded: number; pending: number } }>("/kb/document/embedding/run", { knowledgeBaseId, documentId, rebuild }),
}

// 站内 Assistant：类型形状与 Go API 的 assistant handlers 保持一致。
export interface AssistantFocus {
  knowledgeBaseId?: string | null
  articleId?: string | null
  documentId?: string | null
}

export interface AssistantThreadSummary {
  id: string
  title: string
  focus: AssistantFocus | null
  createdAt: string
  updatedAt: string
}

export interface AssistantThreadListResponse {
  items: AssistantThreadSummary[]
  nextCursor: number | null
}

export interface AssistantThreadMessage {
  id: string
  role: string
  content: unknown
  createdAt: string
}

export interface AssistantPersistedPlan {
  id: string
  title: string
  description?: string
  todos: Array<{
    id: string
    label: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
    description?: string
  }>
  maxVisibleTodos?: number
}

export interface AssistantThreadDetailResponse {
  thread: AssistantThreadSummary
  messages: AssistantThreadMessage[]
  plans?: AssistantPersistedPlan[]
}

export const assistantApi = {
  threadList: (params: { cursor?: number; limit?: number; q?: string } = {}) =>
    api.post<AssistantThreadListResponse>("/assistant/thread/list", params),
  threadDetail: (threadId: string) =>
    api.post<AssistantThreadDetailResponse>("/assistant/thread/detail", { threadId }),
  threadCreate: (data: { title?: string | null; focus?: AssistantFocus | null } = {}) =>
    api.post<{ thread: AssistantThreadSummary }>("/assistant/thread/create", data),
  threadDelete: (threadId: string) =>
    api.post<{ ok: true }>("/assistant/thread/delete", { threadId }),
  threadDeleteMany: (threadIds: string[]) =>
    api.post<{ deleted: number }>("/assistant/thread/delete-many", { threadIds }),
  planTodoPatch: (data: {
    threadId: string
    planId: string
    todoId: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
  }) => api.post<{ plan: AssistantPersistedPlan }>("/assistant/plan/patch", data),
}
