"use client"

import * as React from "react"
import { documentImportApi, type DocumentImportCreateRequest, type DocumentImportCreateResponse, type DocumentImportImagePolicy } from "@/lib/api"
import { uploadFileToObjectStorage } from "@/lib/object-storage-upload"
import { getAuthSessionGeneration, subscribeAuthSessionReset } from "@/lib/auth-session-events"
import { BATCH_IMPORT_MAX_FILES, removeDocumentImportFileExtension } from "@/components/knowledge/article-editor-utils"
import { resolveApiErrorMessage } from "@/features/pages/knowledge/document-import-job-shared"

export type ImportItemStatus = "pending" | "uploading" | "creating" | "submitted" | "done" | "failed"
export interface ImportItem {
  id: string
  file: File
  title: string
  status: ImportItemStatus
  uploadPercent?: number
  sourceKey?: string
  jobId?: string
  /** 首次 create 前冻结完整请求；响应丢失时必须沿同 key、同参数重试。 */
  request?: Readonly<DocumentImportCreateRequest>
  articleId?: string | null
  error?: string
}
export interface ImportOptions {
  knowledgeBaseId: string
  parentId: string | null
  modelConfigId?: string | null
  concurrency: number
  imagePolicy?: DocumentImportImagePolicy
  onJobCreated?: (jobId: string) => void
}
type UpdateItem = (id: string, patch: Partial<ImportItem>) => void

export const ITEM_STATUS_LABEL: Record<ImportItemStatus, string> = {
  pending: "等待导入",
  uploading: "1 · 上传原始文档",
  creating: "2 · 提交后台任务",
  submitted: "已提交 · 后台解析及生成文章",
  done: "导入完成",
  failed: "提交失败",
}

export function resolveSubmissionStatus(result: DocumentImportCreateResponse): "done" | "submitted" {
  return result.articleId || result.job.articleId || result.job.status === "completed" ? "done" : "submitted"
}

export function resolveItemProgress(item: ImportItem) {
  return {
    active: item.status === "uploading" || item.status === "creating",
    value: item.status === "done" ? 100 : item.status === "uploading" ? item.uploadPercent ?? null : null,
    label: ITEM_STATUS_LABEL[item.status],
  }
}

/** 浏览器只上传原件并提交；解析、栅格化、OCR、成文全部由 Go / Asynq 完成。 */
export async function executeDocumentImport(
  item: ImportItem,
  options: ImportOptions,
  update: UpdateItem,
  signal: AbortSignal,
): Promise<"done" | "submitted"> {
  signal.throwIfAborted()
  // 普通卸载边界仍保存迟到的 key / 已确认任务；认证代次校验由 publish 负责。
  const patch = (next: Partial<ImportItem>) => update(item.id, next)
  if (item.jobId) {
    const status = item.articleId || item.status === "done" ? "done" : "submitted"
    patch({ status, error: undefined })
    return status
  }
  let request = item.request
  if (!request) {
    let sourceKey = item.sourceKey
    if (!sourceKey) {
      patch({ status: "uploading", uploadPercent: undefined, error: undefined })
      const uploaded = await uploadFileToObjectStorage(item.file, {
        signal,
        timeoutMs: 300_000,
        onProgress: (uploadPercent) => { if (!signal.aborted) patch({ uploadPercent }) },
      })
      sourceKey = uploaded.key
      patch({ sourceKey })
    }
    signal.throwIfAborted()
    request = Object.freeze({
      idempotencyKey: crypto.randomUUID(),
      knowledgeBaseId: options.knowledgeBaseId,
      parentId: options.parentId,
      fileName: item.file.name,
      title: item.title.trim() || removeDocumentImportFileExtension(item.file.name) || "未命名文档",
      sourceKey,
      modelConfigId: options.modelConfigId,
      concurrency: options.concurrency,
      imagePolicy: options.imagePolicy ?? "keep_and_recognize",
    })
    patch({ request, title: request.title })
  }
  signal.throwIfAborted()
  patch({ status: "creating", error: undefined })
  const { data } = await documentImportApi.createJob(request, { signal, timeout: 30_000 })
  const status = resolveSubmissionStatus(data)
  // 响应已确认即完成浏览器工作，即使此时已卸载也不转为失败、不取消后端任务。
  patch({ jobId: data.job.id, articleId: data.articleId ?? data.job.articleId, status, error: undefined })
  if (!signal.aborted) {
    try { options.onJobCreated?.(data.job.id) } catch { /* 通知失败不能撤销已确认的提交。 */ }
  }
  return status
}

interface ImportSnapshot { items: ImportItem[]; running: boolean; capacityError?: string }
interface ImportSession {
  knowledgeBaseId: string
  generation: number
  snapshot: ImportSnapshot
  controller: AbortController | null
  listeners: Set<() => void>
}
const sessions = new Map<string, ImportSession>()
const mountedSessions = new Set<ImportSession>()
const MAX_RECOVERY_BYTES = 500 * 1024 * 1024
const needsSubmission = (item: ImportItem) => !item.jobId && item.status !== "done" && item.status !== "submitted"
const preventUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault()
  event.returnValue = "原文件上传或任务提交尚未结束，请等待提交成功后再关闭。"
}

