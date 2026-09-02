import { api } from "@/lib/api-client"

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

/** 知识库级编译说明书：保存后会追加到每次编译的提示词里。 */
export interface KnowledgeBaseWikiGuideResponse {
  knowledgeBaseId: string
  pageKey: string
  title?: string
  /** 是否已保存过说明书；false 表示当前编译行为不受它影响 */
  enabled: boolean
  contentMd: string
  /** 未保存时给出的起手模板，仅 guide 接口返回 */
  templateMd?: string
  maxLength?: number
  updatedAt?: string | null
}

export interface KnowledgeBaseWikiLintResponse {
  score: number
  pageCount: number
  linkCount: number
  sourceRefCount: number
  /** 源文档已变更或编译流程已升级、需要重新编译的页面数 */
  stalePageCount: number
  issueCount: number
  issues: KnowledgeBaseWikiLintIssue[]
  checkedAt: string
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

export type ArticleKnowledgeBuildPhase =
  | "queued"
  | "preparing"
  | "analyzing"
  | "taxonomy"
  | "pages"
  | "persisting"
  | "embedding"
  | "retrying"
  | "completed"
  | "failed"

export interface ArticleKnowledgeBuildProgress {
  percent: number
  phase: ArticleKnowledgeBuildPhase
  message: string
  completed?: number
  total?: number
  updatedAt: string
}

export interface ArticleKnowledgeBuildJobResponse {
  id: string
  userId: string
  knowledgeBaseId: string
  articleId: string
  status: ArticleKnowledgeBuildJobStatus
  progress: ArticleKnowledgeBuildProgress
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

/** Wiki 图谱节点：一个未归档的 Wiki 页面 */
export interface KnowledgeBaseWikiGraphNode {
  pageKey: string
  title: string
  kind: KnowledgeBaseWikiPageKind | string
  summary: string | null
  categoryPath: string[]
  aliases: string[]
  /** 支撑该页面的来源引用条数，用来给点群节点定权重 */
  sourceCount: number
  updatedAt: string
}

/** Wiki 图谱边：页面之间的出链，已剔除悬空边 */
export interface KnowledgeBaseWikiGraphLink {
  id: string
  fromPageKey: string
  toPageKey: string
  linkType: string
  description: string | null
}

export interface KnowledgeBaseWikiGraphResponse {
  knowledgeBaseId: string
  knowledgeBaseName: string
  nodes: KnowledgeBaseWikiGraphNode[]
  links: KnowledgeBaseWikiGraphLink[]
  stats: {
    pageCount: number
    linkCount: number
    conceptCount: number
    entityCount: number
    sourceCount: number
  }
  generatedAt: string | null
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
  graph: (knowledgeBaseId: string) =>
    api.post<KnowledgeBaseWikiGraphResponse>("/kb/wiki/graph", { knowledgeBaseId }),
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
  guide: (knowledgeBaseId: string) =>
    api.post<KnowledgeBaseWikiGuideResponse>("/kb/wiki/guide", { knowledgeBaseId }),
  saveGuide: (knowledgeBaseId: string, contentMd: string) =>
    api.post<KnowledgeBaseWikiGuideResponse>("/kb/wiki/guide/save", { knowledgeBaseId, contentMd }),
}

/** Wiki 导出格式：okf 用标准 Markdown 链接，obsidian 保留 [[wikilink]]。 */
export type KnowledgeBaseWikiExportFormat = "okf" | "obsidian"

/**
 * 把知识库蒸馏成 Agent Skill 包（zip）。与 /api/agent/skill-pack 不同：
 * 那个装的是 API 用法，这个装的是知识本身。
 */
export async function exportKnowledgeBaseSkillPack(params: {
  knowledgeBaseId: string
  includeSources?: boolean
}): Promise<{ blob: Blob; filename: string }> {
  try {
    const res = await api.post<Blob>("/kb/wiki/skill-pack", params, { responseType: "blob" })
    return {
      blob: res.data,
      filename:
        parseAttachmentFilename(res.headers?.["content-disposition"]) ??
        `petrichor-kb-${params.knowledgeBaseId}-skill.zip`,
    }
  } catch (error) {
    throw await restoreBlobErrorBody(error)
  }
}

/**
 * 导出知识库 Wiki 为 Open Knowledge Format bundle（zip 附件）。
 * 后端失败时返回的仍是标准 JSON 错误体，但 responseType=blob 会把它一并读成 Blob，
 * 所以这里先把错误体还原成对象再抛出，上层 resolveApiErrorMessage 才能取到 msg。
 */
export async function exportKnowledgeBaseWikiBundle(params: {
  knowledgeBaseId: string
  format?: KnowledgeBaseWikiExportFormat
}): Promise<{ blob: Blob; filename: string }> {
  try {
    const res = await api.post<Blob>("/kb/wiki/export", params, { responseType: "blob" })
    const format = params.format ?? "okf"
    return {
      blob: res.data,
      filename:
        parseAttachmentFilename(res.headers?.["content-disposition"]) ??
        `petrichor-kb-${params.knowledgeBaseId}-${format}.zip`,
    }
  } catch (error) {
    throw await restoreBlobErrorBody(error)
  }
}

function parseAttachmentFilename(header: unknown): string | null {
  if (typeof header !== "string") return null
  const matched = /filename="?([^";]+)"?/i.exec(header)
  return matched?.[1] ?? null
}

async function restoreBlobErrorBody(error: unknown): Promise<unknown> {
  const response = (error as { response?: { data?: unknown } } | null)?.response
  if (!response || !(response.data instanceof Blob)) return error
  try {
    response.data = JSON.parse(await response.data.text())
  } catch {
    response.data = undefined
  }
  return error
}

// 服务端单任务最长 15 分钟，额外预留一轮排队和最终状态返回时间。
const ARTICLE_KNOWLEDGE_BUILD_POLL_TIMEOUT_MS = 30 * 60 * 1_000

export interface BuildArticleKnowledgeWaitOptions {
  onProgress?: (
    progress: ArticleKnowledgeBuildProgress,
    job: ArticleKnowledgeBuildJobResponse,
  ) => void
}

/** 创建异步构建任务并等待最终结果；页面请求不会占用一个长连接。 */
export async function buildArticleKnowledgeAndWait(
  data: ArticleKnowledgeBuildInput,
  options: BuildArticleKnowledgeWaitOptions = {},
): Promise<ArticleKnowledgeBuildResponse> {
  const started = await knowledgeBaseWikiAgentApi.buildArticleKnowledge(data)
  const deadline = Date.now() + ARTICLE_KNOWLEDGE_BUILD_POLL_TIMEOUT_MS
  let job = started.data
  let pollIntervalMs = 750
  options.onProgress?.(job.progress, job)

  while (job.status === "pending" || job.status === "processing") {
    if (Date.now() >= deadline) {
      throw new Error("知识构建等待超时，任务可能仍在后台执行，请稍后刷新查看")
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    const response = await knowledgeBaseWikiAgentApi.articleKnowledgeBuildStatus(job.id)
    job = response.data
    options.onProgress?.(job.progress, job)
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

export const knowledgeBaseQaApi = {
  knowledgeBaseList: () =>
    api.post<{ knowledgeBases: KnowledgeBaseQaSummary[] }>("/kb/qa/knowledge-base/list", {}),
  modelInfo: () =>
    api.post<KnowledgeBaseQaModelInfo>("/kb/qa/model-info", {}),
}
