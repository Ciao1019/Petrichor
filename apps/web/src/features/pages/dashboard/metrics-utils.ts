import type { DashboardRhythmCell, DashboardTrendPoint } from "@/lib/api"

/** 大屏可切换的统计跨度 */
export const RANGE_OPTIONS = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 365, label: "1 年" },
] as const

export type RangeValue = (typeof RANGE_OPTIONS)[number]["value"]

/** 分类色槽位：顺序固定，配色已跑过色盲与对比度校验，不要随手换或循环复用 */
export const VIZ = {
  slot1: "var(--viz-1)",
  slot2: "var(--viz-2)",
  slot3: "var(--viz-3)",
  slot4: "var(--viz-4)",
  slot5: "var(--viz-5)",
  slot6: "var(--viz-6)",
  slot7: "var(--viz-7)",
  slot8: "var(--viz-8)",
  good: "var(--viz-good)",
  warning: "var(--viz-warning)",
  serious: "var(--viz-serious)",
  critical: "var(--viz-critical)",
} as const

/** 热力色阶，0 档留白代表「无」 */
export const HEAT_SCALE = [
  "var(--viz-seq-0)",
  "var(--viz-seq-1)",
  "var(--viz-seq-2)",
  "var(--viz-seq-3)",
  "var(--viz-seq-4)",
]

/** 中文习惯的紧凑计数：万、亿。用于正文读数，保留一位小数 */
export function formatCompact(value: number) {
  const abs = Math.abs(value)
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(abs >= 1_000_000_000 ? 0 : 1)}亿`
  if (abs >= 10_000) return `${(value / 10_000).toFixed(abs >= 1_000_000 ? 0 : 1)}万`
  return value.toLocaleString("zh-CN")
}

/**
 * 坐标轴刻度专用：一律不保留小数。
 *
 * 刻度写在固定宽度的轴带里，「18.0万」这种长文本会被轴宽裁掉首字符，
 * 读出来变成「8.0万」——刻度看上去就不单调了。宁可少一位精度也不能被裁。
 */
export function formatAxisTick(value: number) {
  const abs = Math.abs(value)
  if (abs >= 100_000_000) return `${Math.round(value / 100_000_000)}亿`
  if (abs >= 10_000) return `${Math.round(value / 10_000)}万`
  return value.toLocaleString("zh-CN")
}

export function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function formatDuration(ms: number) {
  if (ms <= 0) return "0 ms"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export function formatDay(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function formatMonth(value: string) {
  const [year, month] = value.split("-")
  return `${year?.slice(2)}/${month}`
}

export function relativeTime(value?: string | null) {
  if (!value) return ""
  const target = new Date(value).getTime()
  if (Number.isNaN(target)) return ""
  const minutes = Math.round((Date.now() - target) / 60000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })
}

/** 按范围截取趋势尾部；365 天全量由服务端一次给足，切换范围不再回源 */
export function sliceTrend(trend: DashboardTrendPoint[], days: number) {
  return trend.slice(-days)
}

const DAY_MINUTES = 24 * 60
const WEEK_MINUTES = 7 * DAY_MINUTES

/**
 * 把服务端的 UTC 星期×小时格子折算到本地时区。
 *
 * 时区平移在「星期×小时」这个环形空间里就是一次整体旋转，所以能精确还原，
 * 不需要服务端知道用户时区。offsetMinutes 为本地相对 UTC 的偏移（东八区为 +480）。
 */
export function shiftRhythmToLocal(
  cells: DashboardRhythmCell[],
  offsetMinutes: number,
): DashboardRhythmCell[] {
  const grid = new Map<string, number>()
  for (const cell of cells) {
    const total =
      (((cell.weekday * DAY_MINUTES + cell.hour * 60 + offsetMinutes) % WEEK_MINUTES) +
        WEEK_MINUTES) %
      WEEK_MINUTES
    const weekday = Math.floor(total / DAY_MINUTES)
    const hour = Math.floor((total % DAY_MINUTES) / 60)
    const key = `${weekday}:${hour}`
    grid.set(key, (grid.get(key) ?? 0) + cell.count)
  }
  const result: DashboardRhythmCell[] = []
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      result.push({ weekday, hour, count: grid.get(`${weekday}:${hour}`) ?? 0 })
    }
  }
  return result
}

export type RhythmBand = {
  weekday: number
  band: number
  startHour: number
  endHour: number
  count: number
}

/** 24 小时压成若干时段，稀疏数据下比 7×24 更容易看出规律 */
export function bucketRhythm(cells: DashboardRhythmCell[], bandHours = 3): RhythmBand[] {
  const bands = Math.ceil(24 / bandHours)
  const totals = new Map<string, number>()
  for (const cell of cells) {
    const band = Math.floor(cell.hour / bandHours)
    const key = `${cell.weekday}:${band}`
    totals.set(key, (totals.get(key) ?? 0) + cell.count)
  }
  const result: RhythmBand[] = []
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let band = 0; band < bands; band += 1) {
      result.push({
        weekday,
        band,
        startHour: band * bandHours,
        endHour: Math.min(24, (band + 1) * bandHours),
        count: totals.get(`${weekday}:${band}`) ?? 0,
      })
    }
  }
  return result
}

/** 把计数映射到 0-4 档色阶；0 恒为第 0 档，其余按占最大值的比例分档 */
export function heatLevel(count: number, max: number) {
  if (count <= 0 || max <= 0) return 0
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/** 折线用的归一化点位，供 sparkline 直接画 path */
export function sparkPath(values: number[], width: number, height: number) {
  if (values.length === 0) return ""
  if (values.length === 1) {
    const y = height / 2
    return `M0 ${y} L${width} ${y}`
  }
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const stepX = width / (values.length - 1)
  return values
    .map((value, index) => {
      const x = index * stepX
      const y = height - ((value - min) / span) * height
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(" ")
}

/** 状态标签与色槽的固定映射：状态色语义固定，不参与分类色轮换 */
export function statusMeta(status: string): { label: string; color: string } {
  switch (status) {
    case "ready":
    case "completed":
    case "succeeded":
      return { label: "已完成", color: VIZ.good }
    case "parsing":
    case "processing":
    case "running":
      return { label: "处理中", color: VIZ.warning }
    case "pending":
    case "queued":
      return { label: "排队中", color: VIZ.serious }
    case "failed":
    case "error":
      return { label: "失败", color: VIZ.critical }
    default:
      return { label: status, color: "var(--muted-foreground)" }
  }
}
