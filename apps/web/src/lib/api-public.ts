import type { AxiosRequestConfig, AxiosResponse } from "axios"

import { api } from "@/lib/api-client"
import type { ProjectShowcaseResponse, SiteFilingResponse, TableDataInfo } from "@/lib/api-core"

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
  mediaAccessToken?: string | null
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

let publicSiteFilingCache: SiteFilingResponse | null = null
let publicSiteFilingRequest: Promise<AxiosResponse<SiteFilingResponse>> | null = null

function fetchPublicSiteFiling() {
  if (publicSiteFilingCache) {
    return Promise.resolve(createCachedAxiosResponse(publicSiteFilingCache))
  }
  if (publicSiteFilingRequest) {
    return publicSiteFilingRequest
  }

  publicSiteFilingRequest = api.get<SiteFilingResponse>("/public/filing")
    .then((response) => {
      publicSiteFilingCache = response.data
      return response
    })
    .finally(() => {
      publicSiteFilingRequest = null
    })

  return publicSiteFilingRequest
}

function invalidatePublicSiteFilingClientCache() {
  publicSiteFilingCache = null
  publicSiteFilingRequest = null
}

export const publicProjectShowcaseApi = {
  detail: (options?: { forceRefresh?: boolean }) => fetchPublicProjectShowcase(Boolean(options?.forceRefresh)),
  getCachedDetail: () => getFreshClientCacheValue(publicProjectShowcaseCache),
  invalidateClientCache: invalidatePublicProjectShowcaseClientCache,
}

export const publicSiteFilingApi = {
  detail: fetchPublicSiteFiling,
  getCachedDetail: () => publicSiteFilingCache,
  invalidateClientCache: invalidatePublicSiteFilingClientCache,
  resetClientCacheForTests: invalidatePublicSiteFilingClientCache,
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
  /** 获取同源 Go 上传地址；由 Go 保存文件到对象存储 */
  presignPut: (data: PresignPutRequest, config?: AxiosRequestConfig) =>
    api.post<PresignPutResponse>("/upload/presign-put", data, config),

  /** 获取具有时效的预签名下载 URL（防盗链，需要登录） */
  presignGet: (objectKey: string) =>
    api.post<PresignGetResponse>("/upload/presign-get", { objectKey }),

  /** 公开版：获取预签名下载 URL，用于公开分享文章的附件（无需登录） */
  publicPresignGet: (objectKey: string, mediaAccessToken?: string | null) =>
    api.post<PresignGetResponse>("/public/upload/presign-get", {
      objectKey,
      ...(mediaAccessToken ? { mediaAccessToken } : {}),
    }),
}

// ===== 文档导入（上传原件 → Go / Asynq 解析、栅格化、OCR、生成文章） =====

export type DocumentImportSourceType =
  | "pdf" | "md" | "markdown" | "doc" | "docx" | "docm"
  | "ppt" | "pps" | "pot" | "pptx" | "pptm" | "ppsx" | "ppsm"
  | "xls" | "xlsx" | "xlsm" | "xlsb" | "odt" | "ods" | "odp"
  | "rtf" | "epub" | "csv"

export type DocumentImportMethod = "direct" | "multimodal"
/** ocr 仅表示待识别，不能作为已使用多模态模型的依据。 */
export type DocumentImportExtractedBy = DocumentImportMethod | "ocr"
export type DocumentImportImagePolicy = "keep_and_recognize" | "text_only" | "images_only"

export type DocumentImportJobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "dead_letter"
  | "canceled"

export type DocumentImportJobStage = "preparing" | "parsing" | "rendering" | "ocr" | "finalizing" | "completed"
export type DocumentImportPageStatus = "pending" | "processing" | "done" | "failed" | "dead_letter"

