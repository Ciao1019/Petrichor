'use client'

import { useMemo, useRef, useState } from 'react'

import { AnimatePresence, motion } from 'motion/react'
import type { DateRange } from 'react-day-picker'

import { cn } from '@/lib/utils'

import { MonthPanel } from './calendar-04-month-panel'
import {
  dateToKey,
  daysBetween,
  getEffectiveRange,
  isSameDate,
  keyToDate,
  MONTH_CHANGE_SHIFT,
  normalizeDay,
  playTick,
  shiftMonth,
  toLocalDateLabel,
  type MonthCursor
} from './calendar-04.shared'

export type Calendar04Props = {
  value?: DateRange
  onChange?: (value: DateRange | undefined) => void
  numberOfMonths?: number
  className?: string
  sound?: boolean
  showRangeLabel?: boolean
}

export function Calendar04({
  value,
  onChange,
  numberOfMonths = 2,
  className,
  sound = true,
  showRangeLabel = true
}: Calendar04Props) {
  const [baseCursor, setBaseCursor] = useState<MonthCursor>(() => {
    const from = value?.from ? normalizeDay(value.from) : new Date()
    return { year: from.getFullYear(), month: from.getMonth() }
  })
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [direction, setDirection] = useState(1)
  const lastTickRef = useRef(0)
  const todayKey = useMemo(() => dateToKey(new Date()), [])
  const effectiveRange = useMemo(() => getEffectiveRange(value, hoverKey), [hoverKey, value])
  const secondCursor = useMemo(() => shiftMonth(baseCursor, 1), [baseCursor])
  const isConfirmed = Boolean(value?.from && value?.to)
  const rangeLabel = useMemo(() => buildRangeLabel(effectiveRange, isConfirmed), [effectiveRange, isConfirmed])

  const handlePick = (key: string) => {
    playTick(lastTickRef, sound)
    setHoverKey(null)
    const picked = keyToDate(key)
    if (!value?.from || value.to) {
      onChange?.({ from: picked, to: undefined })
      return
    }
    const start = normalizeDay(value.from)
    const end = normalizeDay(picked)
    if (isSameDate(start, end)) {
      onChange?.({ from: start, to: end })
      return
    }
    onChange?.(start.getTime() <= end.getTime() ? { from: start, to: end } : { from: end, to: start })
  }

  const handleNavigate = (delta: number) => {
    playTick(lastTickRef, sound)
    setDirection(delta)
    setBaseCursor((prev) => shiftMonth(prev, delta))
  }

  return (
    <div className={cn('w-fit overflow-hidden rounded-[20px] border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950', className)}>
      <div className="flex items-center justify-between px-6 py-4">
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={() => handleNavigate(-1)}
          className="rounded-md px-2 py-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          ‹
        </motion.button>
        <div className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
          {baseCursor.year}
        </div>
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={() => handleNavigate(1)}
          className="rounded-md px-2 py-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          ›
        </motion.button>
      </div>

      <div className="px-6 pb-4">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={`${baseCursor.year}-${baseCursor.month}`}
            initial={{ opacity: 0, x: direction > 0 ? MONTH_CHANGE_SHIFT : -MONTH_CHANGE_SHIFT }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction > 0 ? -MONTH_CHANGE_SHIFT : MONTH_CHANGE_SHIFT }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="flex gap-6"
          >
            <MonthPanel cursor={baseCursor} range={effectiveRange} todayKey={todayKey} hoverKey={hoverKey} onHover={setHoverKey} onPick={handlePick} />
            {numberOfMonths > 1 ? (
              <MonthPanel cursor={secondCursor} range={effectiveRange} todayKey={todayKey} hoverKey={hoverKey} onHover={setHoverKey} onPick={handlePick} />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showRangeLabel && rangeLabel ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className={cn(
              'overflow-hidden border-t px-6 py-3 text-center text-xs',
              isConfirmed
                ? 'border-neutral-200 text-neutral-500 dark:border-neutral-800/60 dark:text-neutral-500'
                : 'border-neutral-200 text-neutral-400 dark:border-neutral-800/60 dark:text-neutral-600'
            )}
          >
            {rangeLabel}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function buildRangeLabel(
  range: { start: string | null; end: string | null },
  isConfirmed: boolean
): string | null {
  if (!range.start) return null
  if (range.end && range.end !== range.start) {
    const count = daysBetween(range.start, range.end)
    return `${toLocalDateLabel(keyToDate(range.start))} - ${toLocalDateLabel(keyToDate(range.end))} · ${count} 天`
  }
  const single = toLocalDateLabel(keyToDate(range.start))
  return isConfirmed ? single : `${single} - 请选择结束日期`
}

export default Calendar04
