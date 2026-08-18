"use client"

import * as React from "react"
import { ChevronDownIcon, SearchIcon } from "@/components/iconimate"

import WheelList, { type WheelState } from "@/components/lab/inertial-wheel-list"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type WheelSelectItem = {
  value: string
  /** 滚筒上显示的主文案 */
  label: string
  /** 次要信息（供应商名 / 掩码 Key / 维度…）。滚筒只放一行，hint 显示在轮下方并参与搜索。 */
  hint?: string
}

/**
 * 滚筒选择器：触发器沿用 SelectTrigger 的外观，展开后是 inertial-wheel-list 的 iOS 滚筒 + 搜索框。
 *
 * 为什么不直接内联滚筒：滚筒本体 200px 高，模型配置的表单里一个弹窗最多有 4 个选择项，
 * 内联会把表单撑到几屏。这里保留原来的行高，把滚筒放进 Popover。
 *
 * 取值的两条路径（滚筒把 selection 定义为滚动位置，所以两条都要接）：
 * - 甩动/键盘：onStateChange 在 snap 落定（settled）时提交，弹层不关，可以继续拨；
 * - 点某一行：捕获 click 里按 role="option" 的下标直接提交并关闭 —— 点的正好是当前居中项时
 *   不会产生滚动，光靠 settled 收不到事件。
 */
export function WheelSelect({
  value,
  onValueChange,
  items,
  placeholder = "请选择",
  label = placeholder,
  disabled,
  size = "default",
  /** 条目多到滚筒里翻不动时才给搜索框；默认 8 条以上自动开启 */
  searchable,
  emptyText = "没有匹配项",
  className,
  contentClassName,
}: {
  value: string
  onValueChange: (value: string) => void
  items: WheelSelectItem[]
  placeholder?: string
  label?: string
  disabled?: boolean
  size?: "sm" | "default"
  searchable?: boolean
  emptyText?: string
  className?: string
  contentClassName?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [centered, setCentered] = React.useState<WheelSelectItem | null>(null)
  // 滚筒重挂后停在 index 0，此时的第一次 settled 是「初始态」而不是用户选择，
  // 不能拿它覆盖已有的值 —— 只有用户真的拨过（指针/键盘落在滚筒里）才允许提交。
  const touched = React.useRef(false)

  const selected = items.find((item) => item.value === value) ?? null

  const filtered = React.useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) =>
      `${item.label} ${item.hint ?? ""} ${item.value}`.toLowerCase().includes(keyword),
    )
  }, [items, query])

  const showSearch = searchable ?? items.length > 8
  const labels = React.useMemo(() => filtered.map((item) => item.label), [filtered])
  const initialIndex = Math.max(0, filtered.findIndex((item) => item.value === value))

  // 每次改关键词都换一批 items，滚筒的 initialIndex 只在挂载时生效 → 用 key 重挂，
  // 让它重新落到「当前值在新列表里的位置」。
  const wheelKey = `${query}:${items.length}`

  React.useEffect(() => {
    touched.current = false
  }, [wheelKey])

  React.useEffect(() => {
    if (open) return
    setQuery("")
    setCentered(null)
    touched.current = false
  }, [open])

  const commit = React.useCallback(
    (item: WheelSelectItem | undefined) => {
      if (!item || item.value === value) return
      onValueChange(item.value)
    },
    [onValueChange, value],
  )

  const handleStateChange = React.useCallback(
    (state: WheelState) => {
      const item = filtered[state.index]
      setCentered(item ?? null)
      if (!state.settled || !touched.current) return
      commit(item)
    },
    [commit, filtered],
  )

  const handleWheelClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const option = (event.target as HTMLElement).closest('[role="option"]')
    const list = option?.parentElement
    if (!option || !list) return
    const index = Array.prototype.indexOf.call(list.children, option)
    if (index < 0) return
    commit(filtered[index])
    setOpen(false)
  }

  const hint = (centered ?? selected)?.hint

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="wheel-select-trigger"
          data-size={size}
          data-placeholder={selected ? undefined : ""}
          disabled={disabled}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs outline-none transition-[color,box-shadow]",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "dark:bg-input/30 dark:hover:bg-input/50",
            "data-[size=default]:h-9 data-[size=sm]:h-8",
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {selected ? (
              <>
                <span className="truncate">{selected.label}</span>
                {selected.hint ? (
                  <span className="truncate text-xs text-muted-foreground">{selected.hint}</span>
                ) : null}
              </>
            ) : (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className={cn("w-(--radix-popover-trigger-width) min-w-56 space-y-2 p-2", contentClassName)}
      >
        {showSearch ? (
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索…"
              className="h-8 pl-8 text-sm"
              autoFocus
            />
          </div>
        ) : null}

        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <div
            onClickCapture={handleWheelClickCapture}
            onPointerDownCapture={() => {
              touched.current = true
            }}
            onKeyDownCapture={() => {
              touched.current = true
            }}
            // 滚筒根节点自带 max-w:14rem，这里放开让它撑满触发器宽度
            className="[&>div]:max-w-none"
          >
            <WheelList
              key={wheelKey}
              items={labels}
              label={label}
              initialIndex={initialIndex}
              onStateChange={handleStateChange}
            />
          </div>
        )}

        {filtered.length > 0 ? (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {hint ?? `${filtered.length} 项`}
            </span>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setOpen(false)}>
              完成
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
