'use client'

import { motion } from 'motion/react'

import { cn } from '@/lib/utils'

import {
  CELL,
  CORNER_RADIUS,
  type EffectiveRange,
  inRange,
  type MonthCursor,
  toKey,
  WEEK_DAYS
} from './calendar-04.shared'

type MonthPanelProps = {
  cursor: MonthCursor
  range: EffectiveRange
  todayKey: string
  hoverKey: string | null
  onHover: (key: string | null) => void
  onPick: (key: string) => void
}

export function MonthPanel({ cursor, range, todayKey, hoverKey, onHover, onPick }: MonthPanelProps) {
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate()
  const firstOffset = (new Date(cursor.year, cursor.month, 1).getDay() + 6) % 7
  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString('zh-CN', { month: 'long' })

  return (
    <div>
      <div className="mb-2 text-center text-[13px] font-semibold text-neutral-700 dark:text-neutral-300">
        {cursor.year} 年 {monthLabel}
      </div>
      <div className="mb-1 grid" style={{ gridTemplateColumns: `repeat(7, ${CELL}px)` }}>
        {WEEK_DAYS.map((day) => (
          <div key={day} className="text-center text-[11px] text-neutral-400 dark:text-neutral-600">
            {day}
          </div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(7, ${CELL}px)` }}>
        {Array.from({ length: firstOffset }).map((_, index) => (
          <div key={`empty-${index}`} style={{ width: CELL, height: CELL }} />
        ))}
        {Array.from({ length: daysInMonth }).map((_, index) => {
          const day = index + 1
          const dateKey = toKey(cursor.year, cursor.month, day)
          const column = (firstOffset + day - 1) % 7
          const selected = inRange(dateKey, range)
          const isStart = range.start === dateKey
          const isEnd = range.end === dateKey
          const isSingle = isStart && isEnd
          const hasPrev = column > 0 && day > 1 && inRange(toKey(cursor.year, cursor.month, day - 1), range)
          const hasNext = column < 6 && day < daysInMonth && inRange(toKey(cursor.year, cursor.month, day + 1), range)
          const radius = buildRadius(selected, hasPrev, hasNext, isSingle)
          const isToday = dateKey === todayKey
          const textClass = getTextClass({ isStart, isEnd, selected, isToday })
          const showHover = dateKey === hoverKey && !selected

          return (
            <motion.button
              key={dateKey}
              whileTap={{ scale: 0.9 }}
              onClick={() => onPick(dateKey)}
              onMouseEnter={() => onHover(dateKey)}
              onMouseLeave={() => onHover(null)}
              className={cn(
                'border-none p-0 transition-colors duration-100',
                selected
                  ? isStart || isEnd
                    ? 'bg-neutral-900 dark:bg-neutral-100'
                    : 'bg-neutral-100 dark:bg-neutral-800'
                  : 'hover:rounded-[10px] hover:bg-neutral-100 dark:hover:bg-neutral-800'
              )}
              style={{ width: CELL, height: CELL, borderRadius: selected ? radius : undefined }}
            >
              <span
                className={cn('text-[13px] tabular-nums', showHover ? 'text-neutral-600 dark:text-neutral-400' : textClass)}
                style={{ fontWeight: isStart || isEnd || isToday ? 650 : selected ? 500 : 400 }}
              >
                {day}
              </span>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

function buildRadius(selected: boolean, hasPrev: boolean, hasNext: boolean, isSingle: boolean): string {
  if (isSingle) return CORNER_RADIUS
  const left = selected && !hasPrev ? CORNER_RADIUS : '0'
  const right = selected && !hasNext ? CORNER_RADIUS : '0'
  return `${left} ${right} ${right} ${left}`
}

function getTextClass(params: {
  isStart: boolean
  isEnd: boolean
  selected: boolean
  isToday: boolean
}): string {
  const { isStart, isEnd, selected, isToday } = params
  if (isStart || isEnd) return 'text-white dark:text-neutral-950'
  if (selected) return 'text-neutral-700 dark:text-neutral-300'
  if (isToday) return 'text-neutral-900 dark:text-neutral-100'
  return 'text-neutral-400 dark:text-neutral-500'
}
