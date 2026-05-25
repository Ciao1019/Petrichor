import * as React from "react"
import { motion } from "motion/react"

const CSS = `
.gc {
  --gc-glass: linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.62));
  --gc-border: rgba(0, 0, 0, 0.06);
  --gc-shadow:
    0 0 1px rgba(0, 0, 0, 0.04),
    0 2px 8px rgba(0, 0, 0, 0.04),
    0 12px 32px rgba(0, 0, 0, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.8);
  --gc-bar: rgba(0, 0, 0, 0.06);
  --gc-bar-shimmer: rgba(0, 0, 0, 0.1);
  --gc-hi: rgba(0, 0, 0, 0.88);
  --gc-btn-bg: rgba(255, 255, 255, 0.92);
  --gc-grad-a: #f472b6;
  --gc-grad-b: #a78bfa;
}

.dark .gc,
[data-theme="dark"] .gc {
  --gc-glass: linear-gradient(135deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
  --gc-border: rgba(255, 255, 255, 0.07);
  --gc-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  --gc-bar: rgba(255, 255, 255, 0.06);
  --gc-bar-shimmer: rgba(255, 255, 255, 0.1);
  --gc-hi: rgba(255, 255, 255, 0.88);
  --gc-btn-bg: rgba(255, 255, 255, 0.06);
  --gc-grad-a: #f9a8d4;
  --gc-grad-b: #c4b5fd;
}

@keyframes gc-shimmer {
  0% {
    background-position: -200% 0;
  }

  100% {
    background-position: 200% 0;
  }
}

@keyframes gc-hue {
  0% {
    filter: hue-rotate(0deg);
  }

  100% {
    filter: hue-rotate(360deg);
  }
}
`

const BUFFER_DURATION = 0.003
const TICK_VOLUME = 0.08
const PRESS_DURATION_MS = 600
const SHIMMER_DURATION_SECONDS = 2.4
const GROUP_DELAY_SECONDS = 0.3
const SEGMENT_DELAY_SECONDS = 0.15

const DEFAULT_LINES: number[][] = [[100], [40, 20, 40], [40, 20], [20, 80]]

let audioContext: AudioContext | null = null
let noiseBuffer: AudioBuffer | null = null

function ensureNoiseBuffer(context: AudioContext) {
  if (noiseBuffer) return noiseBuffer
  const frameLength = (context.sampleRate * BUFFER_DURATION) | 0
  const buffer = context.createBuffer(1, frameLength, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i += 1) {
    const progress = 1 - i / data.length
    data[i] = (Math.random() * 2 - 1) * progress ** 4
  }
  noiseBuffer = buffer
  return buffer
}

function playTick() {
  if (typeof window === "undefined") return
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  const context = audioContext
  const source = context.createBufferSource()
  source.buffer = ensureNoiseBuffer(context)
  const gain = context.createGain()
  gain.gain.value = TICK_VOLUME
  source.connect(gain).connect(context.destination)
  source.start()
}

function ShimmerLine({ width, delaySeconds }: { width: string; delaySeconds: number }) {
  return (
    <div
      style={{
        height: 6,
        borderRadius: 999,
        width,
        background: "linear-gradient(90deg, var(--gc-bar) 40%, var(--gc-bar-shimmer) 50%, var(--gc-bar) 60%)",
        backgroundSize: "200% 100%",
        animation: `gc-shimmer ${SHIMMER_DURATION_SECONDS}s ease-in-out infinite`,
        animationDelay: `${delaySeconds}s`,
      }}
    />
  )
}

function ShimmerGroup({ group, groupIndex }: { group: number[]; groupIndex: number }) {
  if (group.length === 1) {
    return <ShimmerLine width={`${group[0]}%`} delaySeconds={groupIndex * GROUP_DELAY_SECONDS} />
  }

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {group.map((widthPercent, index) => (
        <ShimmerLine
          key={`${widthPercent}-${index}`}
          width={`${widthPercent}%`}
          delaySeconds={(groupIndex * group.length + index) * SEGMENT_DELAY_SECONDS}
        />
      ))}
    </div>
  )
}

function SparklesIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" opacity={0.5} />
      <path d="M22 5h-4" opacity={0.5} />
      <path d="M4 17v2" opacity={0.5} />
      <path d="M5 18H3" opacity={0.5} />
    </svg>
  )
}

function usePressFeedback(onAction?: () => void, sound = true) {
  const [pressed, setPressed] = React.useState(false)
  const timeoutRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const onClick = React.useCallback(() => {
    if (sound) playTick()
    setPressed(true)
    onAction?.()
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = window.setTimeout(() => setPressed(false), PRESS_DURATION_MS)
  }, [onAction, sound])

  return { pressed, onClick }
}

export interface GlassAICardProps {
  lines?: number[][]
  actionLabel?: string
  onAction?: () => void
  sound?: boolean
  style?: React.CSSProperties
}

const CARD_BASE_STYLE: React.CSSProperties = {
  position: "relative",
  minWidth: 320,
  maxWidth: 400,
  padding: 24,
  background: "var(--gc-glass)",
  border: "1px solid var(--gc-border)",
  borderRadius: 16,
  boxShadow: "var(--gc-shadow)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
}

const BUTTON_STYLE: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  padding: "0 14px",
  border: "none",
  borderRadius: 999,
  background: "transparent",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--gc-hi)",
  overflow: "hidden",
}

function GlassCardLines({ lines }: { lines: number[][] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {lines.map((group, index) => (
        <div key={`${index}-${group.join("-")}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ShimmerGroup group={group} groupIndex={index} />
        </div>
      ))}
    </div>
  )
}

function GlassCardButton({
  actionLabel,
  pressed,
  onClick,
}: {
  actionLabel: string
  pressed: boolean
  onClick: () => void
}) {
  return (
    <div style={{ marginTop: 24 }}>
      <motion.button
        onClick={onClick}
        whileTap={{ scale: 0.96 }}
        animate={pressed ? { scale: [1, 1.04, 1] } : {}}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
        style={BUTTON_STYLE}
      >
        <span style={{ position: "absolute", inset: 0, borderRadius: 999, padding: 1, overflow: "hidden" }}>
          <span
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 999,
              background: "linear-gradient(135deg, var(--gc-grad-a), var(--gc-grad-b))",
              opacity: 0.5,
              animation: "gc-hue 4s linear infinite",
            }}
          />
          <span
            style={{
              position: "relative",
              display: "block",
              width: "100%",
              height: "100%",
              borderRadius: 999,
              background: "var(--gc-btn-bg)",
            }}
          />
        </span>
        <span style={{ position: "relative", display: "flex" }}>
          <SparklesIcon />
        </span>
        <span style={{ position: "relative" }}>{actionLabel}</span>
      </motion.button>
    </div>
  )
}

function GlassCardShell({
  children,
  style,
}: {
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div className="gc" style={{ ...CARD_BASE_STYLE, ...style }}>
      {children}
    </div>
  )
}

export default function GlassAICard(props: GlassAICardProps) {
  const {
    lines = DEFAULT_LINES,
    actionLabel = "Generate",
    onAction,
    sound = true,
    style,
  } = props
  const { pressed, onClick } = usePressFeedback(onAction, sound)

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <GlassCardShell style={style}>
        <GlassCardLines lines={lines} />
        <GlassCardButton actionLabel={actionLabel} pressed={pressed} onClick={onClick} />
      </GlassCardShell>
    </>
  )
}
