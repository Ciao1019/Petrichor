"use client"

import * as React from "react"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

let audioContextSingleton: AudioContext | null = null
let audioBufferSingleton: AudioBuffer | null = null

const COLORS = [
  "#FF6B6B",
  "#51CF66",
  "#339AF0",
  "#FCC419",
  "#CC5DE8",
  "#FF922B",
  "#20C997",
  "#F06595",
] as const
const PROXIMITY_RADIUS = 60
const DOT_SIZE = 12
const DOT_GAP = 10
const SPRING_TRANSITION = { type: "spring" as const, stiffness: 500, damping: 30 }

const WRAPPER_CSS = `.ip{--ip-bg:rgba(255,255,255,.72);--ip-border:rgba(0,0,0,.06);--ip-shadow:0 0 0 .5px rgba(0,0,0,.04),0 2px 4px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);--ip-ink:0,0,0}.dark .ip,[data-theme="dark"] .ip{--ip-bg:rgba(30,30,32,.82);--ip-border:rgba(255,255,255,.06);--ip-shadow:0 0 0 .5px rgba(255,255,255,.04),0 2px 4px rgba(0,0,0,.2),0 8px 24px rgba(0,0,0,.3);--ip-ink:255,255,255}`

function clampPageIndex(page: number, totalPages: number) {
  if (totalPages <= 1) return 0
  if (page < 0) return 0
  if (page > totalPages - 1) return totalPages - 1
  return page
}

function getAudioContext(): AudioContext {
  if (!audioContextSingleton) {
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      throw new Error("AudioContext not supported")
    }
    audioContextSingleton = new AudioContextCtor()
  }
  if (audioContextSingleton.state === "suspended") {
    void audioContextSingleton.resume()
  }
  return audioContextSingleton
}

function getAudioBuffer(context: AudioContext): AudioBuffer {
  if (audioBufferSingleton && audioBufferSingleton.sampleRate === context.sampleRate) {
    return audioBufferSingleton
  }
  const length = Math.floor(context.sampleRate * 0.003)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) {
    channel[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 4
  }
  audioBufferSingleton = buffer
  return buffer
}

function playTick(lastSoundRef: React.MutableRefObject<number>) {
  const now = performance.now()
  if (now - lastSoundRef.current < 25) return
  lastSoundRef.current = now
  try {
    const context = getAudioContext()
    const source = context.createBufferSource()
    const gainNode = context.createGain()
    source.buffer = getAudioBuffer(context)
    gainNode.gain.value = 0.06
    source.connect(gainNode).connect(context.destination)
    source.start()
  } catch {
    // 音频能力不可用时静默忽略，不影响分页主流程。
  }
}

function buildVisiblePages(activePage: number, totalPages: number, maxVisible: number) {
  const count = Math.min(totalPages, maxVisible)
  const half = Math.floor(count / 2)
  let start = activePage - half
  let end = activePage + (count - half - 1)
  if (start < 0) {
    end += -start
    start = 0
  }
  if (end >= totalPages) {
    start -= end - totalPages + 1
    end = totalPages - 1
    start = Math.max(0, start)
  }
  const visible: number[] = []
  for (let i = start; i <= end; i += 1) {
    visible.push(i)
  }
  return visible
}

function calcLift(distancePx: number) {
  if (distancePx >= PROXIMITY_RADIUS) return 0
  return (1 + Math.cos((distancePx / PROXIMITY_RADIUS) * Math.PI)) / 2
}

