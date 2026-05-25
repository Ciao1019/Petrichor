import * as React from "react"
import { createPortal } from "react-dom"
import { AlertCircle, ChevronUp, FileDown, FileUp, Hash, Plus, RefreshCw, Save, Share2, Sparkles, X } from "lucide-react"
import { toast } from "sonner"
import { useParams } from "react-router-dom"

import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { PlateMarkdownEditor, type PlateMarkdownEditorHandle } from "@/components/plate/PlateMarkdownEditor"
import { ArticleShareDialog } from "@/components/knowledge/ArticleShareDialog"
import {
  buildArticleSnapshotKey,
  buildMarkdownExportFileName,
  buildSnapshotFromArticleDetail,
  isDocxFileName,
  isMarkdownFileName,
  normalizeArticleTags as normalizeTags,
  resolveMarkdownImportTitle,
  validateDocxImportFile,
  validateMarkdownImportFile,
  validateMarkdownImportText,
  type ArticleEditorSnapshot,
} from "@/components/knowledge/article-editor-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  knowledgeBaseArticleApi,
  publicArticleShareApi,
  type ArticleDetailResponse,
  authApi,
} from "@/lib/api"
import type { DiscussionUser } from "@/components/editor/plugins/discussion-kit"
import { buildToc, type TocItem } from "@/features/pages/public/public-article-utils"
import { cn } from "@/lib/utils"

const AI_CITATION_HIGHLIGHT_CLASSES = [
  "rounded-md",
  "bg-primary/10",
  "ring-2",
  "ring-primary/30",
  "transition-colors",
] as const

const AI_CITATION_BLOCK_SELECTOR = [
  '[data-article-block="paragraph"]',
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "td",
  "th",
].join(", ")

type AiCitationLocation = {
  index: number | null
  sourceId: string
  chunkId: string
  snippet: string
  highlightTerms: string[]
}

type SaveIntent = "MANUAL" | "AUTO"

type ArticleDraftRecord = ArticleEditorSnapshot & {
  updatedAt: string
  baseUpdatedAt?: string | null
}

const AUTO_SAVE_DELAY_MS = 2500
const LOCAL_DRAFT_DELAY_MS = 800

