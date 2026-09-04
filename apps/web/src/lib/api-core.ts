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

// ===== 点群图谱渲染载荷（Wiki 图谱共用）=====

export type SiteGraphNodeKind = "root" | "section" | "article" | "concept" | "entity" | "tag"
export type SiteGraphEdgeKind = "reference" | "semantic" | "derived"

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

export interface SiteFilingResponse {
  enabled: boolean
  icpNumber: string
  icpUrl: string
  publicSecurityNumber: string
  publicSecurityUrl: string
  createdAt?: string | null
  updatedAt?: string | null
}

export interface SiteFilingUpdateRequest {
  enabled: boolean
  icpNumber: string
  icpUrl: string
  publicSecurityNumber: string
  publicSecurityUrl: string
}

export type PublicSearchMode = "fulltext" | "lexical" | "semantic" | "hybrid"
export type PublicSearchType = "all" | "article" | "wiki"

export interface PublicSearchResult {
  id: string
  type: "article" | "wiki"
  title: string
  summary: string
  snippet: string
  href: string
  updatedAt: string
  score: number
  semanticScore: number
  matchReason: string
  articleId?: string
  knowledgeBaseId: string | null
  pageKey: string | null
  kind: string | null
  categoryPath: string[]
  tags: string[]
  knowledgeBaseName: string | null
  sourceCount: number | null
}

export interface PublicSearchResponse {
  query: string
  mode: PublicSearchMode
  modeRequested: PublicSearchMode
  modeApplied: PublicSearchMode
  type: PublicSearchType
  knowledgeBaseId: string | null
  tag: string | null
  items: PublicSearchResult[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
  semanticAvailable: boolean
  semanticMessage: string | null
  tookMs: number
}

export const publicSearchApi = {
  search: (params: {
    q: string
    mode?: PublicSearchMode
    type?: PublicSearchType
    kb?: string
    tag?: string
    limit?: number
    offset?: number
    signal?: AbortSignal
  }) => {
    const { signal, ...query } = params
    return api.get<PublicSearchResponse>("/public/search", { params: query, signal })
  },
}

export interface PublicWikiKnowledgeBase {
  knowledgeBaseId: string
  name: string
  description: string | null
  pageCount: number
  articleCount: number
  updatedAt: string
}

export interface PublicWikiPageListItem {
  pageKey: string
  title: string
  kind: string
  summary: string
  aliases: string[]
  categoryPath: string[]
  sourceCount: number
  updatedAt: string
  href: string
}

export interface PublicWikiPageListResponse {
  knowledgeBaseId: string
  knowledgeBaseName: string
  description: string | null
  updatedAt: string
  items: PublicWikiPageListItem[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface PublicWikiNeighborPage {
  pageKey: string
  title: string
  kind: string | null
  summary: string | null
  linkType: string
  href?: string
}

/** 公开 Wiki 页面详情；服务端保证其全部来源文章都处于匿名公开作用域。 */
export interface PublicWikiPageDetail {
  knowledgeBaseId: string
  knowledgeBaseName: string
  pageKey: string
  title: string
  kind: string
  summary: string
  aliases: string[]
  categoryPath: string[]
  href: string
  updatedAt: string
  contentMd: string
  mediaAccessToken?: string | null
  links: PublicWikiNeighborPage[]
  inLinks: PublicWikiNeighborPage[]
  sourceArticles: Array<{
    articleId: string
    title: string
    href: string
    note: string | null
  }>
}

export interface PublicWikiGraphResponse {
  knowledgeBaseId: string
  knowledgeBaseName: string
  nodes: Array<PublicWikiPageListItem>
  links: Array<{
    id: string
    fromPageKey: string
    toPageKey: string
    linkType: string
    description: string | null
  }>
  stats: {
    pageCount: number
    linkCount: number
    conceptCount: number
    entityCount: number
    sourceCount: number
  }
  generatedAt: string | null
  truncated: boolean
  totalPageCount: number
}

export const publicWikiApi = {
  knowledgeBases: (signal?: AbortSignal) =>
    api.get<{ items: PublicWikiKnowledgeBase[] }>("/public/wiki/knowledge-bases", { signal }),
  pages: (params: { knowledgeBaseId: string; q?: string; kind?: string; limit?: number; offset?: number }) =>
    api.get<PublicWikiPageListResponse>("/public/wiki/pages", { params }),
  detail: (pageKey: string, knowledgeBaseId?: string | null) =>
    api.get<PublicWikiPageDetail>("/public/wiki/page", {
      params: { pageKey, ...(knowledgeBaseId ? { knowledgeBaseId } : {}) },
    }),
  graph: (knowledgeBaseId: string) =>
    api.get<PublicWikiGraphResponse>("/public/wiki/graph", { params: { knowledgeBaseId } }),
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

export const adminSiteFilingApi = {
  detail: () => api.get<SiteFilingResponse>("/admin/filing"),
  update: (data: SiteFilingUpdateRequest) => api.post<SiteFilingResponse>("/admin/filing", data),
}
