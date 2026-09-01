import {
  buildArticleSnapshotKey,
  normalizeArticleTags as normalizeTags,
  type ArticleEditorSnapshot,
} from "@/components/knowledge/article-editor-utils"

export type SaveIntent = "MANUAL" | "AUTO"

export type ArticleDraftRecord = ArticleEditorSnapshot & {
  updatedAt: string
  baseUpdatedAt?: string | null
}

export const AUTO_SAVE_DELAY_MS = 2500
export const LOCAL_DRAFT_DELAY_MS = 800

export function buildCurrentSnapshot(
  title: string,
  contentMd: string,
  contentJson: string,
  contentMetaJson: string,
  tags: string[],
): ArticleEditorSnapshot {
  return { title, contentMd, contentJson, contentMetaJson, tags: normalizeTags(tags) }
}

function getDraftStorageKey(articleId: string) {
  return `kb-article-draft:${articleId}`
}

export function readDraftRecord(articleId: string): ArticleDraftRecord | null {
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
    ) return null
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

export function writeDraftRecord(articleId: string, draft: ArticleDraftRecord) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(getDraftStorageKey(articleId), JSON.stringify(draft))
  } catch {
    // 本地草稿失败不得阻断编辑主链路。
  }
}

export function removeDraftRecord(articleId: string) {
  if (typeof window !== "undefined") window.localStorage.removeItem(getDraftStorageKey(articleId))
}

export function shouldRestoreDraft(draftUpdatedAt: string, articleUpdatedAt?: string | null) {
  const draftTime = Date.parse(draftUpdatedAt)
  const articleTime = articleUpdatedAt ? Date.parse(articleUpdatedAt) : Number.NaN
  return Number.isNaN(draftTime) || Number.isNaN(articleTime) || draftTime > articleTime
}

export function formatSaveTime(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function snapshotsDiffer(left: ArticleEditorSnapshot, right: ArticleEditorSnapshot) {
  return buildArticleSnapshotKey(left) !== buildArticleSnapshotKey(right)
}
