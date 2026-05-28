import axios, { type AxiosResponse } from "axios"

const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
})

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
    || url.includes("/auth/two-factor/")
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
  twoFactorEnabled?: boolean
  createdAt: string
  updatedAt: string
}

export interface AuthResponse {
  mode?: "login" | "bind"
  token: string
  user: UserResponse
}

export interface AuthLoginResponse {
  mode?: "login" | "bind"
  token?: string
  user?: UserResponse
  twoFactorRequired?: boolean
}

export interface TwoFactorEnableRequest {
  password: string
  issuer?: string
}

export interface TwoFactorEnableResponse {
  totpURI: string
  backupCodes: string[]
}

export interface TwoFactorVerifyTotpRequest {
  code: string
  trustDevice?: boolean
}

export interface TwoFactorVerifyBackupCodeRequest {
  code: string
  trustDevice?: boolean
  disableSession?: boolean
}

export interface TwoFactorGenerateBackupCodesResponse {
  status: boolean
  backupCodes: string[]
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
  login: (data: LoginRequest) => api.post<AuthLoginResponse>("/auth/login", data),
  register: (data: RegisterRequest) => api.post<AuthResponse>("/auth/register", data),
  logout: () => api.post("/auth/logout"),
  me: () => api.get<UserResponse>("/auth/me"),
  profile: () => api.get<UserProfileResponse>("/auth/profile"),
  updateProfile: (data: UserProfileUpdateRequest) => api.post<UserProfileResponse>("/auth/profile/update", data),
  changePassword: (data: ChangePasswordRequest) => api.post<void>("/auth/password/change", data),
  linuxDoCallback: (code: string, state?: string | null) => api.post<AuthResponse>("/auth/linuxdo/callback", { code, state }),
}

export const twoFactorApi = {
  enable: (data: TwoFactorEnableRequest) =>
    api.post<TwoFactorEnableResponse>("/auth/two-factor/enable", data),
  disable: (data: { password: string }) =>
    api.post<{ status: boolean }>("/auth/two-factor/disable", data),
  verifyTotp: (data: TwoFactorVerifyTotpRequest) =>
    api.post<{ token: string; user: UserResponse }>("/auth/two-factor/verify-totp", data),
  verifyBackupCode: (data: TwoFactorVerifyBackupCodeRequest) =>
    api.post<{ token?: string; user: UserResponse }>("/auth/two-factor/verify-backup-code", data),
  generateBackupCodes: (data: { password: string }) =>
    api.post<TwoFactorGenerateBackupCodesResponse>("/auth/two-factor/generate-backup-codes", data),
}

// 知识库相关类型
export interface KnowledgeBaseResponse {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
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
}

export interface KnowledgeBaseUpdateRequest {
  knowledgeBaseId: string
  name: string
  description?: string | null
}