export interface DocumentImportJobResponse {
  id: string
  knowledgeBaseId: string
  knowledgeBaseName: string | null
  parentNodeId: string | null
  parentFolderName: string | null
  sourceType: DocumentImportSourceType
  /** PDF 图片策略；历史任务缺省为保留并识别。 */
  imagePolicy?: DocumentImportImagePolicy
  pageUnit: "page" | "document"
  /** 成功单元的实际来源；仅统计 status=done。 */
  actualMethods: DocumentImportMethod[]
  directPages: number
  multimodalPages: number
  fileName: string
  title: string
  totalPages: number
  processedPages: number
  donePages: number
  failedPages: number
  pendingPages: number
  status: DocumentImportJobStatus
  /** 历史任务可缺省；准备 / 解析期 totalPages=0，不代表完成。 */
  stage?: DocumentImportJobStage
  modelConfigId: string | null
  articleId: string | null
  error: string | null
  deadLetteredAt: string | null
  replayCount: number
  createdAt: string
  updatedAt: string
}

export interface DocumentImportPageResponse {
  pageNo: number
  /** OCR 兜底页由服务端生成整页图，直接解析的文字页为 null。 */
  imageKey: string | null
  /** 图片保留与内容识别独立；旧任务可能没有此字段。 */
  assets?: DocumentImportAssetResponse[] | null
  extractedBy: DocumentImportExtractedBy
  status: DocumentImportPageStatus
  markdown: string | null
  error: string | null
  attemptCount: number
  maxAttempts: number
  nextAttemptAt: string
  lastError: string | null
  deadLetteredAt: string | null
}

export interface DocumentImportAssetResponse {
  id: string
  imageKey: string
  kind: "region" | "page"
  bounds: [number, number, number, number]
  placement: "anchor" | "page"
  status: "pending" | "done" | "failed" | "skipped"
  contentType?: "screenshot" | "scan" | "photo" | "chart" | "diagram" | "unknown"
  recognition?: "ocr" | "describe"
  markdown?: string
  method?: string
  error?: string
}

export interface DocumentImportCreateRequest {
  /** 稳定 UUID；网络失败重试必须保持整个请求不变。 */
  idempotencyKey: string
  knowledgeBaseId: string
  parentId?: string | null
  fileName: string
  title: string
  /** 原始文档预签名直传后的对象 key */
  sourceKey: string
  imagePolicy?: DocumentImportImagePolicy
  modelConfigId?: string | null
  concurrency?: number
}

export interface DocumentImportCreateResponse {
  job: DocumentImportJobResponse
  /** 只有存在文章 ID 或 job.status=completed 才表示完成。 */
  articleId: string | null
}

export interface DocumentImportFinalizeResponse {
  job: DocumentImportJobResponse
  /** null 表示仅已提交后台生成任务，需继续轮询详情。 */
  articleId: string | null
}

export interface DocumentImportConvertResponse {
  page: DocumentImportPageResponse
  processedPages: number
  status: DocumentImportJobStatus
}

export const documentImportApi = {
  createJob: (data: DocumentImportCreateRequest, config?: AxiosRequestConfig) =>
    api.post<DocumentImportCreateResponse>("/kb/import/create", data, config),
  convertPage: (data: { jobId: string; pageNo: number }) =>
    api.post<DocumentImportConvertResponse>("/kb/import/page-convert", data),
  retryPage: (data: { jobId: string; pageNo: number }) =>
    api.post<DocumentImportConvertResponse>("/kb/import/retry-page", data),
  retryFailedPages: (data: { jobId: string }) =>
    api.post<{ retried: number; reset?: number; status: DocumentImportJobStatus }>("/kb/import/retry-failed", data),
  finalize: (data: { jobId: string }) =>
    api.post<DocumentImportFinalizeResponse>("/kb/import/finalize", data),
  cancel: (data: { jobId: string }) =>
    api.post<{ id: string; status: DocumentImportJobStatus }>("/kb/import/cancel", data),
  deleteMany: (data: { ids: string[] }) =>
    api.post<{ deleted: string[] }>("/kb/import/delete", data),
  list: (data: { knowledgeBaseId?: string; pageNum?: number; pageSize?: number }) =>
    api.post<TableDataInfo<DocumentImportJobResponse>>("/kb/import/list", data),
  detail: (data: { jobId: string }, config?: AxiosRequestConfig) =>
    api.post<{ job: DocumentImportJobResponse; pages: DocumentImportPageResponse[] }>(
      "/kb/import/detail",
      data,
      config,
    ),
}

// 仪表盘总览相关类型
