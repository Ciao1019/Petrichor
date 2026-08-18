"use client"

import * as React from "react"
import { motion, useAnimation, useReducedMotion, type Variants } from "motion/react"

export type IconAnimation =
  | "bounce"
  | "draw"
  | "fold"
  | "pop"
  | "pulse"
  | "scan"
  | "shake"
  | "slide-down"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "sparkle"
  | "spin"
  | "swing"
  | "tilt"

export interface IconProps
  extends Omit<React.SVGProps<SVGSVGElement>, "ref"> {
  absoluteStrokeWidth?: boolean
  size?: number | string
  strokeWidth?: number | string
}
export type LucideProps = IconProps
export type IconComponent = React.ForwardRefExoticComponent<
  IconProps & React.RefAttributes<SVGSVGElement>
>
export type LucideIcon = IconComponent
export type Icon = IconComponent

const RETURN_TRANSITION = {
  duration: 0.28,
  ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
}

const animations: Record<IconAnimation, Variants> = {
  bounce: {
    normal: { scale: 1, y: 0, transition: RETURN_TRANSITION },
    animate: {
      scale: [1, 1.04, 0.98, 1],
      y: [0, -12, 2, 0],
      transition: { duration: 0.56, ease: "easeOut" },
    },
  },
  draw: {
    normal: { opacity: 1, scaleX: 1, transition: RETURN_TRANSITION },
    animate: {
      opacity: [1, 0.62, 1],
      scaleX: [1, 0.78, 1.04, 1],
      transition: { duration: 0.48, ease: "easeInOut" },
    },
  },
  fold: {
    normal: { rotateX: 0, scaleY: 1, transition: RETURN_TRANSITION },
    animate: {
      rotateX: [0, -22, 8, 0],
      scaleY: [1, 0.9, 1.03, 1],
      transition: { duration: 0.52, ease: "easeInOut" },
    },
  },
  pop: {
    normal: { rotate: 0, scale: 1, transition: RETURN_TRANSITION },
    animate: {
      rotate: [0, -5, 4, 0],
      scale: [1, 0.82, 1.16, 1],
      transition: { duration: 0.48, ease: "easeOut" },
    },
  },
  pulse: {
    normal: { opacity: 1, scale: 1, transition: RETURN_TRANSITION },
    animate: {
      opacity: [1, 0.58, 1],
      scale: [1, 1.12, 1],
      transition: { duration: 0.62, ease: "easeInOut" },
    },
  },
  scan: {
    normal: { rotate: 0, x: 0, y: 0, transition: RETURN_TRANSITION },
    animate: {
      rotate: [0, -7, 5, 0],
      x: [0, 10, -5, 0],
      y: [0, -8, 3, 0],
      transition: { duration: 0.66, ease: "easeInOut" },
    },
  },
  shake: {
    normal: { rotate: 0, x: 0, transition: RETURN_TRANSITION },
    animate: {
      rotate: [0, -8, 7, -5, 3, 0],
      x: [0, -5, 5, -3, 2, 0],
      transition: { duration: 0.5, ease: "easeInOut" },
    },
  },
  "slide-down": {
    normal: { y: 0, transition: RETURN_TRANSITION },
    animate: { y: [0, 18, -4, 0], transition: { duration: 0.5, ease: "easeOut" } },
  },
  "slide-left": {
    normal: { x: 0, transition: RETURN_TRANSITION },
    animate: { x: [0, -18, 4, 0], transition: { duration: 0.5, ease: "easeOut" } },
  },
  "slide-right": {
    normal: { x: 0, transition: RETURN_TRANSITION },
    animate: { x: [0, 18, -4, 0], transition: { duration: 0.5, ease: "easeOut" } },
  },
  "slide-up": {
    normal: { y: 0, transition: RETURN_TRANSITION },
    animate: { y: [0, -18, 4, 0], transition: { duration: 0.5, ease: "easeOut" } },
  },
  sparkle: {
    normal: { opacity: 1, rotate: 0, scale: 1, transition: RETURN_TRANSITION },
    animate: {
      opacity: [1, 0.58, 1],
      rotate: [0, -12, 12, 0],
      scale: [1, 0.78, 1.2, 1],
      transition: { duration: 0.62, ease: "easeInOut" },
    },
  },
  spin: {
    normal: { rotate: 0, transition: RETURN_TRANSITION },
    animate: { rotate: 360, transition: { duration: 0.68, ease: "easeInOut" } },
  },
  swing: {
    normal: { rotate: 0, transition: RETURN_TRANSITION },
    animate: {
      rotate: [0, -12, 11, -8, 5, -2, 0],
      transition: { duration: 0.78, ease: "easeInOut" },
    },
  },
  tilt: {
    normal: { rotate: 0, scale: 1, y: 0, transition: RETURN_TRANSITION },
    animate: {
      rotate: [0, -6, 5, 0],
      scale: [1, 1.05, 1],
      y: [0, -5, 0],
      transition: { duration: 0.54, ease: "easeInOut" },
    },
  },
}

