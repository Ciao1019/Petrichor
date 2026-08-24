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
  twoFactorEnabled: boolean
}

export const authSessionApi = {
  list: () => api.get<AuthSessionListResponse>("/auth/sessions"),
  revoke: (data: { sessionId: string; code: string }) =>
    api.post<{ success: boolean }>("/auth/sessions/revoke", data),
  revokeOthers: (data: { code: string }) =>
    api.post<{ success: boolean; revokedCount: number }>("/auth/sessions/revoke-others", data),
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

// ===== 全站星图（Site Graph）=====

export type SiteGraphNodeKind = "root" | "section" | "article" | "concept" | "entity" | "tag"
export type SiteGraphEdgeKind = "reference" | "semantic" | "derived"
export type SiteGraphStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED"
export type SiteGraphSource = "AGENT" | "MANUAL" | "SYSTEM"

export interface SiteGraphAttribute {
  name: string
  value: string
}

export interface SiteGraphPayloadNode {
  id: string
  label: string
  kind: SiteGraphNodeKind
  route: string | null
  summary: string
  attributes: SiteGraphAttribute[]
  /** 同义写法，供检索命中；渲染不用 */
  aliases: string[]
  parentId: string | null
  topSectionId: string | null
  weight: number
}

export interface SiteGraphPayloadLink {
  source: string
  target: string
  kind: "structure" | SiteGraphEdgeKind
  relation: string
}

export interface SiteGraphPayload {
  nodes: SiteGraphPayloadNode[]
  links: SiteGraphPayloadLink[]
  stats: {
    nodeCount: number
    linkCount: number
    articleCount: number
    conceptCount: number
  }
  generatedAt: string | null
}

export interface SiteGraphAdminNode {
  id: string
  nodeKey: string
  parentId: string | null
  parentKey: string | null
  kind: SiteGraphNodeKind
  name: string
  summary: string
  route: string | null
  articleId: string | null
  attributes: SiteGraphAttribute[]
  aliases: string[]
  weight: number
  sortOrder: number
  status: SiteGraphStatus
  source: SiteGraphSource
  confidence: number
  locked: boolean
  depth: number
  childCount: number
  degree: number
  updatedAt: string
}

export interface SiteGraphAdminEdge {
  id: string
  fromNodeId: string
  fromNodeKey: string
  fromNodeName: string
  toNodeId: string
  toNodeKey: string
  toNodeName: string
  relation: string
  kind: SiteGraphEdgeKind
  attributes: SiteGraphAttribute[]
  weight: number
  directed: boolean
  status: SiteGraphStatus
  source: SiteGraphSource
  confidence: number
  locked: boolean
  updatedAt: string
}

export interface SiteGraphIssue {
  severity: "error" | "warning" | "info"
  code: string
  target: string
  message: string
}

export interface SiteGraphValidationReport {
  score: number
  passed: boolean
  nodeCount: number
  edgeCount: number
  orphanCount: number
  maxDepth: number
  issues: SiteGraphIssue[]
  checkedAt: string
}

export interface SiteGraphRunSummary {
  id: string
  status: "RUNNING" | "COMPLETED" | "FAILED"
  mode: "FULL" | "INCREMENTAL"
  modelName: string | null
  articleCount: number
  nodeCount: number
  edgeCount: number
  validation: SiteGraphValidationReport | null
  warnings: string[]
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}

export interface SiteGraphNodeOption {
  id: string
  nodeKey: string
  name: string
  kind: SiteGraphNodeKind
}

/** 名称相近但未自动合并的实体对子，等后台确认 */
export interface SiteGraphMergeCandidate {
  id: string
  sourceKey: string
  sourceName: string
  sourceNodeId: string | null
  targetKey: string
  targetName: string
  targetNodeId: string | null
  reason: string
  score: number
  detail: string | null
  status: string
  createdAt: string
}

export interface SiteGraphOverviewResponse {
  nodes: SiteGraphAdminNode[]
  edges: SiteGraphAdminEdge[]
  runs: SiteGraphRunSummary[]
  nodeOptions: SiteGraphNodeOption[]
  validation: SiteGraphValidationReport
  mergeCandidates: SiteGraphMergeCandidate[]
  stats: {
    nodeCount: number
    edgeCount: number
    publishedNodes: number
    draftNodes: number
    lockedNodes: number
    manualNodes: number
    articleNodes: number
    conceptNodes: number
  }
}

export interface SiteGraphGenerateResponse {
  runId: string
  validation: SiteGraphValidationReport
  warnings: string[]
  articleCount: number
  nodeCount: number
  edgeCount: number
  lockedSkipped: number
  autoAlignedCount: number
  mergeCandidateCount: number
  summary: string
}

export interface SiteGraphMergeResult {
  targetKey: string
  absorbedAliases: number
  movedEdges: number
  droppedEdges: number
  movedChildren: number
  attributeConflicts: number
}

export interface SiteGraphNodeSaveRequest {
  id?: string | null
  nodeKey?: string
  parentId?: string | null
  kind: SiteGraphNodeKind
  name: string
  summary?: string | null
  route?: string | null
  attributes?: SiteGraphAttribute[]
  aliases?: string[]
  weight?: number
  status?: SiteGraphStatus
  confidence?: number
  locked?: boolean
}

export interface SiteGraphEdgeSaveRequest {
  id?: string | null
  fromNodeId: string
  toNodeId: string
  relation: string
  kind: SiteGraphEdgeKind
  attributes?: SiteGraphAttribute[]
  weight?: number
  directed?: boolean
  status?: SiteGraphStatus
  confidence?: number
  locked?: boolean
}

export interface SiteGraphSubtreeResponse {
  ancestors: Array<{ id: string; nodeKey: string; name: string }>
  nodes: Array<SiteGraphAdminNode & { subtreeDepth: number }>
  edges: SiteGraphAdminEdge[]
}

export const publicSiteGraphApi = {
  detail: () => api.get<SiteGraphPayload>("/public/site-graph"),
}

export const adminSiteGraphApi = {
  overview: () => api.get<SiteGraphOverviewResponse>("/admin/site-graph/overview"),
  generate: (data: { configId?: string | null; mode?: "FULL" | "INCREMENTAL" } = {}) =>
    api.post<SiteGraphGenerateResponse>("/admin/site-graph/generate", data),
  validate: () =>
    api.post<{ validation: SiteGraphValidationReport; summary: string }>("/admin/site-graph/validate", {}),
  publish: () =>
    api.post<{ publishedNodes: number; publishedEdges: number; archivedStaleNodes: number }>(
      "/admin/site-graph/publish",
      {},
    ),
  unpublish: () =>
    api.post<{ unpublishedNodes: number; unpublishedEdges: number }>("/admin/site-graph/unpublish", {}),
  clear: () => api.post<{ cleared: boolean }>("/admin/site-graph/clear", {}),
  saveNode: (data: SiteGraphNodeSaveRequest) =>
    api.post<{ id: string; nodeKey: string }>("/admin/site-graph/node/save", data),
  deleteNode: (id: string) => api.post<{ id: string }>("/admin/site-graph/node/delete", { id }),
  saveEdge: (data: SiteGraphEdgeSaveRequest) => api.post<{ id: string }>("/admin/site-graph/edge/save", data),
  deleteEdge: (id: string) => api.post<{ id: string }>("/admin/site-graph/edge/delete", { id }),
  confirmMerge: (sourceNodeId: string, targetNodeId: string) =>
    api.post<SiteGraphMergeResult>("/admin/site-graph/merge/confirm", { sourceNodeId, targetNodeId }),
  ignoreMerge: (id: string) => api.post<{ id: string }>("/admin/site-graph/merge/ignore", { id }),
  subtree: (nodeId: string, depth?: number) =>
    api.post<SiteGraphSubtreeResponse>("/admin/site-graph/subtree", { nodeId, depth }),
  neighborhood: (nodeId: string, hops?: number) =>
    api.post<{ nodes: SiteGraphAdminNode[]; edges: SiteGraphAdminEdge[] }>(
      "/admin/site-graph/neighborhood",
      { nodeId, hops },
    ),
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

export interface PublicWikiNeighborPage {
  pageKey: string
  title: string
  kind: string | null
  summary: string | null
  linkType: string
}

/** 前台问答 Wiki 弹窗用的页面详情（仅限关联了公开文章的页面）。 */
export interface PublicWikiPageDetail {
  pageKey: string
  title: string
  kind: string
  summary: string
  aliases: string[]
  contentMd: string
  links: PublicWikiNeighborPage[]
  inLinks: PublicWikiNeighborPage[]
  sourceArticles: Array<{
    articleId: string
    title: string
    href: string
    note: string | null
  }>
}

export const publicWikiApi = {
  detail: (pageKey: string) =>
    api.get<PublicWikiPageDetail>("/public/wiki/page", { params: { pageKey } }),
}

/** 后台助手 Wiki 弹窗：读取当前用户自己的 Wiki 页面详情。 */
export const assistantWikiApi = {
  detail: (pageKey: string, knowledgeBaseId?: string | null) =>
    api.get<PublicWikiPageDetail>("/assistant/wiki/page", {
      params: { pageKey, ...(knowledgeBaseId ? { knowledgeBaseId } : {}) },
    }),
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
  /** “构建知识”动态抽取的 1-2 级分类路径；实体/概念类型作为 UI 根目录单独呈现。 */
  categoryPath: string[]
  aliases: string[]
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
  toPageTitle: string
  toPageKind?: KnowledgeBaseWikiPageKind | string | null
  toPageSummary?: string | null
  linkType: string
  description?: string | null
}

export interface KnowledgeBaseWikiBacklink {
  id: string
  fromPageKey: string
  fromPageTitle: string
  fromPageKind?: KnowledgeBaseWikiPageKind | string | null
  fromPageSummary?: string | null
  linkType: string
  description?: string | null
}

export interface KnowledgeBaseWikiPageDetailResponse extends KnowledgeBaseWikiPageResponse {
  sourceRefs: KnowledgeBaseWikiSourceRef[]
  links: KnowledgeBaseWikiLink[]
  inLinks: KnowledgeBaseWikiBacklink[]
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
  pages: KnowledgeBaseWikiPageResponse[]
  lint: KnowledgeBaseWikiLintResponse
  /** 新“构建知识”产出的原始文章分片数 */
  chunkCount: number
  /** 仅用于存量 Wiki Tree 兼容展示 */
  treeNodeCount: number
  embedding: KbWikiEmbeddingStatus
}

export interface KbArticleKnowledgeIndexPhaseStatus {
  total: number
  embedded: number
  pending: number
  failed: number
}

export interface KbWikiEmbeddingStatus {
  supported: boolean
  total: number
  /** 用当前绑定模型写入且仍然新鲜的节点数 */
  embedded: number
  pending: number
  failed: number
  chunk: KbArticleKnowledgeIndexPhaseStatus
  question: KbArticleKnowledgeIndexPhaseStatus
  /** 当前 EMBEDDING 绑定的模型与维度；换模型后旧向量会被计入 pending */
  model: string | null
  dimensions: number | null
  version: number | null
}

export interface KbWikiEmbeddingRunResult {
  /** 本次实际写入的条数 */
  embedded: number
  embeddedChunks: number
  embeddedQuestions: number
  /** 写入后累计已就绪的条数 */
  ready: number
  total: number
  pending: number
  failed: number
  chunk: KbArticleKnowledgeIndexPhaseStatus
  question: KbArticleKnowledgeIndexPhaseStatus
  model: string | null
  dimensions: number | null
  version: number | null
}

export interface KnowledgeBaseWikiTreeNode {
  nodeKey: string
  articleId: string
  parentKey: string | null
  depth: number
  title: string
  summary?: string | null
  tokenEstimate: number
}

export interface KnowledgeBaseWikiTreeResponse {
  knowledgeBaseId: string
  articleId: string | null
  nodes: KnowledgeBaseWikiTreeNode[]
}

/** 完全重建时被清空的 Wiki 数据量 */
export interface KnowledgeBaseWikiPurgeSummary {
  pageCount: number
  linkCount: number
  sourceRefCount: number
  treeNodeCount: number
}

export interface KnowledgeBaseWikiIngestResponse {
  knowledgeBaseId: string
  indexPage: KnowledgeBaseWikiPageResponse
  pages: KnowledgeBaseWikiPageResponse[]
  /** 仅完全重建时非 null */
  purged: KnowledgeBaseWikiPurgeSummary | null
  warnings: string[]
}

export interface ArticleKnowledgeBuildResponse {
  articleId: string
  knowledgeBaseId: string
  fromCache: boolean
  chunkCount: number
  recommendedQuestionCount: number
  entityCount: number
  conceptCount: number
  sourcePage: KnowledgeBaseWikiPageResponse
  warnings: string[]
}

export type ArticleKnowledgeBuildJobStatus = "pending" | "processing" | "completed" | "failed"

export interface ArticleKnowledgeBuildJobResponse {
  id: string
  userId: string
  knowledgeBaseId: string
  articleId: string
  status: ArticleKnowledgeBuildJobStatus
  result: ArticleKnowledgeBuildResponse | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface ArticleKnowledgeBuildInput {
  knowledgeBaseId: string
  articleId: string
  forceRebuild?: boolean
}

/** 「构建知识」持久化的单个文章切片及其推荐问题 */
export interface ArticleKnowledgeChunkResponse {
  id: string
  chunkKey: string
  position: number
  heading: string
  contentMd: string
  charCount: number
  contentHash: string
  /** 完整标题路径，如 ["架构","存储"]；旧算法产出的分片为空数组 */
  headingPath: string[]
  recommendedQuestions: string[]
  updatedAt: string | null
}

export interface ArticleKnowledgeChunkListResponse {
  articleId: string
  knowledgeBaseId: string
  articleTitle: string
  /** 是否已经构建过切片 */
  built: boolean
  /** 正文改动、或分片由旧版切分算法产出 */
  stale: boolean
  /** 产出这批分片的切分算法版本；存量数据为 0 */
  chunkAlgorithmVersion: number
  currentChunkAlgorithmVersion: number
  builtAt: string | null
  chunkCount: number
  questionCount: number
  chunks: ArticleKnowledgeChunkResponse[]
}

export const knowledgeBaseWikiAgentApi = {
  dashboard: (knowledgeBaseId: string) =>
    api.post<KnowledgeBaseWikiDashboardResponse>("/kb/wiki/dashboard", { knowledgeBaseId }),
  pages: (knowledgeBaseId: string) =>
    api.post<{ knowledgeBaseId: string; pages: KnowledgeBaseWikiPageResponse[] }>("/kb/wiki/page/list", { knowledgeBaseId }),
  pageDetail: (knowledgeBaseId: string, pageKey: string) =>
    api.post<KnowledgeBaseWikiPageDetailResponse>("/kb/wiki/page/detail", { knowledgeBaseId, pageKey }),
  tree: (knowledgeBaseId: string, articleId?: string) =>
    api.post<KnowledgeBaseWikiTreeResponse>("/kb/wiki/tree", { knowledgeBaseId, articleId }),
  ingest: (data: {
    knowledgeBaseId: string
    articleIds?: string[]
    forceRebuild?: boolean
    /** 完全重建：先清空该知识库现有 Wiki 再从零编译 */
    fullRebuild?: boolean
  }) =>
    api.post<KnowledgeBaseWikiIngestResponse>("/kb/wiki/ingest", data),
  buildArticleKnowledge: (data: ArticleKnowledgeBuildInput) =>
    api.post<ArticleKnowledgeBuildJobResponse>("/kb/knowledge/build", data),
  articleKnowledgeBuildStatus: (jobId: string) =>
    api.post<ArticleKnowledgeBuildJobResponse>("/kb/knowledge/build/status", { jobId }),
  articleChunks: (data: { knowledgeBaseId: string; articleId: string }) =>
    api.post<ArticleKnowledgeChunkListResponse>("/kb/knowledge/chunk/list", data),
  embedWiki: (knowledgeBaseId: string) =>
    api.post<KbWikiEmbeddingRunResult>("/kb/wiki/embedding/run", { knowledgeBaseId }),
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
}

const ARTICLE_KNOWLEDGE_BUILD_POLL_TIMEOUT_MS = 12 * 60 * 1_000

/** 创建异步构建任务并等待最终结果；页面请求不会再占用一个长连接。 */
export async function buildArticleKnowledgeAndWait(
  data: ArticleKnowledgeBuildInput,
): Promise<ArticleKnowledgeBuildResponse> {
  const started = await knowledgeBaseWikiAgentApi.buildArticleKnowledge(data)
  const deadline = Date.now() + ARTICLE_KNOWLEDGE_BUILD_POLL_TIMEOUT_MS
  let job = started.data
  let pollIntervalMs = 750

  while (job.status === "pending" || job.status === "processing") {
    if (Date.now() >= deadline) {
      throw new Error("知识构建等待超时，任务可能仍在后台执行，请稍后刷新查看")
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    const response = await knowledgeBaseWikiAgentApi.articleKnowledgeBuildStatus(job.id)
    job = response.data
    pollIntervalMs = Math.min(2_500, Math.round(pollIntervalMs * 1.35))
  }

  if (job.status === "failed") {
    throw new Error(job.error || "知识构建失败")
  }
  if (!job.result) {
    throw new Error("知识构建任务已完成，但未返回构建结果")
  }
  return job.result
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
  knowledgeBaseList: () =>
    api.post<{ knowledgeBases: KnowledgeBaseQaSummary[] }>("/kb/qa/knowledge-base/list", {}),
  modelInfo: () =>
    api.post<KnowledgeBaseQaModelInfo>("/kb/qa/model-info", {}),
}

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

// ===== 文档库（Document Library） =====

export type DocLibraryFileType = "pdf" | "docx" | "xlsx" | "csv"

export interface DocLibrary {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  documentCount: number
  createdAt: string
  updatedAt: string
}

export interface DocFolderItem {
  id: string
  libraryId: string
  parentId: string | null
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type DocDocumentStatus = "pending" | "parsing" | "ready" | "failed"

export interface DocDocument {
  id: string
  libraryId: string
  folderId: string | null
  fileName: string
  title: string
  fileType: DocLibraryFileType
  contentType: string | null
  objectKey: string
  sizeBytes: number | null
  pageCount: number | null
  status: DocDocumentStatus
  createdAt: string
  updatedAt: string
}

export interface DocDocumentChunk {
  chunkIndex: number
  page: number | null
  locator: string | null
  text: string
}

export interface DocDocumentDetail extends DocDocument {
  charCount: number | null
  blocks: unknown[]
  chunks: DocDocumentChunk[]
  summary: string | null
}

export interface DocLibrarySaveRequest {
  id?: string | null
  name: string
  description?: string | null
  color?: string | null
  icon?: string | null
}

export interface DocFolderSaveRequest {
  id?: string | null
  libraryId: string
  parentId?: string | null
  name: string
}

export interface DocDocumentRegisterRequest {
  libraryId: string
  folderId?: string | null
  fileName: string
  title?: string | null
  fileType: DocLibraryFileType
  contentType?: string | null
  objectKey: string
  sizeBytes?: number | null
  pageCount?: number | null
  blocks?: unknown[]
  chunks?: { text: string; page?: number | null; locator?: string | null }[]
  summary?: string | null
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

export interface DocQaThreadResponse {
  id: string
  libraryId: string | null
  title: string
  status: string
  lastMessageAt: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface DocQaThreadMessage {
  id: string
  role: string
  contentText: string
  content: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface DocQaModelOption {
  configId: string
  modelId: string
  modelName: string
  contextWindow: number
  isDefault: boolean
}

export interface DocQaModelInfo {
  configId: string | null
  modelId: string | null
  modelName: string | null
  contextWindow: number | null
  availableModels?: DocQaModelOption[]
}

export interface DocQaThreadListParams {
  cursor?: number
  limit?: number
  q?: string
  libraryId?: string | null
  scope?: "cross"
}

export const docLibraryApi = {
  listLibraries: () => api.get<{ libraries: DocLibrary[] }>("/doc-library/library/list"),
  saveLibrary: (data: DocLibrarySaveRequest) => api.post<{ id: string }>("/doc-library/library/save", data),
  deleteLibrary: (id: string) => api.post<DocDeleteResponse>("/doc-library/library/delete", { id }),

  listFolders: (libraryId: string) => api.post<{ folders: DocFolderItem[] }>("/doc-library/folder/list", { libraryId }),
  saveFolder: (data: DocFolderSaveRequest) => api.post<{ id: string }>("/doc-library/folder/save", data),
  deleteFolder: (id: string) => api.post<{ id: string }>("/doc-library/folder/delete", { id }),

  listDocuments: (libraryId: string) => api.post<{ documents: DocDocument[] }>("/doc-library/document/list", { libraryId }),
  registerDocument: (data: DocDocumentRegisterRequest) => api.post<{ id: string }>("/doc-library/document/register", data),
  documentDetail: (id: string) => api.post<{ document: DocDocumentDetail }>("/doc-library/document/detail", { id }),
  deleteDocument: (id: string) => api.post<DocDeleteResponse>("/doc-library/document/delete", { id }),
}

// 站内 Assistant（chat-first 壳）：形状对齐 src/server/assistant/thread-handlers.ts
export interface AssistantFocus {
  knowledgeBaseId?: string | null
  libraryId?: string | null
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

// Agent Run 视图：形状对齐 src/server/assistant/agent-run-handlers.ts
export interface AgentRunActivityResponse {
  id: string
  toolId: string
  namespace: string
  status: "completed" | "failed"
  summary: string
  durationMs: number
  evidenceIds: string[]
  startedAt: number
}

export interface AgentRunEvidenceResponse {
  id: string
  source: "knowledge" | "web" | "graph" | "memory" | "subagent" | "tool"
  title: string
  snippet?: string
  url?: string
  nodeKey?: string
  articleId?: string
  knowledgeBaseId?: string
  path?: string[]
  relevance?: number
}

export interface AgentRunDetailResponse {
  id: string
  conversationId: string
  status: "starting" | "running" | "completed" | "failed" | "stopped" | "cancelled"
  complexity?: "direct" | "simple" | "multi_step" | "complex"
  stopReason?: string
  stopMessage?: string
  goal: string
  answer: string
  plan: Array<{
    id: string
    goal: string
    status: "pending" | "running" | "completed" | "skipped" | "failed"
    resultSummary?: string
  }>
  loadedSkills: string[]
  activities: AgentRunActivityResponse[]
  subagents: Array<{
    id: string
    objective: string
    status: string
    summary?: string
    evidenceCount: number
    durationMs?: number
  }>
  evidence: AgentRunEvidenceResponse[]
  metrics: {
    durationMs: number
    toolCalls: number
    evidenceCount: number
    subAgentCount: number
    iterations: number
  }
  startedAt: number
  completedAt?: number
}

export const agentRunApi = {
  detail: (runId: string) =>
    api.post<AgentRunDetailResponse>("/assistant/agent-run/detail", { runId }),
  list: (conversationId: string, limit?: number) =>
    api.post<{
      runs: Array<{
        runKey: string
        status: string
        complexity: string
        stopReason: string | null
        startedAt: string
        completedAt: string | null
      }>
    }>("/assistant/agent-run/list", { conversationId, ...(limit ? { limit } : {}) }),
  /** Debug 通道：完整 Trace，需操作员或开启 AGENT_DEBUG */
  trace: (runId: string) =>
    api.post<{
      run: Record<string, unknown>
      events: Array<{
        sequence: number
        type: string
        toolId: string | null
        payload: Record<string, unknown>
        createdAt: number
      }>
    }>("/assistant/agent-run/trace", { runId }),
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
