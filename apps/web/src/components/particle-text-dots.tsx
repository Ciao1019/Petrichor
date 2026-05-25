import * as React from "react"

import { cn } from "@/lib/utils"

type Variant = "dark" | "light"

interface ParticleTextDotsProps {
  text: string
  variant?: Variant
  className?: string
}

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  baseX: number
  baseY: number
  depth: number
  size: number
  phase: number
}

type MouseState = {
  x: number
  y: number
  active: boolean
}

type AnimationRuntime = {
  width: number
  height: number
  dpr: number
  lastTime: number
  particles: Particle[]
  disposed: boolean
}

interface StartAnimationOptions {
  container: HTMLDivElement
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  text: string
  variant: Variant
  mouseRef: React.MutableRefObject<MouseState>
  frameRef: React.MutableRefObject<number | null>
}

const FONT_FAMILY = 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif'
const FULL_CIRCLE = Math.PI * 2
const START_OFFSET = 22
const ALPHA_THRESHOLD = 70

function getDocumentVariant(): Variant {
  if (typeof document === "undefined") {
    return "light"
  }
  if (document.documentElement.classList.contains("dark")) {
    return "dark"
  }
  return "light"
}

function useResolvedVariant(variant?: Variant): Variant {
  const [resolvedVariant, setResolvedVariant] = React.useState<Variant>(() => variant ?? getDocumentVariant())

  React.useEffect(() => {
    if (variant) {
      setResolvedVariant(variant)
      return
    }

    setResolvedVariant(getDocumentVariant())
    const observer = new MutationObserver(() => {
      setResolvedVariant(getDocumentVariant())
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [variant])

  return resolvedVariant
}

function resolveFontSize(width: number, height: number, label: string) {
  const maxFontHeight = height * 0.65
  const targetWidth = width * 0.8
  const approxCharWidth = 0.6
  const fallbackLength = Math.max(1, label.length * approxCharWidth)
  return Math.min(maxFontHeight, targetWidth / fallbackLength)
}

function createParticlesFromText(width: number, height: number, text: string, variant: Variant): Particle[] {
  const label = text.trim() || "Petrichor"
  const offscreen = document.createElement("canvas")
  offscreen.width = width
  offscreen.height = height

  const offscreenContext = offscreen.getContext("2d")
  if (!offscreenContext) {
    return []
  }

  offscreenContext.clearRect(0, 0, width, height)
  offscreenContext.fillStyle = variant === "dark" ? "#ffffff" : "#020617"
  offscreenContext.textAlign = "center"
  offscreenContext.textBaseline = "middle"
  offscreenContext.font = `800 ${resolveFontSize(width, height, label)}px ${FONT_FAMILY}`
  offscreenContext.fillText(label, width / 2, height / 2)

  const imageData = offscreenContext.getImageData(0, 0, width, height)
  const gap = Math.max(5, Math.round(Math.min(width, height) / 65))
  const particles: Particle[] = []

  for (let y = 0; y < height; y += gap) {
    for (let x = 0; x < width; x += gap) {
      const index = (y * width + x) * 4
      const alpha = imageData.data[index + 3]
      if (alpha <= ALPHA_THRESHOLD) {
        continue
      }
      const depth = Math.random()
      const jitterX = (Math.random() - 0.5) * gap * 0.2
      const jitterY = (Math.random() - 0.5) * gap * 0.2
      const baseX = x + jitterX
      const baseY = y + jitterY
      particles.push({
        x: baseX + (Math.random() - 0.5) * START_OFFSET,
        y: baseY + (Math.random() - 0.5) * START_OFFSET,
        vx: 0,
        vy: 0,
        baseX,
        baseY,
        depth,
        size: 1.4 + depth * 1.3,
        phase: Math.random() * FULL_CIRCLE,
      })
    }
  }
  return particles
}

function applyMousePush(particle: Particle, mouse: MouseState, influenceRadius: number, influenceRadiusSq: number) {
  if (!mouse.active) {
    return
  }
  const dx = particle.x - mouse.x
  const dy = particle.y - mouse.y
  const distanceSq = dx * dx + dy * dy
  if (distanceSq >= influenceRadiusSq || distanceSq <= 0.0001) {
    return
  }
  const distance = Math.sqrt(distanceSq)
  const force = (1 - distance / influenceRadius) * 1.5
  const k = force * (0.4 + particle.depth * 0.6)
  particle.vx += (dx / distance) * k
  particle.vy += (dy / distance) * k
}

function applySpringDrift(particle: Particle, dt: number, t: number) {
  const spring = 0.06 + particle.depth * 0.03
  particle.vx += (particle.baseX - particle.x) * spring * dt
  particle.vy += (particle.baseY - particle.y) * spring * dt

  const wobble = 0.07 + particle.depth * 0.09
  particle.vx += Math.cos(t * 1.2 + particle.phase) * wobble * 0.16 * dt
  particle.vy += Math.sin(t * 1.3 + particle.phase) * wobble * 0.16 * dt

  particle.vx *= 0.9
  particle.vy *= 0.9
  particle.x += particle.vx * dt
  particle.y += particle.vy * dt
}

function resolveDrawStyle(particle: Particle, mouse: MouseState, t: number, influenceRadius: number, variant: Variant) {
  const dx = particle.x - mouse.x
  const dy = particle.y - mouse.y
  const distance = Math.sqrt(dx * dx + dy * dy) || 1
  const near = mouse.active ? Math.max(0, 1 - distance / influenceRadius) : 0
  const flickerBase = (Math.sin(t + particle.phase * 1.7) + 1) * 0.5
  const flicker = 0.85 + 0.15 * flickerBase
  const depthFactor = 0.55 + particle.depth * 0.45
  const alpha = (0.55 + 0.3 * near) * depthFactor * flicker
  const hue = variant === "dark" ? 210 + particle.depth * 40 : 220 + particle.depth * 30
  const lightness = variant === "dark" ? 63 + particle.depth * 18 : 50 + particle.depth * 15
  return `hsla(${hue}, 90%, ${lightness}%, ${alpha})`
}

function resizeCanvas(runtime: AnimationRuntime, options: StartAnimationOptions) {
  const { container, canvas, context, text, variant, mouseRef } = options
  const rect = container.getBoundingClientRect()
  runtime.width = Math.max(1, Math.floor(rect.width))
  runtime.height = Math.max(1, Math.floor(rect.height))

  canvas.width = runtime.width * runtime.dpr
  canvas.height = runtime.height * runtime.dpr
  context.setTransform(runtime.dpr, 0, 0, runtime.dpr, 0, 0)
  runtime.particles = createParticlesFromText(runtime.width, runtime.height, text, variant)

  mouseRef.current.x = runtime.width / 2
  mouseRef.current.y = runtime.height / 2
}

function renderFrame(runtime: AnimationRuntime, options: StartAnimationOptions, time: number) {
  const { context, frameRef, mouseRef, variant } = options
  if (runtime.disposed) {
    return
  }

  const dt = Math.min(2, (time - runtime.lastTime) / 16.67)
  runtime.lastTime = time
  const t = time * 0.0012
  const influenceRadius = Math.min(runtime.width, runtime.height) * 0.35
  const influenceRadiusSq = influenceRadius * influenceRadius

  context.clearRect(0, 0, runtime.width, runtime.height)
  for (const particle of runtime.particles) {
    applyMousePush(particle, mouseRef.current, influenceRadius, influenceRadiusSq)
    applySpringDrift(particle, dt, t)
  }
  for (const particle of runtime.particles) {
    context.fillStyle = resolveDrawStyle(particle, mouseRef.current, t, influenceRadius, variant)
    context.beginPath()
    context.arc(particle.x, particle.y, particle.size, 0, FULL_CIRCLE)
    context.fill()
  }
  frameRef.current = requestAnimationFrame((nextTime) => renderFrame(runtime, options, nextTime))
}

function startAnimation(options: StartAnimationOptions) {
  const runtime: AnimationRuntime = {
    width: 0,
    height: 0,
    dpr: window.devicePixelRatio || 1,
    lastTime: performance.now(),
    particles: [],
    disposed: false,
  }

  const resize = () => resizeCanvas(runtime, options)
  resize()

  const observer = new ResizeObserver(resize)
  observer.observe(options.container)
  options.frameRef.current = requestAnimationFrame((time) => renderFrame(runtime, options, time))

  return () => {
    runtime.disposed = true
    observer.disconnect()
    if (options.frameRef.current !== null) {
      cancelAnimationFrame(options.frameRef.current)
    }
  }
}

function useParticleAnimation(
  containerRef: React.MutableRefObject<HTMLDivElement | null>,
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>,
  text: string,
  variant: Variant,
  mouseRef: React.MutableRefObject<MouseState>,
  frameRef: React.MutableRefObject<number | null>,
) {
  React.useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) {
      return
    }

    const context = canvas.getContext("2d")
    if (!context) {
      return
    }

    return startAnimation({
      container,
      canvas,
      context,
      text,
      variant,
      mouseRef,
      frameRef,
    })
  }, [canvasRef, containerRef, frameRef, mouseRef, text, variant])
}

