import { api } from "@/lib/api-client"

export interface InboxNote {
  sources?: { id: string; url: string; title: string; createdAt: string }[]
  id: string
  contentMd: string
  contentJson?: string | null
  contentMetaJson?: string | null
  tags: string[]
  pinned: boolean
  version: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  articleId: string | null
  articleTitle: string | null
  knowledgeBaseId: string | null
  knowledgeBaseName: string | null
}

export type InboxStatus = "inbox" | "archived" | "all"
export interface InboxListRequest {
  status?: InboxStatus
  keyword?: string
  tag?: string
  pinned?: boolean
  pageNum?: number
  pageSize?: number
}
export interface InboxListResponse {
  rows: InboxNote[]
  total: number
  pageNum: number
  pageSize: number
  summary: { inbox: number; archived: number; total: number }
  tags: { name: string; count: number }[]
}
export interface InboxContent { captureIds?: string[]; contentMd: string; contentJson?: string | null; contentMetaJson?: string | null; tags: string[] }
export interface InboxArchiveRequest {
  id: string
  version: number
  knowledgeBaseId: string
  parentId: string | null
  title: string
  tags?: string[]
  recommendationToken?: string
  recommendationApplied?: boolean
}

export interface InboxSuggestedDestination {
  knowledgeBaseId: string
  knowledgeBaseName: string
  parentId: string | null
  folderPath: string
}

export interface InboxArchiveRecommendation {
  status: "recommended" | "uncertain" | "no_match"
  destination: InboxSuggestedDestination | null
  alternatives: InboxSuggestedDestination[]
  tags: string[]
  warnings: string[]
  confidence: number
  model: string
  feedbackToken?: string
  usage: { input_tokens: number; output_tokens: number }
}

export const inboxApi = {
  recommendationConfig: (signal?: AbortSignal) => api.post<{ enabled: boolean; demo?: boolean }>("/inbox/recommendation/config", {}, { signal }),
  recommend: (id: string, version: number, signal?: AbortSignal) => api.post<InboxArchiveRecommendation>("/inbox/recommendation", { id, version }, { signal }),
  list: (input: InboxListRequest, signal?: AbortSignal) => api.post<InboxListResponse>("/inbox/list", input, { signal }),
  create: (input: InboxContent & { clientId: string }) => api.post<InboxNote>("/inbox/create", input),
  update: (input: InboxContent & { id: string; version: number }) => api.post<InboxNote>("/inbox/update", input),
  pin: (id: string, pinned: boolean) => api.post<{ success: boolean }>("/inbox/pin", { id, pinned }),
  delete: (id: string, version: number) => api.post<{ success: boolean }>("/inbox/delete", { id, version }),
  archive: (input: InboxArchiveRequest) => api.post<InboxNote>("/inbox/archive", input),
}
