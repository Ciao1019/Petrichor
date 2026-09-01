import {
  CheckCircle2,
  FileText,
  Loader2,
  X
} from "@/components/iconimate"
import * as React from "react"

import { Input } from "@/components/ui/input"
import { NativeNestedList } from "@/components/uitripled/native-nested-list-shadcnui"
import { gsap } from "@/lib/gsap"
import { cn } from "@/lib/utils"
import {
  ARTICLE_BATCH_STATUS_LABEL,
  collectSelectedFolderPath,
  toCreateArticleFolderItems,
  type ArticleBatchItem,
  type FolderTreeNode,
} from "./knowledge-base-tree-support"


export function CreateArticleFolderTree({
  roots,
  selectedFolderId,
  disabled,
  onSelectFolder,
}: {
  roots: FolderTreeNode[]
  selectedFolderId: string | null
  disabled?: boolean
  onSelectFolder: (folder: { id: string; name: string } | null) => void
}) {
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(
    () => collectSelectedFolderPath(roots, selectedFolderId)
  )

  // 选择变化时把这条路径补进展开集合，保证选中的文件夹始终可见。
  React.useEffect(() => {
    const path = collectSelectedFolderPath(roots, selectedFolderId)
    if (path.size === 0) return
    setExpandedIds((current) => {
      let changed = false
      const next = new Set(current)
      for (const id of path) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [roots, selectedFolderId])

  const handleExpandedChange = React.useCallback((id: string, nextExpanded: boolean) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (nextExpanded) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const items = React.useMemo(
    () => toCreateArticleFolderItems(roots, expandedIds, selectedFolderId, disabled, onSelectFolder),
    [roots, expandedIds, selectedFolderId, disabled, onSelectFolder]
  )

  if (!roots.length) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        暂无文件夹，可选择根目录创建。
      </div>
    )
  }

  return (
    <NativeNestedList
      items={items}
      activeId={selectedFolderId ?? undefined}
      expandedIds={expandedIds}
      onExpandedChange={handleExpandedChange}
    />
  )
}


export function ArticleBatchItemRow({
  item,
  busy,
  onTitleChange,
  onRemove,
}: {
  item: ArticleBatchItem
  busy: boolean
  onTitleChange: (title: string) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {item.status === "done" ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          ) : item.status === "creating" ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm">{item.fileName}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "text-xs",
              item.status === "failed" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {ARTICLE_BATCH_STATUS_LABEL[item.status]}
          </span>
          {!busy && item.status !== "done" ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`移除 ${item.fileName}`}
              onClick={onRemove}
            >
              <X className="size-4" />
            </button>
          ) : null}
        </span>
      </div>

      {item.status !== "done" ? (
        <Input
          value={item.title}
          disabled={busy}
          placeholder="文章标题"
          maxLength={200}
          className="mt-2 h-8"
          onChange={(e) => onTitleChange(e.target.value)}
        />
      ) : null}

      {item.status === "failed" && item.error ? (
        <p className="mt-1.5 text-xs text-destructive">{item.error}</p>
      ) : null}
    </div>
  )
}

export function ImportProgressFill({ progress, error }: { progress: number; error: boolean }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const mountedRef = React.useRef(false)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!mountedRef.current) {
      mountedRef.current = true
      gsap.set(el, { width: `${progress}%` })
      return
    }
    const tween = gsap.to(el, {
      width: `${progress}%`,
      duration: 0.3,
      ease: "power2.out",
      overwrite: "auto",
    })
    return () => {
      tween.kill()
    }
  }, [progress])
  return (
    <div
      ref={ref}
      className={cn(
        "h-full rounded-full will-change-[width]",
        error ? "bg-destructive" : "bg-primary"
      )}
    />
  )
}
