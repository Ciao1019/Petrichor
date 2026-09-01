import { api } from "@/lib/api-client"

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
  name: string
}

export interface SetupStatusResponse {
  required: boolean
}

export interface SetupRequest {
  email: string
  username: string
  password: string
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
  setupStatus: () => api.get<SetupStatusResponse>("/auth/setup/status"),
  setup: (data: SetupRequest) => api.post<AuthResponse>("/auth/setup", data),
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
  deviceInfo: string | null
  ip: string | null
  userAgent: string | null
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
  updatedAt: string
  current: boolean
}

export interface AuthSessionListResponse {
  sessions: AuthSessionItem[]
  currentSessionId: string | null
}

export const authSessionApi = {
  list: () => api.get<AuthSessionListResponse>("/auth/sessions"),
  revoke: (id: string) =>
    api.post<{ success: boolean }>("/auth/sessions/revoke", { id }),
  revokeOthers: () =>
    api.post<{ success: boolean; revokedCount: number }>("/auth/sessions/revoke-others"),
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

export const adminProjectShowcaseApi = {
  detail: () => api.get<ProjectShowcaseResponse>("/admin/projects"),
  update: (data: ProjectShowcaseUpdateRequest) => api.post<ProjectShowcaseResponse>("/admin/projects", data),
}

export type AdminDeadLetterJobKind = "document_import"

export interface AdminDeadLetterJob {
  kind: AdminDeadLetterJobKind
  id: string
  userId: string
  knowledgeBaseId: string
  articleId: string | null
  title: string
  attemptCount: number
  maxAttempts: number
  replayCount: number
  lastError: string | null
  deadLetteredAt: string | null
  updatedAt: string
}

export const adminRuntimeJobsApi = {
  deadLetters: (limit = 100) =>
    api.get<{ items: AdminDeadLetterJob[] }>("/admin/runtime/dead-letters", { params: { limit } }),
  replay: (data: { kind: AdminDeadLetterJobKind; id: string }) =>
    api.post<{ kind: AdminDeadLetterJobKind; id: string; status: "pending" }>(
      "/admin/runtime/dead-letters/replay",
      data,
    ),
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
