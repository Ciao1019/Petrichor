/**
 * 数值区间归一（来自 assistant-ui registry: elements-range）。
 *
 * Elements 的数值 prop 由调用方状态驱动，可能是负数、越界或 NaN。原样透传会进 DOM：
 * 负百分比是非法 CSS 宽度、浏览器直接丢弃从而露出天然全宽；负的切片长度会从数组末尾
 * 反向计数而不是返回空。
 *
 * 只迁移现有 elements 用到的函数：tool-timeline 用 clamp / take，job-progress
 * 用 clamp / take / pct / announced / progressOf。其余（indexIn / at）等有元素
 * 需要时再从 registry 取。
 */

/**
 * 把值约束进 `min…max`。NaN 优先判定并映射为 `min`。
 * 其他值在空集合下会让上下界翻转，此时 `max` 胜出：`clamp(3, 1, 0)` 得 `0`，
 * 这正是"下限为一项"仍能产出零项的原因。
 */
export function clamp(value: number, min: number, max: number) {
    if (Number.isNaN(value)) return min
    return Math.min(max, Math.max(min, value))
}

/** 前 `count` 项，`count` 可以越界。 */
export function take<T>(items: readonly T[], count: number) {
    return items.slice(0, Math.floor(clamp(count, 0, items.length)))
}

/** `value` 占 `total` 的份额，以 `0…100` 的百分比返回。 */
export function pct(value: number, total: number) {
    if (!(total > 0)) return 0
    return clamp((value / total) * 100, 0, 100)
}

/**
 * `0…100` 的份额按屏幕播报的方式取整。`pct` 做除法，屏幕上读作整数的份额
 * 传到 `aria-valuenow` 时可能仍带浮点误差，读屏会把它完整念出来。
 */
export function announced(share: number) {
    return Math.round(share * 10) / 10
}

/** 已完成项计数，结果落在 `0…total`。 */
export function progressOf(index: number, total: number) {
    if (!(total > 0)) return 0
    return Math.floor(clamp(index, 0, total))
}
