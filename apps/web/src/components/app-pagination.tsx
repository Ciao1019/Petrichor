"use client"

import * as React from "react"
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from "@/components/ui/pagination"

export interface AppPaginationProps {
  /** 0-based page index */
  page: number
  totalPages: number
  /** Total record count; if provided, shows "共 N 条" */
  total?: number
  /** Records per page; used with total to show "第 X–Y 条" */
  pageSize?: number
  disabled?: boolean
  onChange: (page: number) => void
  className?: string
  /** Show jump-to-page input. Defaults to true when totalPages > 5 */
  showJump?: boolean
}

function buildPageGroups(current: number, total: number): (number | "…")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i)
  }
  const pages: (number | "…")[] = []
  const left = Math.max(1, current - 1)
  const right = Math.min(total - 2, current + 1)

  pages.push(0)
  if (left > 1) pages.push("…")
  for (let i = left; i <= right; i++) pages.push(i)
  if (right < total - 2) pages.push("…")
  pages.push(total - 1)

  return pages
}

export function AppPagination({
  page,
  totalPages,
  total,
  pageSize,
  disabled = false,
  onChange,
  className,
  showJump,
}: AppPaginationProps) {
  const safeTotalPages = Math.max(1, totalPages)
  const safePage = Math.min(Math.max(0, page), safeTotalPages - 1)

  const [jumpValue, setJumpValue] = React.useState("")

  const go = React.useCallback(
    (next: number) => {
      if (disabled) return
      const clamped = Math.min(Math.max(0, next), safeTotalPages - 1)
      if (clamped !== safePage) onChange(clamped)
    },
    [disabled, onChange, safePage, safeTotalPages],
  )

  const handleJump = React.useCallback(() => {
    const num = Number.parseInt(jumpValue, 10)
    if (!Number.isNaN(num)) go(num - 1)
    setJumpValue("")
  }, [go, jumpValue])

  const shouldShowJump = showJump ?? safeTotalPages > 5
  const pageGroups = buildPageGroups(safePage, safeTotalPages)

  // "第 X–Y 条，共 Z 条"
  const recordInfo = React.useMemo(() => {
    if (total === undefined) return null
    if (pageSize !== undefined && pageSize > 0) {
      const from = safePage * pageSize + 1
      const to = Math.min((safePage + 1) * pageSize, total)
      return `第 ${from}–${to} 条，共 ${total} 条`
    }
    return `共 ${total} 条`
  }, [total, pageSize, safePage])

  return (
    <div className={cn("flex flex-col items-center gap-3 sm:flex-row sm:justify-between", className)}>
      {/* 记录信息 */}
      <p className="min-w-0 shrink-0 text-sm text-muted-foreground tabular-nums">
        {recordInfo ?? `第 ${safePage + 1} 页，共 ${safeTotalPages} 页`}
      </p>

      {/* 分页控件 */}
      <div className="flex items-center gap-2">
        <Pagination className="mx-0 w-auto">
          <PaginationContent className="gap-0.5">
            {/* 首页 */}
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled || safePage === 0}
                onClick={() => go(0)}
                aria-label="第一页"
              >
                <ChevronFirst className="size-4" />
              </Button>
            </PaginationItem>

            {/* 上一页 */}
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled || safePage === 0}
                onClick={() => go(safePage - 1)}
                aria-label="上一页"
              >
                <ChevronLeft className="size-4" />
              </Button>
            </PaginationItem>

            {/* 页码 */}
            {pageGroups.map((item, idx) =>
              item === "…" ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis className="h-8 w-8" />
                </PaginationItem>
              ) : (
                <PaginationItem key={item}>
                  <PaginationLink
                    className={cn(
                      "h-8 w-8 cursor-pointer select-none rounded-md text-sm transition-colors",
                      disabled && "pointer-events-none opacity-50",
                    )}
                    isActive={item === safePage}
                    onClick={() => go(item)}
                  >
                    {item + 1}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}

            {/* 下一页 */}
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled || safePage >= safeTotalPages - 1}
                onClick={() => go(safePage + 1)}
                aria-label="下一页"
              >
                <ChevronRight className="size-4" />
              </Button>
            </PaginationItem>

            {/* 末页 */}
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled || safePage >= safeTotalPages - 1}
                onClick={() => go(safeTotalPages - 1)}
                aria-label="最后一页"
              >
                <ChevronLast className="size-4" />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>

        {/* 跳页 */}
        {shouldShowJump && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="shrink-0">跳至</span>
            <Input
              className="h-8 w-14 px-2 text-center tabular-nums"
              type="number"
              min={1}
              max={safeTotalPages}
              value={jumpValue}
              disabled={disabled}
              placeholder={String(safePage + 1)}
              onChange={(e) => setJumpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleJump()
              }}
              onBlur={handleJump}
            />
            <span className="shrink-0">页</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default AppPagination
