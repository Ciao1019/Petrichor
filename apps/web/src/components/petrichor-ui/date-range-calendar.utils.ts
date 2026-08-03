import type { DateRange } from "react-day-picker"

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** 连续点击时的最小发声间隔，避免快速拖动选择时糊成一片。 */
const MIN_TONE_INTERVAL_MS = 90

/** 周一起始的表头。 */
export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const

/** `YYYY-MM-DD` 形式的本地日期键，可直接按字典序比较大小。 */
export type DayKey = string

export type MonthCursor = {
  year: number
  /** 0 - 11，与 `Date#getMonth` 一致。 */
  month: number
}

export type RangeBounds = {
  start: DayKey | null
  end: DayKey | null
}

export type MonthGrid = {
  caption: string
  /** 1 号之前需要留出的空格数（周一起始）。 */
  leading: number
  days: Array<{ key: DayKey; day: number; column: number }>
}

export function atMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function toDayKey(date: Date): DayKey {
  return composeDayKey(date.getFullYear(), date.getMonth(), date.getDate())
}

export function fromDayKey(key: DayKey): Date {
  const [year, month, day] = key.split("-").map(Number)
  return new Date(year, month - 1, day)
}

export function cursorOf(date: Date): MonthCursor {
  return { year: date.getFullYear(), month: date.getMonth() }
}

export function stepMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const absolute = cursor.year * 12 + cursor.month + delta
  return { year: Math.floor(absolute / 12), month: ((absolute % 12) + 12) % 12 }
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 预先算好一个月的全部格子，渲染层只负责套样式。 */
export function buildMonthGrid(cursor: MonthCursor): MonthGrid {
  const firstOfMonth = new Date(cursor.year, cursor.month, 1)
  // getDay() 以周日为 0，这里平移成周一为 0。
  const leading = (firstOfMonth.getDay() + 6) % 7
  const dayCount = new Date(cursor.year, cursor.month + 1, 0).getDate()

  const days = Array.from({ length: dayCount }, (_, index) => {
    const day = index + 1
    return {
      key: composeDayKey(cursor.year, cursor.month, day),
      day,
      column: (leading + index) % 7,
    }
  })

  return {
    caption: `${cursor.year} 年 ${firstOfMonth.toLocaleDateString("zh-CN", { month: "long" })}`,
    leading,
    days,
  }
}

/**
 * 把「已选区间 + 当前悬停日」折算成一段实际要高亮的边界。
 * 只选了起点时，悬停日充当临时终点，于是拖动过程中也能看到区间预览。
 */
export function resolveBounds(range: DateRange | undefined, hoverKey: DayKey | null): RangeBounds {
  if (!range?.from) return { start: null, end: null }

  const anchor = toDayKey(range.from)
  const counterpart = range.to ? toDayKey(range.to) : hoverKey
  if (!counterpart) return { start: anchor, end: null }

  return anchor <= counterpart ? { start: anchor, end: counterpart } : { start: counterpart, end: anchor }
}

export function isWithin(key: DayKey, bounds: RangeBounds): boolean {
  if (!bounds.start || !bounds.end) return false
  return key >= bounds.start && key <= bounds.end
}

/** 闭区间天数：同一天算 1 天。 */
export function spanInDays(start: DayKey, end: DayKey): number {
  return Math.round((fromDayKey(end).getTime() - fromDayKey(start).getTime()) / MS_PER_DAY) + 1
}

export function formatDayLabel(date: Date): string {
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
}

/** 底部摘要文案：未选完时提示下一步，选完后给出区间与天数。 */
export function describeBounds(bounds: RangeBounds, complete: boolean): string | null {
  if (!bounds.start) return null

  const startLabel = formatDayLabel(fromDayKey(bounds.start))
  if (!bounds.end || bounds.end === bounds.start) {
    return complete ? startLabel : `${startLabel} - 请选择结束日期`
  }

  const endLabel = formatDayLabel(fromDayKey(bounds.end))
  return `${startLabel} - ${endLabel} · ${spanInDays(bounds.start, bounds.end)} 天`
}

let toneContext: AudioContext | null = null
let lastToneAt = 0

/**
 * 选日期 / 翻月时的一声短促「嗒」。
 * 合成一个快速衰减的三角波，不额外加载音频资源；浏览器不支持时静默跳过。
 */
export function playClickTone(enabled: boolean): void {
  if (!enabled || typeof window === "undefined") return

  const now = performance.now()
  if (now - lastToneAt < MIN_TONE_INTERVAL_MS) return
  lastToneAt = now

  try {
    const context = ensureToneContext()
    if (!context) return

    const startAt = context.currentTime
    const oscillator = context.createOscillator()
    const envelope = context.createGain()

    oscillator.type = "triangle"
    oscillator.frequency.setValueAtTime(1760, startAt)
    oscillator.frequency.exponentialRampToValueAtTime(880, startAt + 0.03)

    envelope.gain.setValueAtTime(0.0001, startAt)
    envelope.gain.exponentialRampToValueAtTime(0.05, startAt + 0.004)
    envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.05)

    oscillator.connect(envelope)
    envelope.connect(context.destination)
    oscillator.start(startAt)
    oscillator.stop(startAt + 0.06)
  } catch {
    // 音频不可用（自动播放策略、无设备等）时保持静音，不影响选择功能。
  }
}

function composeDayKey(year: number, month: number, day: number): DayKey {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function ensureToneContext(): AudioContext | null {
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null

  if (!toneContext) {
    toneContext = new AudioContextCtor()
  }
  if (toneContext.state === "suspended") {
    void toneContext.resume()
  }
  return toneContext
}
