"use client"

import * as React from "react"
import { LockKeyhole, Search } from "lucide-react"
import { useNavigate } from "react-router-dom"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { publicArticleShareApi, type PublicArticleSearchItem } from "@/lib/api"
import { cn } from "@/lib/utils"

const SEARCH_DEBOUNCE_MS = 300

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function HighlightedText({ text, keyword }: { text: string; keyword: string }) {
  const trimmedKeyword = keyword.trim()
  if (!trimmedKeyword || !text) return <>{text}</>
  const parts = text.split(new RegExp(`(${escapeRegExp(trimmedKeyword)})`, "gi"))
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === trimmedKeyword.toLowerCase() ? (
          <mark
            key={index}
            className="rounded-sm bg-yellow-300/40 px-[0.1em] text-yellow-700 dark:text-yellow-200"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  )
}

function formatDate(value: string) {
  const [datePart] = value.split("T")
  return datePart || value
}

function resolveSearchError(error: unknown) {
  return (
    (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : "") ||
    "搜索失败"
  )
}

export function BlogSearchDialog({ open, onOpenChange }: Props) {
  const navigate = useNavigate()
  const [input, setInput] = React.useState("")
  const [keyword, setKeyword] = React.useState("")
  const [items, setItems] = React.useState<PublicArticleSearchItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const requestSeqRef = React.useRef(0)
  const abortRef = React.useRef<AbortController | null>(null)

  // 打开时清状态；关闭时取消请求
  React.useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      return
    }
    setInput("")
    setKeyword("")
    setItems([])
    setError(null)
    setLoading(false)
  }, [open])

  // debounce input -> keyword
  React.useEffect(() => {
    const trimmed = input.trim()
    const timer = setTimeout(() => setKeyword(trimmed), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input])

  // keyword 变化触发搜索
  React.useEffect(() => {
    if (!open) return
    if (!keyword) {
      setItems([])
      setLoading(false)
      setError(null)
      return
    }
    const seq = ++requestSeqRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    publicArticleShareApi
      .search({ keyword, signal: controller.signal })
      .then((res) => {
        if (seq !== requestSeqRef.current) return
        setItems(res.data.items ?? [])
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (seq !== requestSeqRef.current) return
        setItems([])
        setError(resolveSearchError(err))
      })
      .finally(() => {
        if (seq !== requestSeqRef.current) return
        setLoading(false)
      })
    return () => controller.abort()
  }, [keyword, open])

  const handleSelect = (item: PublicArticleSearchItem) => {
    onOpenChange(false)
    if (item.href) navigate(item.href)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>搜索文章</DialogTitle>
          <DialogDescription>在公开文章中搜索标题、摘要与正文。</DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput
            value={input}
            onValueChange={setInput}
            placeholder="搜索文章标题、摘要、正文…"
            className="text-base"
          />
          <CommandList className="max-h-[60vh]">
            {!keyword ? (
              <div className="text-muted-foreground px-6 py-10 text-center text-sm">
                <Search className="mx-auto mb-2 size-6 opacity-40" aria-hidden="true" />
                输入关键字开始搜索（至少 1 个字符）。
              </div>
            ) : error ? (
              <div className="text-destructive px-6 py-10 text-center text-sm">
                {error}
              </div>
            ) : loading && items.length === 0 ? (
              <div className="text-muted-foreground px-6 py-10 text-center text-sm">
                搜索中…
              </div>
            ) : items.length === 0 ? (
              <CommandEmpty>没有命中的文章。</CommandEmpty>
            ) : (
              <CommandGroup heading={`「${keyword}」共 ${items.length} 条结果`}>
                {items.map((item) => (
                  <CommandItem
                    key={item.shareCode}
                    value={item.shareCode}
                    onSelect={() => handleSelect(item)}
                    className={cn(
                      "flex cursor-pointer flex-col items-stretch gap-1 rounded-md",
                      item.expired || item.hasPassword ? "opacity-80" : "",
                    )}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-foreground min-w-0 flex-1 break-words text-sm font-semibold leading-snug">
                        <HighlightedText text={item.title} keyword={keyword} />
                        {item.isRepost ? (
                          <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 align-middle text-[0.65rem]">
                            转载
                          </span>
                        ) : null}
                        {item.expired ? (
                          <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 align-middle text-[0.65rem]">
                            已过期
                          </span>
                        ) : null}
                        {item.hasPassword ? (
                          <span className="ml-2 inline-flex items-center align-middle text-[0.65rem]">
                            <LockKeyhole className="!size-3" aria-hidden="true" />
                          </span>
                        ) : null}
                      </span>
                      <span className="text-muted-foreground shrink-0 font-mono text-xs">
                        {formatDate(item.updatedAt)} · {item.readingMinutes} min
                      </span>
                    </div>
                    {item.excerpt ? (
                      <p className="text-muted-foreground line-clamp-2 break-words text-xs leading-5">
                        <HighlightedText text={item.excerpt} keyword={keyword} />
                      </p>
                    ) : null}
                    {item.tags.length ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {item.tags.map((tag) => (
                          <li
                            key={tag}
                            className="border-muted text-muted-foreground rounded border px-1.5 py-0.5 text-[0.65rem]"
                          >
                            {tag}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <CommandSeparator />
          <div className="text-muted-foreground flex items-center gap-3 px-4 py-3 text-xs">
            <span className="flex items-center gap-1">
              <kbd className="rounded border px-1 text-xs">↑↓</kbd>
              选择
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border px-1 text-xs">↵</kbd>
              打开
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border px-1 text-xs">esc</kbd>
              关闭
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

/** 全局 ⌘K / Ctrl+K 快捷键 hook：调用方负责打开 dialog。 */
export function useBlogSearchHotkey(onOpen: () => void) {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpen()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onOpen])
}