// 模块级订阅也覆盖已卸载的知识库；只中止上传 / 提交，不取消已提交的后台任务。
subscribeAuthSessionReset(() => {
  const staleSessions = new Set([...sessions.values(), ...mountedSessions])
  sessions.clear()
  for (const session of staleSessions) {
    session.snapshot = { items: [], running: false }
    const controller = session.controller
    session.controller = null
    controller?.abort()
  }
  if (typeof window !== "undefined") window.removeEventListener("beforeunload", preventUnload)
  staleSessions.forEach((session) => session.listeners.forEach((listener) => listener()))
})

/** 只在本标签页按知识库保留未确认请求；拒绝超额新增，不淘汰未提交文件。 */
function publish(session: ImportSession, patch: Partial<ImportSnapshot>) {
  if (session.generation !== getAuthSessionGeneration()) return
  session.snapshot = { ...session.snapshot, ...patch }
  if (session.listeners.size === 0) {
    // 已确认任务不再依赖 File，即使批次尚未结束也可释放。
    session.snapshot.items = session.snapshot.items.filter(needsSubmission)
  }
  if (session.snapshot.running || session.snapshot.items.some(needsSubmission)) sessions.set(session.knowledgeBaseId, session)
  else if (sessions.get(session.knowledgeBaseId) === session) sessions.delete(session.knowledgeBaseId)
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", preventUnload)
    if ([...sessions.values()].some((entry) => entry.snapshot.running)) window.addEventListener("beforeunload", preventUnload)
  }
  session.listeners.forEach((listener) => listener())
}

export function useDocumentImport(options: ImportOptions) {
  const generation = React.useSyncExternalStore(subscribeAuthSessionReset, getAuthSessionGeneration, getAuthSessionGeneration)
  const session = React.useMemo<ImportSession>(() => {
    const cached = sessions.get(options.knowledgeBaseId)
    return cached?.generation === generation ? cached : {
      knowledgeBaseId: options.knowledgeBaseId, generation,
      snapshot: { items: [], running: false }, controller: null, listeners: new Set(),
    }
  }, [options.knowledgeBaseId, generation])
  const subscribe = React.useCallback((listener: () => void) => {
    mountedSessions.add(session)
    session.listeners.add(listener)
    return () => {
      session.listeners.delete(listener)
      if (session.listeners.size === 0) {
        mountedSessions.delete(session)
        session.controller?.abort()
        publish(session, {})
      }
    }
  }, [session])
  const getSnapshot = React.useCallback(() => session.snapshot, [session])
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setItems = React.useCallback<React.Dispatch<React.SetStateAction<ImportItem[]>>>((action) => {
    if (session.generation !== getAuthSessionGeneration()) return
    const items = typeof action === "function" ? action(session.snapshot.items) : action
    const retained = [...new Set([...sessions.values(), ...mountedSessions])]
      .filter((entry) => entry !== session).flatMap((entry) => entry.snapshot.items)
    const all = [...retained, ...items]
    if (all.length > BATCH_IMPORT_MAX_FILES || all.reduce((size, item) => size + item.file.size, 0) > MAX_RECOVERY_BYTES) {
      publish(session, { capacityError: "本标签页最多保留 50 个 / 500MB 导入文件，请先完成或移除其他知识库中的未提交项。" })
      return
    }
    publish(session, { items, capacityError: undefined })
  }, [session])
  const updateItem = React.useCallback<UpdateItem>((id, patch) => {
    publish(session, { items: session.snapshot.items.map((item) => item.id === id ? {
      ...item, ...patch,
      // 冻结后的标题与请求永不因 UI 编辑或重试选项变化而改变。
      ...(item.request ? { request: item.request, title: item.request.title } : {}),
    } : item) })
  }, [session])

  const runImport = async (targets: ImportItem[]) => {
    if (session.generation !== getAuthSessionGeneration() || session.controller || targets.length === 0) return null
    const abort = new AbortController()
    session.controller = abort
    publish(session, { running: true })
    const result = { completed: 0, submitted: 0, failed: 0 }
    try {
      for (const target of targets) {
        if (abort.signal.aborted) break
        const item = session.snapshot.items.find((row) => row.id === target.id)
        if (!item || !needsSubmission(item)) continue
        try {
          const status = await executeDocumentImport(item, options, updateItem, abort.signal)
          if (status === "done") result.completed += 1
          else result.submitted += 1
        } catch (error) {
          updateItem(item.id, {
            status: "failed",
            error: abort.signal.aborted ? "上传或提交已中断，可在本标签页重试。未确认的请求将使用相同参数安全重试。" : resolveApiErrorMessage(error, "提交失败，可安全重试"),
          })
          result.failed += 1
        }
      }
      return abort.signal.aborted ? null : result
    } finally {
      if (session.generation === getAuthSessionGeneration()) {
        session.controller = null
        publish(session, { running: false })
      }
    }
  }
  return { ...snapshot, setItems, updateItem, runImport }
}