export interface KnowledgeBaseDeleteResponse {
  knowledgeBaseId: string
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

export interface AboutProfileResponse {
  displayName: string
  roleTitle: string
  intro: string
  expertise: string[]
  toolkit: string[]
  quote: string
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
}

export const publicAboutProfileApi = {
  detail: () => api.get<AboutProfileResponse>("/public/about/profile"),
}

export const adminAboutProfileApi = {
  detail: () => api.get<AboutProfileResponse>("/admin/about/profile"),
  update: (data: AboutProfileUpdateRequest) => api.post<AboutProfileResponse>("/admin/about/profile", data),
}

export interface SiteAppearanceResponse {
  dayTheme: string
  nightTheme: string
  dayStartHour: number
  dayEndHour: number
  allowManualOverride: boolean
  createdAt?: string | null
  updatedAt?: string | null
}

export interface SiteAppearanceUpdateRequest {
  dayTheme: string
  nightTheme: string
  dayStartHour: number
  dayEndHour: number
  allowManualOverride: boolean
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
  agentSource: string
  agentTool?: string | null
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
  listCallLogs: (data?: { agentSource?: string; limit?: number }) =>
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

export interface KnowledgeBaseTreeNode {
  id: string
  parentId: string | null
  type: KnowledgeBaseNodeType
  name: string
  articleId?: string | null
  sortOrder: number
  hasChildren?: boolean
  children?: KnowledgeBaseTreeNode[]
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

// 文档问答 Agent / Wiki 编译层
export type KnowledgeBaseWikiPageKind =
  | "index"
  | "source"
  | "concept"
  | "entity"
  | "comparison"
  | "answer"
  | "log"

export type KnowledgeBaseWikiPatchStatus = "PENDING" | "APPLIED" | "REJECTED"

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
  version: number
  archivedAt?: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface KnowledgeBaseWikiSourceRef {
  id: string
  articleId: string
  articleTitle: string
  anchor?: string | null
  note?: string | null
}

export interface KnowledgeBaseWikiLink {
  id: string
  toPageKey: string
  linkType: string
}

export interface KnowledgeBaseWikiPageDetailResponse extends KnowledgeBaseWikiPageResponse {
  sourceRefs: KnowledgeBaseWikiSourceRef[]
  links: KnowledgeBaseWikiLink[]
}

export interface KnowledgeBaseWikiPatchResponse {
  id: string
  knowledgeBaseId: string
  threadId?: string | null
  runId?: string | null
  pageKey: string
  title: string
  operation: "CREATE" | "UPDATE" | string
  status: KnowledgeBaseWikiPatchStatus
  beforeContentMd?: string | null
  proposedContentMd: string
  diffText: string
  reason?: string | null
  appliedAt?: string | null
  createdAt: string | null
  updatedAt: string | null
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
  sourceRefCount: number
  issueCount: number
  issues: KnowledgeBaseWikiLintIssue[]
  checkedAt: string
}

export interface KnowledgeBaseAgentThreadResponse {
  id: string
  knowledgeBaseId: string | null
  knowledgeBaseName?: string | null
  title: string
  status: string
  lastMessageAt?: string | null
  metadata: unknown
  createdAt: string | null
  updatedAt: string | null
}

export interface KnowledgeBaseAgentMessageResponse {
  id: string
  role: "user" | "assistant" | "system" | "tool" | string
  contentText: string
  content: unknown
  metadata: unknown
  createdAt: string | null
}

export interface KnowledgeBaseAgentThreadDetailResponse {
  thread: KnowledgeBaseAgentThreadResponse
  messages: KnowledgeBaseAgentMessageResponse[]
}

export interface KnowledgeBaseAgentArtifactResponse {
  id: string
  threadId: string
  runId?: string | null
  knowledgeBaseId: string | null
  artifactType: string
  title: string
  payload: unknown
  contentMd?: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface KnowledgeBaseQaSummary {
  id: string
  name: string
  description?: string | null
}

export interface KnowledgeBaseWikiDashboardResponse {
  knowledgeBase: KnowledgeBaseResponse | null
  pages: KnowledgeBaseWikiPageResponse[]
  threads: KnowledgeBaseAgentThreadResponse[]
  pendingPatches: KnowledgeBaseWikiPatchResponse[]
  lint: KnowledgeBaseWikiLintResponse
  artifacts: KnowledgeBaseAgentArtifactResponse[]
}

export interface KnowledgeBaseWikiIngestResponse {
  knowledgeBaseId: string
  indexPage: KnowledgeBaseWikiPageResponse
  pages: KnowledgeBaseWikiPageResponse[]
  warnings: string[]
}

export const knowledgeBaseWikiAgentApi = {
  dashboard: (knowledgeBaseId: string) =>
    api.post<KnowledgeBaseWikiDashboardResponse>("/kb/wiki/dashboard", { knowledgeBaseId }),
  pages: (knowledgeBaseId: string) =>
    api.post<{ knowledgeBaseId: string; pages: KnowledgeBaseWikiPageResponse[] }>("/kb/wiki/page/list", { knowledgeBaseId }),
  pageDetail: (knowledgeBaseId: string, pageKey: string) =>
    api.post<KnowledgeBaseWikiPageDetailResponse>("/kb/wiki/page/detail", { knowledgeBaseId, pageKey }),
  ingest: (data: { knowledgeBaseId: string; articleIds?: string[]; forceRebuild?: boolean }) =>
    api.post<KnowledgeBaseWikiIngestResponse>("/kb/wiki/ingest", data),
  patches: (knowledgeBaseId: string) =>
    api.post<{ knowledgeBaseId: string; patches: KnowledgeBaseWikiPatchResponse[] }>("/kb/wiki/patch/list", { knowledgeBaseId }),
  applyPatch: (knowledgeBaseId: string, patchId: string) =>
    api.post<{ patch: KnowledgeBaseWikiPatchResponse; page: KnowledgeBaseWikiPageResponse }>("/kb/wiki/patch/apply", {
      knowledgeBaseId,
      patchId,
    }),
  rejectPatch: (knowledgeBaseId: string, patchId: string) =>
    api.post<KnowledgeBaseWikiPatchResponse>("/kb/wiki/patch/reject", { knowledgeBaseId, patchId }),
  lint: (knowledgeBaseId: string) =>
    api.post<KnowledgeBaseWikiLintResponse>("/kb/wiki/lint", { knowledgeBaseId }),
  threads: (knowledgeBaseId: string) =>
    api.post<{ knowledgeBaseId: string; threads: KnowledgeBaseAgentThreadResponse[] }>("/kb/agent/thread/list", { knowledgeBaseId }),
  createThread: (knowledgeBaseId: string, title?: string) =>
    api.post<{ id: string; knowledgeBaseId: string; title: string; status: string }>("/kb/agent/thread/create", {
      knowledgeBaseId,
      ...(title ? { title } : {}),
    }),
  threadDetail: (knowledgeBaseId: string, threadId: string) =>
    api.post<KnowledgeBaseAgentThreadDetailResponse>("/kb/agent/thread/detail", { knowledgeBaseId, threadId }),
  artifacts: (knowledgeBaseId: string, threadId?: string | null) =>
    api.post<{ knowledgeBaseId: string; artifacts: KnowledgeBaseAgentArtifactResponse[] }>("/kb/agent/artifact/list", {
      knowledgeBaseId,
      ...(threadId ? { threadId } : {}),
    }),
  createArtifact: (data: {
    knowledgeBaseId: string
    threadId: string
    runId?: string | null
    artifactType: string
    title: string
    contentMd?: string | null
    payload?: unknown
  }) => api.post<KnowledgeBaseAgentArtifactResponse>("/kb/agent/artifact/create", data),
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

export interface KnowledgeBaseQaThreadListParams {
  cursor?: number
  limit?: number
  q?: string
  scope?: string
}

export interface KnowledgeBaseQaThreadListResponse {
  threads: KnowledgeBaseAgentThreadResponse[]
  nextCursor: number | null
}

export interface KnowledgeBaseQaThreadDeleteManyResponse {
  deleted: string[]
  failed: Array<{ id: string; reason: string }>
}

export const knowledgeBaseQaApi = {
  threadList: (params: KnowledgeBaseQaThreadListParams = {}) =>
    api.post<KnowledgeBaseQaThreadListResponse>("/kb/qa/thread/list", params),
  threadDetail: (threadId: string) =>
    api.post<KnowledgeBaseAgentThreadDetailResponse>("/kb/qa/thread/detail", { threadId }),
  threadDelete: (threadId: string) =>
    api.post<{ id: string }>("/kb/qa/thread/delete", { threadId }),
  threadDeleteMany: (threadIds: string[]) =>
    api.post<KnowledgeBaseQaThreadDeleteManyResponse>("/kb/qa/thread/delete-many", { threadIds }),
  createThread: (data: { knowledgeBaseId?: string | null; title?: string }) =>
    api.post<{ id: string; knowledgeBaseId: string | null; title: string; status: string }>("/kb/qa/thread/create", data),
  knowledgeBaseList: () =>
    api.post<{ knowledgeBases: KnowledgeBaseQaSummary[] }>("/kb/qa/knowledge-base/list", {}),
  modelInfo: () =>
    api.post<KnowledgeBaseQaModelInfo>("/kb/qa/model-info", {}),
}

// AI 模型配置相关类型
export type AiConfigType = "CHAT"

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

export interface AiReviewStats {
  newArticles: number
  updatedArticles: number
  totalChars: number
  knowledgeBaseCount: number
  topTags: AiReviewStatsTopTag[]
  topArticles: AiReviewStatsTopArticle[]
  knowledgeBases: AiReviewStatsKnowledgeBase[]
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
  knowledgeGraphData?: unknown | null
  knowledgeGraphGeneratedAt?: string | null
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

export interface DashboardOverviewResponse {
  kpis: {
    articles: number
    qaThreads: number
    knowledgeBases: number
    activity7d: number
  }
  heatmap: {
    points: DashboardHeatmapPoint[]
    start: string
    end: string
    total: number
  }
  trend: DashboardTrendPoint[]
  distribution: {
    knowledgeBases: DashboardDistributionItem[]
    tags: DashboardDistributionItem[]
  }
  recentThreads: KnowledgeBaseAgentThreadResponse[]
}

export const dashboardApi = {
  /** 加载仪表盘总览：KPI、活动热力图、趋势、分布与最近问答 */
  overview: () => api.post<DashboardOverviewResponse>("/dashboard/overview", {}),
}
