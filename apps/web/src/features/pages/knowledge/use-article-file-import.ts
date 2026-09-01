import * as React from "react"
import { toast } from "sonner"

import {
  buildArticleSnapshotKey,
  isDocxFileName,
  isMarkdownFileName,
  normalizeArticleTags,
  resolveMarkdownImportTitle,
  validateDocxImportFile,
  validateMarkdownImportFile,
  validateMarkdownImportText,
  type ArticleEditorSnapshot,
} from "@/components/knowledge/article-editor-utils"
import type { PlateMarkdownEditorHandle } from "@/components/plate/PlateMarkdownEditor"
import type { ArticleDetailResponse } from "@/lib/api"
import { buildCurrentSnapshot, writeDraftRecord, type ArticleDraftRecord } from "./article-editor-draft-utils"

type ContentState = { markdown: string; contentJson: string; contentMetaJson: string }

interface ArticleFileImportOptions {
  articleId?: string
  readOnly: boolean
  loading: boolean
  saving: boolean
  saveInFlightRef: React.RefObject<boolean>
  editorRef: React.RefObject<PlateMarkdownEditorHandle | null>
  loaded: ArticleDetailResponse | null
  loadedSnapshot: ArticleEditorSnapshot | null
  recoverableDraft: ArticleDraftRecord | null
  title: string
  content: ContentState
  tags: string[]
  onContentChange: (state: ContentState) => void
  onTitleChange: (title: string) => void
  onDraftResolved: () => void
  onError: (message: string | null) => void
}

/** Markdown/DOCX 导入状态机，集中处理覆盖确认、校验、草稿和错误反馈。 */
export function useArticleFileImport(options: ArticleFileImportOptions) {
  const {
    articleId, readOnly, loading, saving, saveInFlightRef, editorRef, loaded,
    loadedSnapshot, recoverableDraft, title, content, tags, onContentChange,
    onTitleChange, onDraftResolved, onError,
  } = options
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [importing, setImporting] = React.useState(false)

  const showError = React.useCallback((message: string) => {
    onError(message)
    toast.error(message)
  }, [onError])

  const syncLatest = React.useCallback(() => {
    const latest = editorRef.current?.getContentState()
    if (latest) onContentChange(latest)
    return latest
  }, [editorRef, onContentChange])

  const hasUnsavedContent = React.useCallback((latest?: ContentState) => {
    if (recoverableDraft) return true
    if (!loadedSnapshot) return false
    const latestSnapshot = buildCurrentSnapshot(
      title,
      latest?.markdown ?? content.markdown,
      latest?.contentJson ?? content.contentJson,
      latest?.contentMetaJson ?? content.contentMetaJson,
      tags,
    )
    return buildArticleSnapshotKey(latestSnapshot) !== buildArticleSnapshotKey(loadedSnapshot)
  }, [content, loadedSnapshot, recoverableDraft, tags, title])

  const triggerImport = React.useCallback(() => {
    if (!readOnly && !loading && !saving && !importing) fileInputRef.current?.click()
  }, [importing, loading, readOnly, saving])

  const handleFileChange = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file) return
    if (readOnly) return showError("只读文章不能导入文件")
    if (loading) return showError("文章仍在加载中，请稍后再导入")
    if (saving || saveInFlightRef.current || importing) return showError("文章正在保存或导入中，请稍后再试")

    const markdownFile = isMarkdownFileName(file.name)
    const docxFile = isDocxFileName(file.name)
    if (!markdownFile && !docxFile) return showError("请选择 .md、.markdown 或 .docx 格式的文件")
    const fileError = docxFile ? validateDocxImportFile(file) : validateMarkdownImportFile(file)
    if (fileError) return showError(fileError)

    let markdown = ""
    if (markdownFile) {
      try {
        markdown = await file.text()
      } catch {
        return showError("读取 Markdown 文件失败，请重新选择文件")
      }
      const textError = validateMarkdownImportText(markdown)
      if (textError) return showError(textError)
    }

    const latest = syncLatest()
    if (hasUnsavedContent(latest) && !window.confirm("当前文章有未保存内容或本地草稿，导入文件会覆盖标题和正文。确定继续导入吗？")) return

    setImporting(true)
    try {
      const imported = docxFile
        ? await editorRef.current?.importDocx(file)
        : editorRef.current?.importMarkdown(markdown)
      if (!imported) return showError("编辑器尚未准备好，请稍后再导入")

      const nextTitle = resolveMarkdownImportTitle(imported.markdown, file.name)
      onTitleChange(nextTitle)
      onContentChange(imported)
      const draftArticleId = loaded?.articleId || articleId
      if (draftArticleId) {
        writeDraftRecord(draftArticleId, {
          title: nextTitle,
          contentMd: imported.markdown,
          contentJson: imported.contentJson,
          contentMetaJson: imported.contentMetaJson,
          tags: normalizeArticleTags(tags),
          updatedAt: new Date().toISOString(),
          baseUpdatedAt: loaded?.updatedAt || null,
        })
      }
      onDraftResolved()
      onError(null)
      if (docxFile) {
        const result = imported as typeof imported & { commentsCount?: number; uploadedImageCount?: number; warnings?: string[] }
        if (result.warnings?.length) console.warn("[DOCX import] 转换警告", result.warnings)
        const images = result.uploadedImageCount ? `，已上传 ${result.uploadedImageCount} 张图片` : ""
        const comments = result.commentsCount ? `；${result.commentsCount} 条批注暂未导入` : ""
        toast.success(`DOCX 已导入${images}${comments}，保存后生效`)
      } else {
        toast.success("Markdown 已导入，保存后生效")
      }
    } catch (error) {
      if (docxFile) console.error("[DOCX import] 导入失败", error)
      showError(docxFile ? "导入 DOCX 失败，请检查文件内容或图片上传配置后重试" : "导入 Markdown 失败，请检查文件内容后重试")
    } finally {
      setImporting(false)
    }
  }, [articleId, editorRef, hasUnsavedContent, importing, loaded, loading, onContentChange, onDraftResolved, onError, onTitleChange, readOnly, saveInFlightRef, saving, showError, syncLatest, tags])

  return { fileInputRef, importing, triggerImport, handleFileChange }
}
