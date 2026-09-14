"use client"

/**
 * 改编自 Ruixen UI — Progressive Flux Loader（上游源码未附额外版权声明）。
 * 来源：https://ruixen.com/r/progressive-flux-loader.json
 * 保留受控进度、阶段标签、渐变光泽与 reduced-motion；移除自动模拟计时，
 * 增加未知总量与停止状态，并缩小标签以适配业务列表和移动端。
 */
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

export interface ProgressiveFluxPhase {
  at: number
  label: string
}

export interface ProgressiveFluxLoaderProps {
  /** 不传或 null 为未知总量；绝不自动递增或循环模拟百分比。 */
  value?: number | null
  phases?: ProgressiveFluxPhase[]
  label?: string
  showLabel?: boolean
  active?: boolean
  gradient?: string
  className?: string
  barClassName?: string
  textClassName?: string
}

const FLUX_FROM = "var(--flux-from, var(--primary))"
const FLUX_TO = "var(--flux-to, color-mix(in oklab, var(--primary), var(--background) 45%))"
const FLUX_MID = `color-mix(in oklab, ${FLUX_FROM}, ${FLUX_TO})`
const DEFAULT_GRADIENT = `linear-gradient(90deg, ${FLUX_FROM} 0%, ${FLUX_MID} 35%, ${FLUX_TO} 55%, ${FLUX_MID} 78%, ${FLUX_FROM} 100%)`
const SHEEN_GRADIENT = "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.55) 50%, transparent 100%)"

function pickLabel(value: number, phases: ProgressiveFluxPhase[]) {
  const sorted = [...phases].sort((a, b) => a.at - b.at)
  let label = sorted[0]?.label ?? "处理中"
  for (const phase of sorted) {
    if (value >= phase.at) label = phase.label
  }
  return label
}

export function ProgressiveFluxLoader({
  value,
  phases = [],
  label,
  showLabel = true,
  active = true,
  gradient = DEFAULT_GRADIENT,
  className,
  barClassName,
  textClassName,
}: ProgressiveFluxLoaderProps) {
  const reduced = useReducedMotion()
  const current = typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value)) : null
  const text = label ?? pickLabel(current ?? 0, phases)
  const moving = active && !reduced && current !== 100
  const valueText = current === null ? text : `${text} · ${Math.round(current)}%`

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-2", className)}>
      {showLabel ? (
        <motion.div
          key={text}
          aria-hidden
          initial={moving ? { opacity: 0, y: 3 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: moving ? 0.2 : 0 }}
          className={cn("break-words text-xs text-muted-foreground", textClassName)}
        >
          {valueText}
        </motion.div>
      ) : null}
      <div
        className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", barClassName)}
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={current === null ? undefined : Math.round(current)}
        aria-valuetext={valueText}
        aria-busy={active}
        data-state={active ? current === null ? "indeterminate" : "progress" : "stopped"}
      >
        <motion.div
          className="relative h-full rounded-full"
          style={{
            background: current === null
              ? "repeating-linear-gradient(110deg, var(--muted-foreground) 0 3px, transparent 3px 8px)"
              : gradient,
            opacity: current === null ? 0.3 : 1,
          }}
          initial={false}
          animate={{ width: current === null ? "100%" : `${current}%` }}
          transition={{ duration: moving ? 0.55 : 0, ease: [0.22, 1, 0.36, 1] }}
        >
          {moving ? (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 w-1/2 rounded-full"
              style={{ background: SHEEN_GRADIENT, mixBlendMode: "screen" }}
              animate={{ x: ["-110%", "210%"] }}
              transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
            />
          ) : null}
        </motion.div>
      </div>
    </div>
  )
}

export default ProgressiveFluxLoader
