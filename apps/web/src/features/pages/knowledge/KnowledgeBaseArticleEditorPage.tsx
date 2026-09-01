import type { DiscussionUser } from "@/components/editor/plugins/discussion-kit"
import { AlertCircle, Hash, Plus, X } from "@/components/iconimate"
import {
  buildArticleSnapshotKey,
  buildMarkdownExportFileName,
  buildSnapshotFromArticleDetail,
  normalizeArticleTags as normalizeTags,
  type ArticleEditorSnapshot
} from "@/components/knowledge/article-editor-utils"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { ArticleChunkDialog } from "@/components/knowledge/ArticleChunkDialog"
import { ArticleShareDialog } from "@/components/knowledge/ArticleShareDialog"
import { BurnLinkDialog } from "@/components/knowledge/BurnLinkDialog"
import { PlateMarkdownEditor, type PlateMarkdownEditorHandle } from "@/components/plate/PlateMarkdownEditor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { buildToc } from "@/features/pages/public/public-article-utils"
import {
  authApi,
  knowledgeBaseArticleApi,
  publicArticleShareApi,
  type ArticleDetailResponse,
} from "@/lib/api"
import * as React from "react"
import { useLocation, useParams } from "react-router-dom"
import { toast } from "sonner"
import {
  AUTO_SAVE_DELAY_MS,
  LOCAL_DRAFT_DELAY_MS,
  buildCurrentSnapshot,
  formatSaveTime,
  readDraftRecord,
  removeDraftRecord,
  shouldRestoreDraft,
  writeDraftRecord,
  type ArticleDraftRecord,
  type SaveIntent,
} from "./article-editor-draft-utils"
import {
  ArticleEditorActionBar,
  ArticleEditorLoadingCard,
  ArticleSummaryPreview,
  BackToTopButton,
  EditorTocOverlay,
} from "./KnowledgeBaseArticleEditorPanels"
import { useArticleCitationNavigation } from "./use-article-citation-navigation"
import { useArticleFileImport } from "./use-article-file-import"
export function KnowledgeBaseArticleEditorPage() {
  const { knowledgeBaseId, articleId } = useParams()
  const routeLocation = useLocation()
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [saveIntent, setSaveIntent] = React.useState<SaveIntent | null>(null)
  const [lastSavedAt, setLastSavedAt] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [currentUser, setCurrentUser] = React.useState<DiscussionUser | null>(null)
  const [loaded, setLoaded] = React.useState<ArticleDetailResponse | null>(null)
  const [title, setTitle] = React.useState("")
  const [contentMd, setContentMd] = React.useState("")
  const [contentJson, setContentJson] = React.useState("")
  const [contentMetaJson, setContentMetaJson] = React.useState("")
  const [tags, setTags] = React.useState<string[]>([])
  const [tagDraft, setTagDraft] = React.useState("")
  const [tagInputVisible, setTagInputVisible] = React.useState(false)
  const [aiSummary, setAiSummary] = React.useState<string | null>(null)
  const [aiSummaryGeneratedAt, setAiSummaryGeneratedAt] = React.useState<string | null>(null)
  const [aiSummaryStale, setAiSummaryStale] = React.useState(false)
  const [generatingSummary, setGeneratingSummary] = React.useState(false)
  const [refreshingPublicCache, setRefreshingPublicCache] = React.useState(false)
  const [shareDialogOpen, setShareDialogOpen] = React.useState(false)
  const [burnDialogOpen, setBurnDialogOpen] = React.useState(false)
  const [chunkDialogOpen, setChunkDialogOpen] = React.useState(false)
  const [recoverableDraft, setRecoverableDraft] = React.useState<ArticleDraftRecord | null>(null)
  const [activeHeadingId, setActiveHeadingId] = React.useState("")
  // null = not yet measured; renders TOC only after we have the correct values
  const loadedArticleId = loaded?.articleId || ""
  const readOnly = Boolean(loaded?.readOnly)
  const isOwner = loaded?.permission === "OWNER"
  const navToc = React.useMemo(
    () => buildToc(contentMd).filter((item) => item.level >= 2 && item.level <= 4),
    [contentMd]
  )
  const currentSnapshot = React.useMemo(
    () => buildCurrentSnapshot(title, contentMd, contentJson, contentMetaJson, tags),
    [contentJson, contentMd, contentMetaJson, tags, title]
  )
  const loadedSnapshot = React.useMemo(
    () => (loaded ? buildSnapshotFromArticleDetail(loaded) : null),
    [loaded]
  )
  const articleContentDirty = React.useMemo(
    () => Boolean(loaded && contentMd !== loaded.contentMd),
    [contentMd, loaded]
  )
  const { editorWrapperRef, tocRight, tocTop } = useArticleCitationNavigation({
    search: routeLocation.search,
    loading,
    articleId: loadedArticleId,
    contentLength: contentMd.length,
  })
  const titleRef = React.useRef<HTMLTextAreaElement>(null)
  const tagInputRef = React.useRef<HTMLInputElement>(null)
  const markdownEditorRef = React.useRef<PlateMarkdownEditorHandle>(null)
  const localDraftTimerRef = React.useRef<number | null>(null)
  const currentSnapshotRef = React.useRef<ArticleEditorSnapshot>(currentSnapshot)
  const dirtyRef = React.useRef(false)
  const articleIdRef = React.useRef(articleId)
  const readOnlyRef = React.useRef(readOnly)
  const saveInFlightRef = React.useRef(false)
  const pendingSaveIntentRef = React.useRef<Extract<SaveIntent, "MANUAL" | "AUTO"> | null>(null)
  const aiSummaryRef = React.useRef<string | null>(null)
  const loadedContentMdRef = React.useRef("")
  // auto-resize title textarea
  React.useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = el.scrollHeight + "px"
  }, [title])
  // focus tag input when visible
  React.useEffect(() => {
    if (tagInputVisible) tagInputRef.current?.focus()
  }, [tagInputVisible])
  React.useEffect(() => {
    authApi.me().then((res) => {
      setCurrentUser({
        id: res.data.id,
        name: res.data.nickname || res.data.username || res.data.email,
        avatarUrl: res.data.avatar || undefined,
      })
    }).catch(() => {})
  }, [])
  React.useEffect(() => {
    if (!articleId) {
      setError("缺少文章ID")
      setLoaded(null)
      setAiSummary(null)
      setAiSummaryGeneratedAt(null)
      setAiSummaryStale(false)
      setRecoverableDraft(null)
      return
    }

    let canceled = false
    setLoading(true)
    setError(null)

    const request = knowledgeBaseArticleApi.detail(articleId)

    request
      .then((res) => {
        if (canceled) return
        setLoaded(res.data)
        setTitle(res.data.title || "")
        setContentMd(res.data.contentMd || "")
        setContentJson(res.data.contentJson || "")
        setContentMetaJson(res.data.contentMetaJson || "")
        setTags(Array.isArray(res.data.tags) ? normalizeTags(res.data.tags) : [])
        setAiSummary(res.data.aiSummary?.trim() || null)
        setAiSummaryGeneratedAt(res.data.aiSummaryGeneratedAt ?? null)
        setAiSummaryStale(Boolean(res.data.aiSummaryStale))
        setLastSavedAt(res.data.updatedAt || null)
        setSaveIntent(null)
        if (!res.data.readOnly) {
          const draft = readDraftRecord(res.data.articleId)
          const serverSnapshot = buildSnapshotFromArticleDetail(res.data)
          if (
            draft &&
            buildArticleSnapshotKey(draft) !== buildArticleSnapshotKey(serverSnapshot) &&
            shouldRestoreDraft(draft.updatedAt, res.data.updatedAt)
          ) {
            setRecoverableDraft(draft)
          } else {
            setRecoverableDraft(null)
            removeDraftRecord(res.data.articleId)
          }
        }
      })
      .catch((e) => {
        if (canceled) return
        const msg: string = e?.response?.data?.msg || e?.message || "加载文章失败"
        setError(msg)
        setLoaded(null)
        setAiSummary(null)
        setAiSummaryGeneratedAt(null)
        setAiSummaryStale(false)
        setRecoverableDraft(null)
      })
      .finally(() => {
        if (canceled) return
        setLoading(false)
      })

    return () => { canceled = true }
  }, [articleId])

  const dirty = React.useMemo(() => {
    if (!loadedSnapshot) return false
    return buildArticleSnapshotKey(currentSnapshot) !== buildArticleSnapshotKey(loadedSnapshot)
  }, [currentSnapshot, loadedSnapshot])

  React.useEffect(() => {
    currentSnapshotRef.current = currentSnapshot
  }, [currentSnapshot])

  React.useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  React.useEffect(() => {
    articleIdRef.current = articleId
  }, [articleId])

  React.useEffect(() => {
    readOnlyRef.current = readOnly
  }, [readOnly])

  React.useEffect(() => {
    aiSummaryRef.current = aiSummary
  }, [aiSummary])

  React.useEffect(() => {
    loadedContentMdRef.current = loaded?.contentMd || ""
  }, [loaded?.contentMd])

  const addTag = React.useCallback(() => {
    if (!tagDraft.trim()) return
    setTags((prev) => normalizeTags([...prev, tagDraft]))
    setTagDraft("")
  }, [tagDraft])

  const commitTag = React.useCallback(() => {
    addTag()
    setTagInputVisible(false)
  }, [addTag])

  const removeTag = React.useCallback((tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag))
  }, [])

  const saveNow = React.useCallback(async (intent: Extract<SaveIntent, "MANUAL" | "AUTO">) => {
    if (readOnlyRef.current) return false
    const currentArticleId = articleIdRef.current
    if (!currentArticleId) {
      if (intent === "MANUAL") setError("缺少文章ID，无法保存")
      return false
    }

    const snapshot = currentSnapshotRef.current
    const normalizedTitle = snapshot.title.trim()
    if (!normalizedTitle) {
      if (intent === "MANUAL") setError("标题不能为空")
      return false
    }
    if (!snapshot.contentMd.trim()) {
      if (intent === "MANUAL") setError("内容不能为空")
      return false
    }
    if (intent === "AUTO" && !dirtyRef.current) {
      return true
    }
    if (saveInFlightRef.current) {
      pendingSaveIntentRef.current = intent === "MANUAL" ? "MANUAL" : (pendingSaveIntentRef.current ?? "AUTO")
      return false
    }

    saveInFlightRef.current = true
    setSaving(true)
    setSaveIntent(intent)
    setError(null)
    const snapshotKeyAtRequest = buildArticleSnapshotKey(snapshot)
    const normalizedTags = normalizeTags(snapshot.tags)
    const contentChanged = snapshot.contentMd !== loadedContentMdRef.current
    try {
      const response = await knowledgeBaseArticleApi.update({
        articleId: currentArticleId,
        title: normalizedTitle,
        contentMd: snapshot.contentMd,
        contentJson: snapshot.contentJson || null,
        contentMetaJson: snapshot.contentMetaJson || null,
        tags: normalizedTags,
      })
      publicArticleShareApi.invalidateClientCache()
      const savedAt = new Date().toISOString()
      setTitle(normalizedTitle)
      setTags(normalizedTags)
      setLoaded((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          articleId: response.data.articleId || prev.articleId,
          nodeId: response.data.nodeId || prev.nodeId,
          title: normalizedTitle,
          contentMd: snapshot.contentMd,
          contentJson: snapshot.contentJson || null,
          contentMetaJson: snapshot.contentMetaJson || null,
          tags: normalizedTags,
          updatedAt: savedAt,
        }
      })
      setLastSavedAt(savedAt)
      loadedContentMdRef.current = snapshot.contentMd
      if (contentChanged && aiSummaryRef.current?.trim()) {
        setAiSummaryStale(true)
      }
      setError(null)
      if (buildArticleSnapshotKey(currentSnapshotRef.current) === snapshotKeyAtRequest) {
        removeDraftRecord(currentArticleId)
      }
      return true
    } catch (e: unknown) {
      setError(resolveAxiosErrorMessage(e, "保存失败"))
      return false
    } finally {
      setSaving(false)
      saveInFlightRef.current = false
      const queuedIntent = pendingSaveIntentRef.current
      pendingSaveIntentRef.current = null
      if (queuedIntent && dirtyRef.current) {
        void saveNow(queuedIntent)
      }
    }
  }, [])

  const handleContentStateChange = React.useCallback(
    (next: { markdown: string; contentJson: string; contentMetaJson: string }) => {
      setContentMd(next.markdown)
      setContentJson(next.contentJson)
      setContentMetaJson(next.contentMetaJson)
    },
    []
  )

  const {
    fileInputRef: markdownFileInputRef,
    importing: importingArticleFile,
    triggerImport: triggerArticleImport,
    handleFileChange: handleArticleImportFileChange,
  } = useArticleFileImport({
    articleId,
    readOnly,
    loading,
    saving,
    saveInFlightRef,
    editorRef: markdownEditorRef,
    loaded,
    loadedSnapshot,
    recoverableDraft,
    title,
    content: { markdown: contentMd, contentJson, contentMetaJson },
    tags,
    onContentChange: handleContentStateChange,
    onTitleChange: setTitle,
    onDraftResolved: () => setRecoverableDraft(null),
    onError: setError,
  })

  const handleExportMarkdown = React.useCallback(() => {
    if (typeof window === "undefined") return
    try {
      const latest = markdownEditorRef.current?.getContentState()
      const markdown = latest?.markdown ?? contentMd
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = buildMarkdownExportFileName(title || loaded?.title || "")
      document.body.append(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      toast.success("Markdown 已导出")
    } catch {
      const message = "导出 Markdown 失败，请稍后重试"
      setError(message)
      toast.error(message)
    }
  }, [contentMd, loaded?.title, title])

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac")
      const isSave = (isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "s"
      if (!isSave) return
      event.preventDefault()
      if (readOnly) return
      if (!dirty) return
      void saveNow("MANUAL")
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [dirty, readOnly, saveNow])

  React.useEffect(() => {
    if (!articleId || readOnly || !dirty) return
    const timer = window.setTimeout(() => {
      void saveNow("AUTO")
    }, AUTO_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [articleId, dirty, readOnly, currentSnapshot, saveNow])

  React.useEffect(() => {
    if (!articleId || readOnly || loading) return
    if (localDraftTimerRef.current) {
      window.clearTimeout(localDraftTimerRef.current)
      localDraftTimerRef.current = null
    }
    if (!dirty) {
      removeDraftRecord(articleId)
      return
    }
    localDraftTimerRef.current = window.setTimeout(() => {
      writeDraftRecord(articleId, {
        ...currentSnapshotRef.current,
        updatedAt: new Date().toISOString(),
        baseUpdatedAt: loaded?.updatedAt || null,
      })
      localDraftTimerRef.current = null
    }, LOCAL_DRAFT_DELAY_MS)
    return () => {
      if (localDraftTimerRef.current) {
        window.clearTimeout(localDraftTimerRef.current)
        localDraftTimerRef.current = null
      }
    }
  }, [articleId, dirty, loaded?.updatedAt, loading, readOnly, currentSnapshot])

  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (readOnlyRef.current || !dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [])

  React.useEffect(() => {
    const flushWhenHidden = () => {
      if (readOnlyRef.current || !dirtyRef.current) return
      void saveNow("AUTO")
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushWhenHidden()
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("pagehide", flushWhenHidden)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("pagehide", flushWhenHidden)
    }
  }, [saveNow])

  // Sync active heading to navToc
  React.useEffect(() => {
    if (!navToc.length) { setActiveHeadingId(""); return }
    setActiveHeadingId((prev) => {
      const firstItem = navToc[0]
      if (!firstItem) return ""
      if (!prev) return firstItem.id
      return navToc.some((item) => item.id === prev) ? prev : firstItem.id
    })
  }, [navToc])

  // Track active heading by window scroll
  React.useEffect(() => {
    if (!navToc.length) return
    let ticking = false

    const updateActive = () => {
      const container = document.querySelector(".plate-editor-content")
      if (!container) return
      const headings = Array.from(container.querySelectorAll("h2, h3, h4")) as HTMLElement[]
      if (!headings.length) return
      const scrollTop = window.scrollY + 80
      let activeIdx = 0
      for (let i = 0; i < Math.min(headings.length, navToc.length); i++) {
        const heading = headings[i]
        if (!heading) continue
        const absTop = heading.getBoundingClientRect().top + window.scrollY
        if (absTop <= scrollTop) activeIdx = i
      }
      setActiveHeadingId(navToc[activeIdx]?.id ?? navToc[0]?.id ?? "")
    }

    updateActive()
    const requestUpdate = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(() => { ticking = false; updateActive() })
    }
    window.addEventListener("scroll", requestUpdate, { passive: true })
    window.addEventListener("resize", requestUpdate)
    return () => {
      window.removeEventListener("scroll", requestUpdate)
      window.removeEventListener("resize", requestUpdate)
    }
  }, [navToc])

  const handleTocClick = React.useCallback((id: string) => {
    const idx = navToc.findIndex((item) => item.id === id)
    if (idx < 0) return
    const container = document.querySelector(".plate-editor-content")
    if (!container) return
    const headings = Array.from(container.querySelectorAll("h2, h3, h4")) as HTMLElement[]
    const el = headings[idx]
    if (!el) return
    const absTop = el.getBoundingClientRect().top + window.scrollY - 80
    window.scrollTo({ top: Math.max(0, absTop), behavior: "smooth" })
    setActiveHeadingId(id)
  }, [navToc])

  const restoreDraft = React.useCallback(() => {
    if (!recoverableDraft) return
    setTitle(recoverableDraft.title)
    setContentMd(recoverableDraft.contentMd)
    setContentJson(recoverableDraft.contentJson)
    setContentMetaJson(recoverableDraft.contentMetaJson)
    setTags(normalizeTags(recoverableDraft.tags))
    setRecoverableDraft(null)
    setError(null)
    toast.success("已恢复本地草稿")
  }, [recoverableDraft])

  const discardDraft = React.useCallback(() => {
    if (!articleId) return
    removeDraftRecord(articleId)
    setRecoverableDraft(null)
  }, [articleId])

  const handleGenerateSummary = React.useCallback(async () => {
    const currentArticleId = articleIdRef.current
    if (!currentArticleId || readOnlyRef.current || generatingSummary) return
    if (!contentMd.trim()) {
      setError("内容不能为空，无法生成总结")
      return
    }

    setGeneratingSummary(true)
    setError(null)
    try {
      if (dirtyRef.current) {
        const saved = await saveNow("MANUAL")
        if (!saved) {
          return
        }
      }

      const response = await knowledgeBaseArticleApi.generateSummary({
        articleId: currentArticleId,
        forceRebuild: Boolean(aiSummaryRef.current?.trim()),
      })
      const summary = response.data.summary.trim()
      setAiSummary(summary || null)
      setAiSummaryGeneratedAt(response.data.generatedAt ?? null)
      setAiSummaryStale(false)
      setLoaded((prev) => prev ? {
        ...prev,
        aiSummary: summary || null,
        aiSummaryGeneratedAt: response.data.generatedAt ?? null,
        aiSummaryStale: false,
        updatedAt: response.data.generatedAt || prev.updatedAt,
      } : prev)
      publicArticleShareApi.invalidateClientCache()
      toast.success(response.data.fromCache ? "已使用现有 AI 总结" : "AI 总结已生成")
    } catch (e: unknown) {
      setError(resolveAxiosErrorMessage(e, "生成 AI 总结失败"))
    } finally {
      setGeneratingSummary(false)
    }
  }, [contentMd, generatingSummary, saveNow])

  const handleRefreshPublicCache = React.useCallback(async () => {
    const currentArticleId = articleIdRef.current
    if (!currentArticleId || readOnlyRef.current || refreshingPublicCache) return
    if (dirtyRef.current) {
      setError("请先保存文章，再刷新公开缓存")
      return
    }

    setRefreshingPublicCache(true)
    setError(null)
    try {
      await knowledgeBaseArticleApi.refreshPublicCache(currentArticleId)
      publicArticleShareApi.invalidateClientCache()
      toast.success("公开缓存已刷新")
    } catch (e: unknown) {
      setError(resolveAxiosErrorMessage(e, "刷新公开缓存失败"))
    } finally {
      setRefreshingPublicCache(false)
    }
  }, [refreshingPublicCache])

  const saveStatusText = React.useMemo(() => {
    if (saving) {
      if (saveIntent === "AUTO") return "自动保存中..."
      return "保存中..."
    }
    if (error && dirty) {
      return "保存失败，等待重试"
    }
    if (dirty) {
      return "未保存"
    }
    if (lastSavedAt) {
      const prefix = saveIntent === "AUTO" ? "已自动保存" : "已保存"
      return `${prefix} ${formatSaveTime(lastSavedAt)}`
    }
    return "已保存"
  }, [dirty, error, lastSavedAt, saveIntent, saving])

  if (loading && !loaded) {
    return <ArticleEditorLoadingCard />
  }

  return (
    <div className="w-full px-6 py-6 lg:px-10">
      <input
        ref={markdownFileInputRef}
        type="file"
        accept=".md,.markdown,.docx,text/markdown,text/x-markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={handleArticleImportFileChange}
      />

      <ArticleEditorActionBar
        path={loaded?.path}
        readOnly={readOnly}
        error={error}
        dirty={dirty}
        saveStatusText={saveStatusText}
        articleReady={Boolean(articleId && loaded)}
        loading={loading}
        saving={saving}
        saveIntent={saveIntent}
        generatingSummary={generatingSummary}
        hasSummary={Boolean(aiSummary)}
        importing={importingArticleFile}
        isOwner={isOwner}
        refreshingCache={refreshingPublicCache}
        onGenerateSummary={() => { void handleGenerateSummary() }}
        onImport={triggerArticleImport}
        onExport={handleExportMarkdown}
        onOpenChunks={() => setChunkDialogOpen(true)}
        onOpenShare={() => setShareDialogOpen(true)}
        onOpenBurn={() => setBurnDialogOpen(true)}
        onRefreshCache={() => { void handleRefreshPublicCache() }}
        onSave={() => { void saveNow("MANUAL") }}
      />

      {recoverableDraft && !readOnly ? (
        <div className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/8 px-4 py-4 text-sm text-amber-900 dark:text-amber-100">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">检测到本地草稿</p>
              <p className="mt-1 text-amber-800/80 dark:text-amber-100/80">
                上次本地草稿时间为 {recoverableDraft.updatedAt}。如果这是异常退出前的内容，可以直接恢复。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={restoreDraft}>
              恢复草稿
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={discardDraft}>
              忽略草稿
            </Button>
          </div>
        </div>
      ) : null}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 mb-6 text-sm text-destructive">
          <AlertCircle className="size-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Title */}
      <textarea
        ref={titleRef}
        value={title}
        placeholder="无标题"
        disabled={loading || readOnly}
        rows={1}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full resize-none overflow-hidden bg-transparent border-0 outline-none text-3xl font-bold leading-tight placeholder:text-muted-foreground/25 disabled:opacity-60 mb-3"
      />

      {/* Tags row */}
      <div className="flex flex-wrap items-center gap-1.5 mb-8 min-h-[26px]">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1.5 h-5 text-xs font-normal rounded-full">
            <Hash className="size-2.5 opacity-40" />
            <span className="truncate max-w-[12rem]">{tag}</span>
            {!readOnly ? (
              <button
                type="button"
                className="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 opacity-40 hover:opacity-80"
                onClick={() => removeTag(tag)}
                aria-label={`移除标签：${tag}`}
                disabled={loading}
              >
                <X className="size-2.5" />
              </button>
            ) : null}
          </Badge>
        ))}
        {tagInputVisible && !readOnly ? (
          <Input
            ref={tagInputRef}
            value={tagDraft}
            placeholder="标签名..."
            disabled={loading}
            className="h-5 w-28 text-xs rounded-full px-2.5 py-0 border-dashed"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitTag() }
              else if (e.key === "Escape") { setTagDraft(""); setTagInputVisible(false) }
            }}
            onBlur={() => { if (tagDraft.trim()) addTag(); setTagInputVisible(false) }}
          />
        ) : (
          !readOnly && tags.length < 20 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 h-5 px-2 rounded-full text-xs text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted transition-colors"
              onClick={() => setTagInputVisible(true)}
              disabled={loading}
            >
              <Plus className="size-2.5" />
              添加标签
            </button>
          )
        )}
      </div>

      <ArticleSummaryPreview
        summary={aiSummary}
        generatedAt={aiSummaryGeneratedAt}
        stale={aiSummaryStale || articleContentDirty}
      />

      {/* Editor — wrapped so we can measure its right edge for TOC positioning */}
      <div ref={editorWrapperRef}>
        <PlateMarkdownEditor
          ref={markdownEditorRef}
          key={`${loaded?.articleId ?? `pending-${articleId ?? "unknown"}`}:${currentUser?.id ?? 'anon'}`}
          currentUser={currentUser ?? undefined}
          initialMarkdown={contentMd}
          initialContentJson={contentJson}
          initialContentMetaJson={contentMetaJson}
          disabled={loading || readOnly}
          placeholder="请输入文章内容..."
          onContentStateChange={handleContentStateChange}
        />
      </div>

      <ArticleShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        articleId={articleId}
      />

      <BurnLinkDialog
        open={burnDialogOpen}
        onOpenChange={setBurnDialogOpen}
        articleId={articleId}
      />

      <ArticleChunkDialog
        open={chunkDialogOpen}
        onOpenChange={setChunkDialogOpen}
        knowledgeBaseId={knowledgeBaseId}
        articleId={articleId}
        readOnly={readOnly}
      />

      {/* TOC — portal so position:fixed is relative to viewport.
          Only renders after both offsets are measured so the initial position is always correct. */}
      {navToc.length > 0 && tocRight !== null && tocTop !== null && (
        <EditorTocOverlay
          navToc={navToc}
          activeHeadingId={activeHeadingId}
          rightOffset={tocRight}
          topOffset={tocTop}
          onTocClick={handleTocClick}
        />
      )}

      {/* Back to top — portal so position:fixed is relative to viewport, not SidebarInset */}
      <BackToTopButton />
    </div>
  )
}