function cleanCitationText(value: string) {
  return value
    .replace(/---\s*above content is overlap of prefix chunk\s*---/gi, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`>#*_~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeCitationText(value: string) {
  return cleanCitationText(value).toLowerCase().replace(/\s+/g, "")
}

function parseAiCitationLocation(search: string): AiCitationLocation | null {
  if (!search) return null
  const params = new URLSearchParams(search)
  const hasPayload = [
    "citeIndex",
    "citeSourceId",
    "citeChunkId",
    "citeSnippet",
    "citeTerms",
  ].some((key) => params.has(key))
  if (!hasPayload) return null
  const indexValue = params.get("citeIndex")
  const parsedIndex = indexValue ? Number.parseInt(indexValue, 10) : null
  const highlightTerms = (params.get("citeTerms") || "")
    .split("\n")
    .map((item) => cleanCitationText(item))
    .filter(Boolean)
  return {
    index: parsedIndex && Number.isFinite(parsedIndex) && parsedIndex > 0 ? parsedIndex : null,
    sourceId: params.get("citeSourceId")?.trim() || "",
    chunkId: params.get("citeChunkId")?.trim() || "",
    snippet: cleanCitationText(params.get("citeSnippet") || ""),
    highlightTerms: Array.from(new Set(highlightTerms)),
  }
}

function buildCitationSnippetCandidates(snippet: string) {
  const cleaned = cleanCitationText(snippet)
  if (!cleaned) return []
  return Array.from(
    new Set(
      cleaned
        .split(/[。！？!?；;，,\n]/)
        .map((item) => cleanCitationText(item))
        .filter((item) => item.length >= 4)
        .sort((left, right) => right.length - left.length)
        .slice(0, 6)
    )
  )
}

function buildCurrentSnapshot(
  title: string,
  contentMd: string,
  contentJson: string,
  contentMetaJson: string,
  tags: string[],
): ArticleEditorSnapshot {
  return {
    title,
    contentMd,
    contentJson,
    contentMetaJson,
    tags: normalizeTags(tags),
  }
}

function getDraftStorageKey(articleId: string): string {
  return `kb-article-draft:${articleId}`
}

function readDraftRecord(articleId: string): ArticleDraftRecord | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(getDraftStorageKey(articleId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ArticleDraftRecord>
    if (
      typeof parsed.title !== "string" ||
      typeof parsed.contentMd !== "string" ||
      typeof parsed.contentJson !== "string" ||
      typeof parsed.contentMetaJson !== "string" ||
      !Array.isArray(parsed.tags) ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null
    }
    return {
      title: parsed.title,
      contentMd: parsed.contentMd,
      contentJson: parsed.contentJson,
      contentMetaJson: parsed.contentMetaJson,
      tags: normalizeTags(parsed.tags.filter((item): item is string => typeof item === "string")),
      updatedAt: parsed.updatedAt,
      baseUpdatedAt: typeof parsed.baseUpdatedAt === "string" ? parsed.baseUpdatedAt : null,
    }
  } catch {
    return null
  }
}

function writeDraftRecord(articleId: string, draft: ArticleDraftRecord) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(getDraftStorageKey(articleId), JSON.stringify(draft))
  } catch {
    // 忽略本地存储配额异常，避免影响编辑主链路。
  }
}

function removeDraftRecord(articleId: string) {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(getDraftStorageKey(articleId))
}

function shouldRestoreDraft(draftUpdatedAt: string, articleUpdatedAt?: string | null): boolean {
  const draftTime = Date.parse(draftUpdatedAt)
  const articleTime = articleUpdatedAt ? Date.parse(articleUpdatedAt) : Number.NaN
  if (Number.isNaN(draftTime)) return true
  if (Number.isNaN(articleTime)) return true
  return draftTime > articleTime
}

function formatSaveTime(value?: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function scoreCitationBlock(
  block: HTMLElement,
  snippetCandidates: string[],
  highlightTerms: string[],
) {
  const rawText = cleanCitationText(block.textContent || "")
  const normalizedBlockText = normalizeCitationText(rawText)
  if (!normalizedBlockText) return Number.NEGATIVE_INFINITY

  let score = 0
  for (const candidate of snippetCandidates) {
    const normalizedCandidate = normalizeCitationText(candidate)
    if (!normalizedCandidate) continue
    if (normalizedBlockText.includes(normalizedCandidate)) {
      score = Math.max(score, 1000 + normalizedCandidate.length)
      continue
    }
    if (
      normalizedCandidate.length >= 12 &&
      normalizedCandidate.includes(normalizedBlockText) &&
      normalizedBlockText.length >= 8
    ) {
      score = Math.max(score, 760 + normalizedBlockText.length)
    }
  }

  for (const term of highlightTerms) {
    const normalizedTerm = normalizeCitationText(term)
    if (!normalizedTerm) continue
    if (normalizedBlockText.includes(normalizedTerm)) {
      score += 24 + Math.min(normalizedTerm.length, 24)
    }
  }

  const tagName = block.tagName.toLowerCase()
  if (tagName === "li" || tagName === "blockquote" || block.dataset.articleBlock === "paragraph") {
    score += 18
  } else if (/^h[1-6]$/.test(tagName)) {
    score += 8
  }

  return score
}

export function KnowledgeBaseArticleEditorPage() {
  const { knowledgeBaseId, articleId } = useParams()

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
  const [importingArticleFile, setImportingArticleFile] = React.useState(false)
  const [refreshingPublicCache, setRefreshingPublicCache] = React.useState(false)
  const [shareDialogOpen, setShareDialogOpen] = React.useState(false)
  const [recoverableDraft, setRecoverableDraft] = React.useState<ArticleDraftRecord | null>(null)
  const [activeHeadingId, setActiveHeadingId] = React.useState("")
  // null = not yet measured; renders TOC only after we have the correct values
  const [tocRight, setTocRight] = React.useState<number | null>(null)
  const [tocTop, setTocTop] = React.useState<number | null>(null)
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

  const titleRef = React.useRef<HTMLTextAreaElement>(null)
  const tagInputRef = React.useRef<HTMLInputElement>(null)
  const markdownFileInputRef = React.useRef<HTMLInputElement>(null)
  const markdownEditorRef = React.useRef<PlateMarkdownEditorHandle>(null)
  const editorWrapperRef = React.useRef<HTMLDivElement>(null)
  const highlightedBlockRef = React.useRef<HTMLElement | null>(null)
  const highlightTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const localDraftTimerRef = React.useRef<number | null>(null)
  const currentSnapshotRef = React.useRef<ArticleEditorSnapshot>(currentSnapshot)
  const dirtyRef = React.useRef(false)
  const articleIdRef = React.useRef(articleId)
  const readOnlyRef = React.useRef(readOnly)
  const saveInFlightRef = React.useRef(false)
  const pendingSaveIntentRef = React.useRef<Extract<SaveIntent, "MANUAL" | "AUTO"> | null>(null)
  const lastCitationLocateKeyRef = React.useRef("")
  const aiSummaryRef = React.useRef<string | null>(null)
  const loadedContentMdRef = React.useRef("")
  const citationLocation = React.useMemo(() => parseAiCitationLocation(location.search), [location.search])

  const clearCitationHighlight = React.useCallback(() => {
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
    if (highlightedBlockRef.current) {
      highlightedBlockRef.current.classList.remove(...AI_CITATION_HIGHLIGHT_CLASSES)
      highlightedBlockRef.current = null
    }
  }, [])

  const highlightCitationBlock = React.useCallback((target: HTMLElement) => {
    clearCitationHighlight()
    target.classList.add(...AI_CITATION_HIGHLIGHT_CLASSES)
    highlightedBlockRef.current = target
    highlightTimerRef.current = setTimeout(() => {
      if (highlightedBlockRef.current === target) {
        target.classList.remove(...AI_CITATION_HIGHLIGHT_CLASSES)
        highlightedBlockRef.current = null
      }
      highlightTimerRef.current = null
    }, 4200)
  }, [clearCitationHighlight])

  const findCitationTarget = React.useCallback((payload: AiCitationLocation) => {
    const editorRoot = editorWrapperRef.current?.querySelector(".plate-editor-content")
    if (!(editorRoot instanceof HTMLElement)) return null
    const blocks = Array.from(editorRoot.querySelectorAll<HTMLElement>(AI_CITATION_BLOCK_SELECTOR))
      .filter((element) => cleanCitationText(element.textContent || "").length > 0)
    if (blocks.length === 0) return null

    const snippetCandidates = buildCitationSnippetCandidates(payload.snippet)
    const highlightTerms = Array.from(
      new Set(
        payload.highlightTerms
          .map((item) => cleanCitationText(item))
          .filter((item) => item.length >= 2)
      )
    )

    let bestTarget: HTMLElement | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const block of blocks) {
      const score = scoreCitationBlock(block, snippetCandidates, highlightTerms)
      if (score > bestScore) {
        bestScore = score
        bestTarget = block
      }
    }

    return bestScore > 0 ? bestTarget : null
  }, [])

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

  // tocRight: editor's horizontal position only changes on resize (not scroll)
  React.useLayoutEffect(() => {
    const calcRight = () => {
      const el = editorWrapperRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setTocRight(Math.max(4, window.innerWidth - rect.right + 8))
    }
    calcRight()
    const ro = new ResizeObserver(calcRight)
    ro.observe(document.documentElement)
    if (editorWrapperRef.current) ro.observe(editorWrapperRef.current)
    window.addEventListener("resize", calcRight)
    return () => { ro.disconnect(); window.removeEventListener("resize", calcRight) }
  }, [])

  // tocTop: editor's vertical position changes on scroll — clamp TOC so it never
  // floats above the editor card's top (toolbar area is ~52px tall)
  const calcTop = React.useCallback(() => {
    const el = editorWrapperRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    const normalTop = vh * 0.2
    // Don't let TOC go above the editor card's top + toolbar offset
    const minTop = Math.max(rect.top + 52, 0)
    setTocTop(Math.min(Math.max(normalTop, minTop), vh * 0.75))
  }, [])

  React.useLayoutEffect(() => {
    calcTop()
    window.addEventListener("resize", calcTop)
    return () => window.removeEventListener("resize", calcTop)
  }, [calcTop])

  React.useEffect(() => {
    window.addEventListener("scroll", calcTop, { passive: true })
    return () => window.removeEventListener("scroll", calcTop)
  }, [calcTop])

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

  React.useEffect(() => {
    return () => clearCitationHighlight()
  }, [clearCitationHighlight])

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

  const showArticleImportError = React.useCallback((message: string) => {
    setError(message)
    toast.error(message)
  }, [])

  const syncLatestEditorContentState = React.useCallback(() => {
    const latest = markdownEditorRef.current?.getContentState()
    if (latest) {
      handleContentStateChange(latest)
    }
    return latest
  }, [handleContentStateChange])

  const hasUnsavedContentBeforeImport = React.useCallback(
    (latest?: { markdown: string; contentJson: string; contentMetaJson: string }) => {
      if (recoverableDraft) return true
      if (!loadedSnapshot) return false
      const latestSnapshot = buildCurrentSnapshot(
        title,
        latest?.markdown ?? contentMd,
        latest?.contentJson ?? contentJson,
        latest?.contentMetaJson ?? contentMetaJson,
        tags
      )
      return buildArticleSnapshotKey(latestSnapshot) !== buildArticleSnapshotKey(loadedSnapshot)
    },
    [contentJson, contentMd, contentMetaJson, loadedSnapshot, recoverableDraft, tags, title]
  )

  const triggerArticleImport = React.useCallback(() => {
    if (readOnly || loading || saving || importingArticleFile) return
    markdownFileInputRef.current?.click()
  }, [importingArticleFile, loading, readOnly, saving])

  const handleArticleImportFileChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ""
      if (!file) return

      if (readOnlyRef.current) {
        showArticleImportError("只读文章不能导入文件")
        return
      }
      if (loading) {
        showArticleImportError("文章仍在加载中，请稍后再导入")
        return
      }
      if (saving || saveInFlightRef.current || importingArticleFile) {
        showArticleImportError("文章正在保存或导入中，请稍后再试")
        return
      }

      const isMarkdownImport = isMarkdownFileName(file.name)
      const isDocxImport = isDocxFileName(file.name)
      if (!isMarkdownImport && !isDocxImport) {
        showArticleImportError("请选择 .md、.markdown 或 .docx 格式的文件")
        return
      }

      const fileValidationError = isDocxImport
        ? validateDocxImportFile(file)
        : validateMarkdownImportFile(file)
      if (fileValidationError) {
        showArticleImportError(fileValidationError)
        return
      }

      let markdown = ""
      if (isMarkdownImport) {
        try {
          markdown = await file.text()
        } catch {
          showArticleImportError("读取 Markdown 文件失败，请重新选择文件")
          return
        }
        const markdownValidationError = validateMarkdownImportText(markdown)
        if (markdownValidationError) {
          showArticleImportError(markdownValidationError)
          return
        }
      }

      const latest = syncLatestEditorContentState()
      if (hasUnsavedContentBeforeImport(latest)) {
        const confirmed = window.confirm(
          "当前文章有未保存内容或本地草稿，导入文件会覆盖标题和正文。确定继续导入吗？"
        )
        if (!confirmed) return
      }

      setImportingArticleFile(true)
      try {
        const importedState = isDocxImport
          ? await markdownEditorRef.current?.importDocx(file)
          : markdownEditorRef.current?.importMarkdown(markdown)
        if (!importedState) {
          showArticleImportError("编辑器尚未准备好，请稍后再导入")
          return
        }

        const nextTitle = resolveMarkdownImportTitle(importedState.markdown, file.name)
        setTitle(nextTitle)
        handleContentStateChange(importedState)
        const draftArticleId = loaded?.articleId || articleIdRef.current
        if (draftArticleId) {
          writeDraftRecord(draftArticleId, {
            title: nextTitle,
            contentMd: importedState.markdown,
            contentJson: importedState.contentJson,
            contentMetaJson: importedState.contentMetaJson,
            tags: normalizeTags(tags),
            updatedAt: new Date().toISOString(),
            baseUpdatedAt: loaded?.updatedAt || null,
          })
        }
        setRecoverableDraft(null)
        setError(null)
        if (isDocxImport) {
          const docxImportState = importedState as {
            commentsCount?: number
            uploadedImageCount?: number
            warnings?: string[]
          }
          if (docxImportState.warnings?.length) {
            console.warn("[DOCX import] 转换警告", docxImportState.warnings)
          }
          const imageText = docxImportState.uploadedImageCount
            ? `，已上传 ${docxImportState.uploadedImageCount} 张图片`
            : ""
          const commentText = docxImportState.commentsCount
            ? `；${docxImportState.commentsCount} 条批注暂未导入`
            : ""
          toast.success(`DOCX 已导入${imageText}${commentText}，保存后生效`)
        } else {
          toast.success("Markdown 已导入，保存后生效")
        }
      } catch (error) {
        if (isDocxImport) {
          console.error("[DOCX import] 导入失败", error)
        }
        showArticleImportError(
          isDocxImport
            ? "导入 DOCX 失败，请检查文件内容或图片上传配置后重试"
            : "导入 Markdown 失败，请检查文件内容后重试"
        )
      } finally {
        setImportingArticleFile(false)
      }
    },
    [
      handleContentStateChange,
      hasUnsavedContentBeforeImport,
      importingArticleFile,
      loaded?.articleId,
      loaded?.updatedAt,
      loading,
      saving,
      showArticleImportError,
      syncLatestEditorContentState,
      tags,
    ]
  )

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
      if (!prev) return navToc[0].id
      return navToc.some((item) => item.id === prev) ? prev : navToc[0].id
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
        const absTop = headings[i].getBoundingClientRect().top + window.scrollY
        if (absTop <= scrollTop) activeIdx = i
      }
      setActiveHeadingId(navToc[activeIdx]?.id ?? navToc[0].id)
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

  React.useEffect(() => {
    if (loading || !loadedArticleId || !citationLocation) return

    const locateKey = [
      loadedArticleId,
      location.search,
      contentMd.length,
      citationLocation.chunkId,
      citationLocation.sourceId,
      citationLocation.index ?? "",
    ].join("|")
    if (lastCitationLocateKeyRef.current === locateKey) return

    let cancelled = false
    let rafId = 0
    let attempt = 0
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    const tryLocate = () => {
      if (cancelled) return
      const target = findCitationTarget(citationLocation)
      if (target) {
        lastCitationLocateKeyRef.current = locateKey
        target.scrollIntoView({
          behavior: prefersReducedMotion ? "auto" : "smooth",
          block: "center",
          inline: "nearest",
        })
        highlightCitationBlock(target)
        return
      }
      attempt += 1
      if (attempt < 24) {
        rafId = window.requestAnimationFrame(tryLocate)
      }
    }

    rafId = window.requestAnimationFrame(tryLocate)
    return () => {
      cancelled = true
      if (rafId) {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [
    citationLocation,
    contentMd.length,
    findCitationTarget,
    highlightCitationBlock,
    loadedArticleId,
    loading,
    location.search,
  ])

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

      {/* Action bar */}
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          {loaded?.path ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="truncate text-xs text-muted-foreground/60">{loaded.path}</p>
              {readOnly ? <Badge variant="secondary">只读</Badge> : null}
              {!readOnly ? (
                <span
                  className={cn(
                    "text-xs select-none",
                    error && dirty
                      ? "text-destructive"
                      : dirty
                        ? "text-amber-600"
                        : "text-muted-foreground/60"
                  )}
                >
                  {saveStatusText}
                </span>
              ) : null}
            </div>
          ) : <span />}
        </div>
        <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto sm:shrink-0 sm:justify-end">
          {!readOnly ? (
            <Button
              variant="ghost" size="sm"
              className="h-8 gap-1.5 text-muted-foreground hover:text-foreground px-2.5"
              disabled={!articleId || loading || saving || generatingSummary}
              onClick={() => void handleGenerateSummary()}
            >
              <Sparkles className="size-3.5" />
              <span className="text-sm hidden sm:inline">
                {generatingSummary ? "总结中..." : aiSummary ? "重新总结" : "AI 总结"}
              </span>
            </Button>
          ) : null}
          {!readOnly ? (
            <Button
              variant="ghost" size="sm"
              className="h-8 gap-1.5 text-muted-foreground hover:text-foreground px-2.5"
              disabled={!articleId || loading || saving || importingArticleFile}
              onClick={triggerArticleImport}
            >
              <FileUp className="size-3.5" />
              <span className="text-sm hidden sm:inline">
                {importingArticleFile ? "导入中..." : "导入"}
              </span>
            </Button>
          ) : null}
          <Button
            variant="ghost" size="sm"
            className="h-8 gap-1.5 text-muted-foreground hover:text-foreground px-2.5"
            disabled={loading || !loaded}
            onClick={handleExportMarkdown}
          >
            <FileDown className="size-3.5" />
            <span className="text-sm hidden sm:inline">导出</span>
          </Button>
          {isOwner ? (
            <Button
              variant="ghost" size="sm"
              className="h-8 gap-1.5 text-muted-foreground hover:text-foreground px-2.5"
              disabled={!articleId}
              onClick={() => setShareDialogOpen(true)}
            >
              <Share2 className="size-3.5" />
              <span className="text-sm hidden sm:inline">公开分享</span>
            </Button>
          ) : null}
          {!readOnly ? (
            <Button
              variant="ghost" size="sm"
              className="h-8 gap-1.5 text-muted-foreground hover:text-foreground px-2.5"
              disabled={!articleId || loading || saving || dirty || refreshingPublicCache}
              onClick={() => void handleRefreshPublicCache()}
            >
              <RefreshCw className={cn("size-3.5", refreshingPublicCache && "animate-spin")} />
              <span className="text-sm hidden sm:inline">
                {refreshingPublicCache ? "刷新中..." : "刷新缓存"}
              </span>
            </Button>
          ) : null}
          {!readOnly ? (
            <Button
              size="sm" className="h-8 gap-1.5 px-4"
              onClick={() => void saveNow("MANUAL")}
              disabled={!dirty || loading || saving || !articleId}
            >
              <Save className="size-3.5" />
              {saving && saveIntent !== "AUTO" ? "保存中..." : dirty ? "保存" : "已保存"}
            </Button>
          ) : null}
        </div>
      </div>

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

function ArticleSummaryPreview({
  summary,
  generatedAt,
  stale,
}: {
  summary: string | null
  generatedAt: string | null
  stale: boolean
}) {
  if (!summary?.trim()) return null

  return (
    <section className="mb-6 rounded-lg border border-primary/15 bg-primary/5 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-primary">AI 总结</span>
        {stale ? (
          <Badge variant="outline" className="h-5 border-amber-500/40 text-[11px] text-amber-600">
            待重新生成
          </Badge>
        ) : null}
        {generatedAt ? (
          <span className="text-xs text-muted-foreground">
            {formatSaveTime(generatedAt)}
          </span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">
        {summary}
      </p>
    </section>
  )
}

/* ─── Editor loading skeleton ────────────────────────────── */

function ArticleEditorLoadingCard() {
  return (
    <div className="w-full px-6 py-6 lg:px-10 animate-in fade-in-0 duration-300">
      {/* Action bar skeleton */}
      <div className="flex items-center justify-between gap-4 mb-8">
        <div className="h-3.5 w-32 rounded-lg bg-muted/60 animate-pulse" />
        <div className="flex items-center gap-2">
          <div className="h-8 w-14 rounded-md bg-muted/60 animate-pulse" />
          <div className="h-8 w-14 rounded-md bg-muted/60 animate-pulse" />
          <div className="h-8 w-20 rounded-md bg-muted/60 animate-pulse" />
        </div>
      </div>
      {/* Title skeleton */}
      <div className="h-9 w-2/5 rounded-lg bg-muted/60 animate-pulse mb-3" />
      {/* Tags skeleton */}
      <div className="flex items-center gap-2 mb-8">
        <div className="h-5 w-16 rounded-full bg-muted/60 animate-pulse" />
        <div className="h-5 w-20 rounded-full bg-muted/60 animate-pulse" />
      </div>
      {/* Editor area skeleton */}
      <div className="rounded-lg border bg-muted/10 px-8 py-8 space-y-5">
        <div className="h-3.5 w-full rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-11/12 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-4/5 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-px w-full bg-muted/30" />
        <div className="h-3.5 w-full rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-3/4 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-5/6 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-2/3 rounded-lg bg-muted/60 animate-pulse" />
      </div>
    </div>
  )
}

/* ─── Editor TOC overlay (portal + fixed) ──────────────── */

const LINE_W: Record<number, number> = { 2: 14, 3: 10, 4: 7 }
const LINE_W_ACTIVE: Record<number, number> = { 2: 22, 3: 18, 4: 13 }

function EditorTocOverlay({
  navToc,
  activeHeadingId,
  rightOffset,
  topOffset,
  onTocClick,
}: {
  navToc: TocItem[]
  activeHeadingId: string
  rightOffset: number
  topOffset: number
  onTocClick: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLElement | null>(null)
  const clickLockRef = React.useRef(false)

  React.useEffect(() => {
    if (clickLockRef.current) return
    const container = containerRef.current
    if (!container || !activeHeadingId) return
    const el = container.querySelector<HTMLElement>(`[data-toc-id="${activeHeadingId}"]`)
    if (!el) return
    const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo({ top: scrollTarget, behavior: "smooth" })
  }, [activeHeadingId])

  const handleClick = React.useCallback((id: string) => {
    const container = containerRef.current
    if (container) {
      const el = container.querySelector<HTMLElement>(`[data-toc-id="${id}"]`)
      if (el) {
        const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
        container.scrollTo({ top: scrollTarget, behavior: "smooth" })
      }
    }
    clickLockRef.current = true
    onTocClick(id)
    setTimeout(() => { clickLockRef.current = false }, 900)
  }, [onTocClick])

  // Portal renders in <body>, so position:fixed is correctly relative to the real viewport.
  // rightOffset anchors the TOC to the editor card's right inner edge.
  return createPortal(
    <nav
      className="ftoc"
      ref={containerRef}
      aria-label="目录"
      style={{ right: rightOffset, top: topOffset }}
    >
      {navToc.map((item) => {
        const active = activeHeadingId === item.id
        const w = active ? (LINE_W_ACTIVE[item.level] ?? 18) : (LINE_W[item.level] ?? 10)
        return (
          <div
            key={item.id}
            data-toc-id={item.id}
            data-level={item.level}
            className={cn("ftoc-item", active && "is-active")}
            onClick={() => handleClick(item.id)}
          >
            <span className="ftoc-text">{item.text}</span>
            <span className="ftoc-line" style={{ width: w }} />
          </div>
        )
      })}
    </nav>,
    document.body
  )
}

/* ─── Back to top ────────────────────────────────────────── */

function BackToTopButton() {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // portal so position:fixed is relative to viewport, not SidebarInset (overflow:hidden)
  return createPortal(
    <button
      aria-label="返回顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={cn(
        "fixed bottom-6 right-6 z-50 size-9 flex items-center justify-center",
        "rounded-full border bg-background/80 backdrop-blur-sm shadow-md",
        "transition-[opacity,transform,background-color,box-shadow] duration-300 hover:bg-background hover:shadow-lg",
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-3 pointer-events-none"
      )}
    >
      <ChevronUp className="size-4" />
    </button>,
    document.body
  )
}