function composeHandler<Event>(
  userHandler: ((event: Event) => void) | undefined,
  iconHandler: () => void,
) {
  return (event: Event) => {
    userHandler?.(event)
    iconHandler()
  }
}

/**
 * Iconimate 风格图标工厂：使用 Phosphor 的 256 网格字形，复用同一套 hover/focus
 * 动效控制，并在 reduced-motion 下保持静态。
 */
export function createIconimateIcon(
  displayName: string,
  glyph: string,
  animation: IconAnimation = "tilt",
  options?: { loading?: boolean },
): IconComponent {
  const Icon = React.forwardRef<SVGSVGElement, IconProps>(function IconimateIcon(
    {
      absoluteStrokeWidth: _absoluteStrokeWidth,
      children,
      className,
      onBlur,
      onFocus,
      onMouseEnter,
      onMouseLeave,
      size = 24,
      strokeWidth: _strokeWidth,
      style,
      ...props
    },
    ref,
  ) {
    const controls = useAnimation()
    const reducedMotion = useReducedMotion() ?? false
    const active = React.useRef(false)
    const replayTimer = React.useRef<number | undefined>(undefined)

    const start = React.useCallback(() => {
      if (reducedMotion || active.current) return
      active.current = true

      const play = () => {
        if (!active.current) return
        const startedAt = performance.now()
        void controls.start("animate").then(() => {
          if (!active.current) return
          controls.set("normal")
          const elapsed = performance.now() - startedAt
          replayTimer.current = window.setTimeout(play, elapsed < 100 ? 280 : elapsed * 0.34)
        })
      }

      play()
    }, [controls, reducedMotion])

    const stop = React.useCallback(() => {
      active.current = false
      window.clearTimeout(replayTimer.current)
      void controls.start("normal")
    }, [controls])

    React.useEffect(
      () => () => {
        active.current = false
        window.clearTimeout(replayTimer.current)
      },
      [],
    )

    const accessible = Boolean(props["aria-label"] || props["aria-labelledby"] || props.role === "img")
    const loadingClass = options?.loading ? " motion-safe:animate-spin" : ""

    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill="currentColor"
        focusable={props.focusable ?? false}
        aria-hidden={props["aria-hidden"] ?? (accessible ? undefined : true)}
        data-iconimate={displayName}
        className={`${className ?? ""}${loadingClass}`.trim() || undefined}
        onMouseEnter={composeHandler(onMouseEnter, start)}
        onMouseLeave={composeHandler(onMouseLeave, stop)}
        onFocus={composeHandler(onFocus, start)}
        onBlur={composeHandler(onBlur, stop)}
        style={{ overflow: "visible", ...style }}
        {...props}
      >
        <motion.g
          initial="normal"
          animate={controls}
          variants={animations[animation]}
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
          dangerouslySetInnerHTML={{ __html: glyph }}
        />
        {children}
      </svg>
    )
  })

  Icon.displayName = `${displayName}Icon`
  return Icon
}
