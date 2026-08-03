"use client"

import { useMemo, useState } from "react"
import type { ReactNode } from "react"

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import type { DateRange } from "react-day-picker"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

import {
  atMidnight,
  buildMonthGrid,
  cursorOf,
  describeBounds,
  fromDayKey,
  isSameDay,
  isWithin,
  playClickTone,
  resolveBounds,
  stepMonth,
  toDayKey,
  WEEKDAY_LABELS,
  type DayKey,
  type MonthCursor,
  type RangeBounds,
} from "./date-range-calendar.utils"

/** 翻月动画的水平位移。 */
const SLIDE_PX = 12

export type DateRangeCalendarProps = {
  value?: DateRange
  onChange?: (value: DateRange | undefined) => void
  /** 同时展示几个月，默认桌面 2 个、移动端 1 个。 */
  numberOfMonths?: number
  className?: string
  /** 是否在点击时发出提示音，默认开启。 */
  sound?: boolean
  /** 是否展示底部的区间摘要，默认展示。 */
  showRangeLabel?: boolean
}

/**
 * 日期区间选择器。
 *
 * 交互按「点起点 → 移动预览 → 点终点」三拍走：只选了起点时，鼠标划过哪天就把哪天
 * 当作临时终点渲染；第二次点击才落定，并自动把先后顺序摆正，所以倒着选也没问题。
 */
export function DateRangeCalendar({
  value,
  onChange,
  numberOfMonths,
  className,
  sound = true,
  showRangeLabel = true,
}: DateRangeCalendarProps) {
  const isMobile = useIsMobile()
  const visibleMonths = numberOfMonths ?? (isMobile ? 1 : 2)

  const [cursor, setCursor] = useState<MonthCursor>(() => cursorOf(value?.from ? atMidnight(value.from) : new Date()))
  const [hoverKey, setHoverKey] = useState<DayKey | null>(null)
  const [slideDirection, setSlideDirection] = useState(1)

  const todayKey = useMemo(() => toDayKey(new Date()), [])
  const bounds = useMemo(() => resolveBounds(value, hoverKey), [value, hoverKey])
  const cursors = useMemo(
    () => Array.from({ length: Math.max(1, visibleMonths) }, (_, offset) => stepMonth(cursor, offset)),
    [cursor, visibleMonths]
  )

  const isComplete = Boolean(value?.from && value?.to)
  const summary = showRangeLabel ? describeBounds(bounds, isComplete) : null
  const yearLabel = buildYearLabel(cursors)

  const goToMonth = (delta: number) => {
    playClickTone(sound)
    setSlideDirection(delta)
    setCursor((current) => stepMonth(current, delta))
  }

  const pickDay = (key: DayKey) => {
    playClickTone(sound)
    setHoverKey(null)

    const picked = fromDayKey(key)
    // 没有起点，或上一段区间已经选完 —— 这一下开启新的一段。
    if (!value?.from || value.to) {
      onChange?.({ from: picked, to: undefined })
      return
    }

    const anchor = atMidnight(value.from)
    if (isSameDay(anchor, picked)) {
      onChange?.({ from: anchor, to: picked })
      return
    }
    onChange?.(
      anchor.getTime() <= picked.getTime() ? { from: anchor, to: picked } : { from: picked, to: anchor }
    )
  }

  return (
    <div
      className={cn(
        "w-fit max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border bg-card text-card-foreground",
        className
      )}
    >
      <div className="flex items-center justify-between gap-4 px-4 pt-4">
        <NavButton label="上一个月" onClick={() => goToMonth(-1)}>
          <ChevronLeftIcon className="size-4" />
        </NavButton>
        <span className="font-semibold text-[15px]">{yearLabel}</span>
        <NavButton label="下一个月" onClick={() => goToMonth(1)}>
          <ChevronRightIcon className="size-4" />
        </NavButton>
      </div>

      <div className="px-4 py-3">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={`${cursor.year}-${cursor.month}`}
            initial={{ opacity: 0, x: slideDirection * SLIDE_PX }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: slideDirection * -SLIDE_PX }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="flex gap-6"
          >
            {cursors.map((monthCursor) => (
              <MonthPanel
                key={`${monthCursor.year}-${monthCursor.month}`}
                cursor={monthCursor}
                bounds={bounds}
                todayKey={todayKey}
                onHover={setHoverKey}
                onPick={pickDay}
              />
            ))}
          </motion.div>
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {summary ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className={cn(
              "overflow-hidden border-t px-6 py-3 text-center text-xs",
              isComplete ? "text-muted-foreground" : "text-muted-foreground/70"
            )}
          >
            {summary}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

type MonthPanelProps = {
  cursor: MonthCursor
  bounds: RangeBounds
  todayKey: DayKey
  onHover: (key: DayKey | null) => void
  onPick: (key: DayKey) => void
}

function MonthPanel({ cursor, bounds, todayKey, onHover, onPick }: MonthPanelProps) {
  const grid = useMemo(() => buildMonthGrid(cursor), [cursor])

  return (
    <div>
      <div className="mb-2 text-center font-semibold text-[13px]">{grid.caption}</div>

      <div className="mb-1 grid grid-cols-7">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="text-center text-[11px] text-muted-foreground">
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {Array.from({ length: grid.leading }, (_, index) => (
          <div key={`lead-${index}`} className="size-9" />
        ))}

        {grid.days.map(({ key, day, column }) => {
          const selected = isWithin(key, bounds)
          const isStart = bounds.start === key
          const isEnd = bounds.end === key
          const isEdge = isStart || isEnd
          const isToday = key === todayKey

          return (
            <button
              key={key}
              type="button"
              onClick={() => onPick(key)}
              onMouseEnter={() => onHover(key)}
              onMouseLeave={() => onHover(null)}
              aria-pressed={selected}
              className={cn(
                "relative flex size-9 items-center justify-center transition-colors",
                // 区间底色：分别在区间两端和每一行的首尾收圆角，跨行时才不会缺口。
                selected && "bg-accent",
                selected && (isStart || column === 0) && "rounded-l-full",
                selected && (isEnd || column === 6) && "rounded-r-full"
              )}
            >
              <span
                className={cn(
                  "flex size-8 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors",
                  isEdge
                    ? "bg-primary font-semibold text-primary-foreground"
                    : selected
                      ? "text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  !isEdge && isToday && "font-semibold text-foreground ring-1 ring-primary/40 ring-inset"
                )}
              >
                {day}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function NavButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.88 }}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </motion.button>
  )
}

function buildYearLabel(cursors: MonthCursor[]): string {
  const first = cursors[0]
  const last = cursors[cursors.length - 1]
  return first.year === last.year ? `${first.year} 年` : `${first.year} - ${last.year} 年`
}

export default DateRangeCalendar