function Arrow({
  direction,
  disabled,
  onClick,
}: {
  direction: "prev" | "next"
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: "none",
        background: "none",
        padding: 4,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.15 : 0.4,
        display: "flex",
        transition: "opacity .12s",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        {direction === "prev" ? (
          <path
            d="M7.5 2.5L4.5 6L7.5 9.5"
            stroke={`rgba(var(--ip-ink),.6)`}
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M4.5 2.5L7.5 6L4.5 9.5"
            stroke={`rgba(var(--ip-ink),.6)`}
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  )
}

function Dot({
  page,
  active,
  lift,
  onClick,
}: {
  page: number
  active: boolean
  lift: number
  onClick: (page: number) => void
}) {
  const color = COLORS[page % COLORS.length]
  return (
    <motion.button
      key={page}
      type="button"
      onClick={() => onClick(page)}
      animate={{
        y: -lift * 6,
        scale: active ? 1.3 : 1 + lift * 0.1,
      }}
      transition={SPRING_TRANSITION}
      style={{
        width: DOT_SIZE,
        height: DOT_SIZE,
        borderRadius: "50%",
        border: "none",
        padding: 0,
        cursor: "pointer",
        background: color,
        opacity: active ? 1 : 0.45 + lift * 0.35,
        boxShadow: active
          ? `0 0 0 2px var(--ip-bg), 0 0 0 3.5px ${color}, 0 2px 8px ${color}40`
          : lift > 0.3
            ? `0 2px 6px ${color}30`
            : "none",
        transition: "opacity .1s, box-shadow .15s",
        flexShrink: 0,
      }}
    />
  )
}

export interface IconPaginationProps {
  totalPages?: number
  maxVisible?: number
  page?: number
  onChange?: (page: number) => void
  sound?: boolean
  disabled?: boolean
  showLabel?: boolean
  minHeight?: number | string
  className?: string
}

export function IconPagination({
  totalPages = 8,
  maxVisible = 9,
  page,
  onChange,
  sound = true,
  disabled = false,
  showLabel = true,
  minHeight = 56,
  className,
}: IconPaginationProps) {
  const [internalPage, setInternalPage] = React.useState(0)
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const lastSound = React.useRef(0)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const safeTotalPages = Math.max(1, totalPages)
  const isControlled = typeof page === "number"
  const activePage = clampPageIndex(isControlled ? (page as number) : internalPage, safeTotalPages)

  React.useEffect(() => {
    if (isControlled) return
    setInternalPage((prev) => clampPageIndex(prev, safeTotalPages))
  }, [isControlled, safeTotalPages])

  const visiblePages = React.useMemo(() => {
    const count = Math.max(1, maxVisible)
    return buildVisiblePages(activePage, safeTotalPages, count)
  }, [activePage, maxVisible, safeTotalPages])

  const goPage = React.useCallback(
    (nextPage: number) => {
      if (disabled) return
      const safeNext = clampPageIndex(nextPage, safeTotalPages)
      if (safeNext === activePage) return
      if (sound) {
        playTick(lastSound)
      }
      if (!isControlled) {
        setInternalPage(safeNext)
      }
      onChange?.(safeNext)
    },
    [activePage, disabled, isControlled, onChange, safeTotalPages, sound],
  )

  const onMouseMove = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = event.clientX - rect.left
      const dotWidth = DOT_SIZE + DOT_GAP
      const leftPadding = 34
      const idx = Math.round((x - leftPadding - DOT_SIZE / 2) / dotWidth)
      setHoverIndex(idx >= 0 && idx < visiblePages.length ? idx : -1)
    },
    [visiblePages.length],
  )

  return (
    <div
      className={cn("ip", className)}
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: showLabel ? "space-between" : "center",
        gap: 8,
        minHeight: typeof minHeight === "number" ? `${minHeight}px` : minHeight,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: WRAPPER_CSS }} />

      <div
        ref={containerRef}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverIndex(-1)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: DOT_GAP,
          padding: "10px 14px",
          background: "var(--ip-bg)",
          border: "1px solid var(--ip-border)",
          boxShadow: "var(--ip-shadow)",
          borderRadius: 24,
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <Arrow
          direction="prev"
          disabled={disabled || activePage <= 0}
          onClick={() => goPage(activePage - 1)}
        />

        {visiblePages.map((pageNum, index) => {
          const isActive = pageNum === activePage
          const distancePx = Math.abs(index - hoverIndex) * (DOT_SIZE + DOT_GAP)
          const lift = hoverIndex >= 0 ? calcLift(distancePx) : 0
          return (
            <Dot
              key={pageNum}
              page={pageNum}
              active={isActive}
              lift={lift}
              onClick={goPage}
            />
          )
        })}

        <Arrow
          direction="next"
          disabled={disabled || activePage >= safeTotalPages - 1}
          onClick={() => goPage(activePage + 1)}
        />
      </div>

      {showLabel ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 450,
            color: `rgba(var(--ip-ink),.3)`,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.02em",
          }}
        >
          Page {activePage + 1} of {safeTotalPages}
        </span>
      ) : null}
    </div>
  )
}

export default IconPagination
