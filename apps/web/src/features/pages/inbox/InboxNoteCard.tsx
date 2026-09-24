import * as React from "react"
import { Link } from "react-router-dom"
import { ArrowUpRight, BookOpen, Check, Globe, MoreHorizontal, PencilLine, Pin, PinOff, Trash2 } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { InboxNote } from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"
import { InboxMarkdown } from "./InboxMarkdown"
import { formatInboxTime } from "./inbox-utils"

interface Props {
  note: InboxNote
  disabled: boolean
  onArchive: (note: InboxNote) => void
  onEdit: (note: InboxNote) => void
  onDelete: (note: InboxNote) => void
  onPin: (note: InboxNote) => void
  onSource?: (id: string) => void
  onTag: (tag: string) => void
}

function QuickAction({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={label} disabled={disabled} onClick={onClick}
          className="size-7 rounded-md text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>{label}</TooltipContent>
    </Tooltip>
  )
}

export function InboxNoteCard({ note, disabled, onArchive, onEdit, onDelete, onPin, onTag, onSource }: Props) {
  const [expanded, setExpanded] = React.useState(false)
  const long = note.contentMd.length > 600 || note.contentMd.split("\n").length > 12
  const archived = Boolean(note.archivedAt)
  const sources = note.sources ?? []
  const hasMeta = note.tags.length > 0 || sources.length > 0 || archived

  return (
    <article
      aria-label={`随笔 ${formatInboxTime(note.createdAt)}`}
      className={cn(
        "group relative rounded-xl border bg-card px-4 pb-3.5 pt-2.5 transition-colors sm:px-5 sm:pb-4",
        note.pinned ? "border-primary/25" : "border-border/50 hover:border-border/90"
      )}
    >
      <header className="flex min-h-8 items-center gap-2.5">
        <time dateTime={note.createdAt} className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
          {formatInboxTime(note.createdAt)}
        </time>
        {note.pinned && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
            <Pin className="size-3" />置顶
          </span>
        )}
        {archived && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-3" />已归档
          </span>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {/* 桌面端悬停或键盘聚焦时露出常用操作；触屏统一走「更多」菜单。 */}
          <div className="hidden items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none sm:flex">
            {!archived && <QuickAction label="编辑" disabled={disabled} onClick={() => onEdit(note)}><PencilLine /></QuickAction>}
            <QuickAction label={note.pinned ? "取消置顶" : "置顶"} disabled={disabled} onClick={() => onPin(note)}>{note.pinned ? <PinOff /> : <Pin />}</QuickAction>
            {!archived && <QuickAction label="归档到知识库" disabled={disabled} onClick={() => onArchive(note)}><BookOpen /></QuickAction>}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label="随笔操作"
                className="size-7 rounded-md text-muted-foreground/70 hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {!archived && <DropdownMenuItem onSelect={() => onEdit(note)}><PencilLine className="size-4" />编辑随笔</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => onPin(note)}>{note.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}{note.pinned ? "取消置顶" : "置顶随笔"}</DropdownMenuItem>
              {!archived && <DropdownMenuItem onSelect={() => onArchive(note)}><BookOpen className="size-4" />归档到知识库</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(note)}><Trash2 className="size-4" />删除随笔</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="mt-1">
        <div className={long && !expanded ? "relative max-h-64 overflow-hidden [mask-image:linear-gradient(black_75%,transparent)]" : ""}>
          <InboxMarkdown content={note.contentMd} contentJson={note.contentJson} contentMetaJson={note.contentMetaJson} />
        </div>
        {long && (
          <button
            type="button"
            aria-expanded={expanded}
            className="mt-1.5 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : "展开全文"}
          </button>
        )}
      </div>

      {hasMeta && (
        <footer className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground">
          {note.tags.map((tag) => (
            <button
              type="button"
              key={tag}
              aria-label={`按标签筛选：${tag}`}
              className="max-w-full truncate rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onTag(tag)}
            >
              #{tag}
            </button>
          ))}
          {sources.map((source) => (
            <button
              type="button"
              key={source.id}
              title={source.url}
              aria-label={`查看网页来源：${source.title || source.url}`}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onSource?.(source.id)}
            >
              <Globe className="size-3 shrink-0" />
              <span className="truncate">{source.title || source.url}</span>
            </button>
          ))}
          {archived && (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 sm:ml-auto">
              <BookOpen className="size-3 shrink-0" />
              <span className="truncate">归档于「{note.knowledgeBaseName ?? "知识库"}」</span>
              {note.articleId && note.knowledgeBaseId && (
                <Link
                  to={knowledgeBaseArticlePath(note.knowledgeBaseId, note.articleId)}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  查看文章<ArrowUpRight className="size-3" />
                </Link>
              )}
            </span>
          )}
        </footer>
      )}
    </article>
  )
}
