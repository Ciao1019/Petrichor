import { api } from "@/lib/api-client"

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

// 站内 Assistant（chat-first 壳）
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

// Agent Run 视图
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
  source: "knowledge" | "wiki" | "web" | "graph" | "memory" | "subagent" | "tool"
  title: string
  snippet?: string
  url?: string
  nodeKey?: string
  pageKey?: string
  articleId?: string
  knowledgeBaseId?: string
  path?: string[]
  relevance?: number
  citationIndex?: number
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