function usePointerHandlers(
  containerRef: React.MutableRefObject<HTMLDivElement | null>,
  mouseRef: React.MutableRefObject<MouseState>,
) {
  const onPointerMove: React.PointerEventHandler<HTMLDivElement> = React.useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    mouseRef.current.x = event.clientX - rect.left
    mouseRef.current.y = event.clientY - rect.top
    mouseRef.current.active = true
  }, [mouseRef])

  const onPointerLeave: React.PointerEventHandler<HTMLDivElement> = React.useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const rect = container.getBoundingClientRect()
    mouseRef.current.x = rect.width / 2
    mouseRef.current.y = rect.height / 2
    mouseRef.current.active = false
  }, [containerRef, mouseRef])

  return { onPointerMove, onPointerLeave }
}

export function ParticleTextDots({ text, variant, className }: ParticleTextDotsProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const frameRef = React.useRef<number | null>(null)
  const mouseRef = React.useRef<MouseState>({ x: 0, y: 0, active: false })
  const resolvedVariant = useResolvedVariant(variant)

  useParticleAnimation(containerRef, canvasRef, text, resolvedVariant, mouseRef, frameRef)
  const { onPointerMove, onPointerLeave } = usePointerHandlers(containerRef, mouseRef)

  return (
    <div
      ref={containerRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={cn(
        "relative w-full overflow-hidden rounded-3xl border",
        "min-h-[260px] sm:min-h-[320px] md:min-h-[360px]",
        "shadow-[0_22px_90px_rgba(0,0,0,0.7)]",
        resolvedVariant === "dark" ? "border-slate-800 bg-black" : "border-slate-200 bg-slate-50",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      {resolvedVariant === "dark" ? (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(148,163,253,0.16),transparent_60%),radial-gradient(circle_at_bottom,_rgba(15,23,42,0.9),transparent_55%)]" />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.16),transparent_60%),radial-gradient(circle_at_bottom,_rgba(15,23,42,0.05),transparent_55%)]" />
      )}
    </div>
  )
}
