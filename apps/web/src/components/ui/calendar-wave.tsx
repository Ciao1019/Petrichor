import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"

import { cn } from "@/lib/utils"

import {
  calculateWaveLift,
  CELL_GAP,
  CELL_SIZE,
  CELL_STEP,
  type CalendarCell,
  daysInMonth,
  DOW,
  MAX_LIFT,
  MONTHS,
  parseDateKey,
  playCalendarWaveTick,
  startOffset,
  toDateKey,
} from "./calendar-wave.shared"

export interface CalendarWaveProps {
  value?: string
  onChange?: (date: string) => void
  sound?: boolean
  className?: string
}

export function CalendarWave({ value, onChange, sound = true, className }: CalendarWaveProps) {
  const today = useMemo(() => new Date(), [])
  const gridRef = useRef<HTMLDivElement>(null)

  const [month, setMonth] = useState(() => (value ? Number(value.slice(5, 7)) - 1 : today.getMonth()))
  const [year, setYear] = useState(() => (value ? Number(value.slice(0, 4)) : today.getFullYear()))
  const [selected, setSelected] = useState<string | null>(value ?? null)
  const [mouse, setMouse] = useState({ x: -9999, y: -9999 })
  const [hovering, setHovering] = useState(false)
  const [direction, setDirection] = useState(0)

  useEffect(() => {
    if (!value) {
      setSelected(null)
      return
    }
    const parsed = parseDateKey(value)
    if (!parsed) return
    setSelected(value)
    setYear(parsed.year)
    setMonth(parsed.month)
  }, [value])

  const todayKey = toDateKey(today.getFullYear(), today.getMonth(), today.getDate())
  const totalDays = daysInMonth(year, month)
  const offset = startOffset(year, month)

  const cells = useMemo<CalendarCell[]>(() => {
    const result: CalendarCell[] = []
    let index = 0
    for (let i = 0; i < offset; i++) {
      result.push({ day: null, col: index % 7, row: Math.floor(index / 7) })
      index++
    }
    for (let day = 1; day <= totalDays; day++) {
      result.push({ day, col: index % 7, row: Math.floor(index / 7) })
      index++
    }
    return result
  }, [offset, totalDays])

  const tick = useCallback(() => {
    if (!sound) return
    playCalendarWaveTick()
  }, [sound])

  const handleMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    setMouse({ x: event.clientX - rect.left, y: event.clientY - rect.top })
  }, [])

  const navigate = useCallback(
    (delta: number) => {
      tick()
      setDirection(delta)
      let nextMonth = month + delta
      let nextYear = year
      if (nextMonth < 0) {
        nextMonth = 11
        nextYear--
      } else if (nextMonth > 11) {
        nextMonth = 0
        nextYear++
      }
      setMonth(nextMonth)
      setYear(nextYear)
    },
    [month, tick, year],
  )

  const pickDate = useCallback(
    (day: number) => {
      tick()
      const next = toDateKey(year, month, day)
      setSelected(next)
      onChange?.(next)
    },
    [month, onChange, tick, year],
  )

  const selectedLabel = useMemo(() => {
    if (!selected) return null
    const parsed = parseDateKey(selected)
    if (!parsed) return null
    const date = new Date(parsed.year, parsed.month, parsed.day)
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
      weekday: "long",
    })
  }, [selected])

  return (
    <div
      className={cn("select-none", className)}
      style={{ width: 7 * CELL_STEP - CELL_GAP + 48, padding: "24px 20px" }}
    >
      <div className="mb-5 flex items-center justify-between">
        <motion.button
          type="button"
          onClick={() => navigate(-1)}
          whileTap={{ scale: 0.85 }}
          className="px-2 py-1 text-base text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-600 dark:hover:text-neutral-400"
        >
          ‹
        </motion.button>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={`${year}-${month}`}
            initial={{ y: direction > 0 ? 8 : -8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: direction > 0 ? -8 : 8, opacity: 0 }}
            transition={{ type: "spring", damping: 24, stiffness: 300 }}
            className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
          >
            {MONTHS[month]} {year}
          </motion.span>
        </AnimatePresence>
        <motion.button
          type="button"
          onClick={() => navigate(1)}
          whileTap={{ scale: 0.85 }}
          className="px-2 py-1 text-base text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-600 dark:hover:text-neutral-400"
        >
          ›
        </motion.button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(7, ${CELL_SIZE}px)`, gap: CELL_GAP, marginBottom: 6 }}>
        {DOW.map((day) => (
          <div key={day} className="text-center text-[10px] font-medium uppercase tracking-[0.06em] text-neutral-300 dark:text-neutral-700">
            {day}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${year}-${month}`}
          initial={{ opacity: 0, x: direction > 0 ? 16 : -16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: direction > 0 ? -16 : 16 }}
          transition={{ type: "spring", damping: 26, stiffness: 300 }}
        >
          <div
            ref={gridRef}
            onMouseMove={handleMouseMove}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => {
              setHovering(false)
              setMouse({ x: -9999, y: -9999 })
            }}
            style={{ display: "grid", gridTemplateColumns: `repeat(7, ${CELL_SIZE}px)`, gap: CELL_GAP }}
          >
            {cells.map((cell, index) => {
              if (cell.day === null) return <div key={`empty-${index}`} style={{ width: CELL_SIZE, height: CELL_SIZE }} />
              const key = toDateKey(year, month, cell.day)
              const selectedDay = key === selected
              const isToday = key === todayKey
              const lift = hovering ? calculateWaveLift(mouse.x, mouse.y, cell.col, cell.row) : 0
              const effectiveLift = selectedDay ? MAX_LIFT : lift
              const shadow =
                effectiveLift > 0.5
                  ? `0 ${Math.round(effectiveLift * 1.5)}px ${Math.round(effectiveLift * 3)}px rgba(0,0,0,${(0.03 + effectiveLift * 0.008).toFixed(3)})`
                  : "none"
              return (
                <motion.button
                  key={key}
                  type="button"
                  onClick={() => pickDate(cell.day!)}
                  animate={{ y: -effectiveLift, scale: 1 + effectiveLift * 0.005 }}
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: "spring", damping: 20, stiffness: 300, mass: 0.4 }}
                  className={cn(
                    "relative flex items-center justify-center rounded-[10px] transition-colors duration-150",
                    selectedDay
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-950"
                      : isToday
                        ? "bg-transparent text-neutral-900 dark:text-neutral-100"
                        : lift > 3
                          ? "bg-neutral-50 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                          : lift > 1
                            ? "bg-transparent text-neutral-600 dark:text-neutral-400"
                            : "bg-transparent text-neutral-400 dark:text-neutral-600",
                  )}
                  style={{
                    width: CELL_SIZE,
                    height: CELL_SIZE,
                    boxShadow: shadow,
                    fontWeight: selectedDay || isToday ? 600 : lift > 2 ? 500 : 400,
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1,
                  }}
                >
                  {cell.day}
                  {isToday && !selectedDay ? (
                    <span className="absolute bottom-1 left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-neutral-400 dark:bg-neutral-600" />
                  ) : null}
                </motion.button>
              )
            })}
          </div>
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {selectedLabel ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ type: "spring", damping: 24, stiffness: 300 }}
            className="mt-4 text-center text-xs font-medium tracking-tight text-neutral-500 dark:text-neutral-500"
          >
            {selectedLabel}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default CalendarWave
