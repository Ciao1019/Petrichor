"use client"

import { useEffect, useRef, useState } from "react"

import { cn } from "@/cuicui/utils/cn"
import { StaticNoise } from "@/cuicui/other/creative-effects/animated-noise/static-noise"
import { DotsPattern } from "@/cuicui/other/patterns/dots-pattern/dots-pattern"

type Color = { value: string; gradient?: boolean }

const COLORS: Color[] = [
  { value: "linear-gradient(45deg, #ff9a9e, #fad0c4)", gradient: true },
  { value: "#6B6E8D" },
  {
    value: "linear-gradient(45deg, #ff9a9e, #fad0c4, #ffd1ff)",
    gradient: true,
  },
  { value: "linear-gradient(45deg, #f6d365, #fda085)", gradient: true },
  { value: "linear-gradient(45deg, #84fab0, #8fd3f4)", gradient: true },
  { value: "#79E7D0" },
  { value: "#7AA2F7" },
]

function vibrate() {
  if (typeof navigator === "undefined") {
    return
  }
  if (navigator.vibrate) {
    navigator.vibrate(50)
  }
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.max(min, Math.min(max, value))
}

function parseHsla(value: string): { hue: number; opacity: number } | null {
  const raw = value.trim()
  const match = raw.match(/^hsla\(\s*(\d+(?:\.\d+)?)\s*,.*,\s*(\d+(?:\.\d+)?)\s*\)\s*$/i)
  if (!match) {
    return null
  }
  const hue = clampNumber(Number(match[1]), 0, 360)
  const alpha = clampNumber(Number(match[2]), 0, 1)
  return { hue, opacity: Math.round(alpha * 100) }
}

export const ArcColorPicker = ({
  selectedColor,
  setSelectedColor,
  grainIntensity,
  setGrainIntensity,
  className,
}: {
  selectedColor: string
  setSelectedColor: (color: string) => void
  grainIntensity: number
  setGrainIntensity: (intensity: number) => void
  className?: string
}) => {
  const [hue, setHue] = useState(0)
  const [opacity, setOpacity] = useState(100)
  const sliderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const parsed = parseHsla(selectedColor)
    if (!parsed) {
      return
    }
    setHue(parsed.hue)
    setOpacity(parsed.opacity)
  }, [selectedColor])

  const emitHslaColor = (nextHue: number, nextOpacity: number) => {
    setHue(nextHue)
    setOpacity(nextOpacity)
    setSelectedColor(`hsla(${nextHue}, 100%, 50%, ${nextOpacity / 100})`)
  }

  const handleColorSelect = (color: Color) => {
    setSelectedColor(color.value)
    vibrate()
  }

  const handleIntensityChange = (intensity: number) => {
    setGrainIntensity(intensity)
    vibrate()
  }

  const handleSliderMove = (event: MouseEvent | TouchEvent) => {
    if (!sliderRef.current) {
      return
    }
    const rect = sliderRef.current.getBoundingClientRect()
    const clientX =
      "touches" in event ? event.touches[0].clientX : event.clientX
    const clientY =
      "touches" in event ? event.touches[0].clientY : event.clientY
    const x = clampNumber((clientX - rect.left) / rect.width, 0, 1)
    const y = clampNumber((clientY - rect.top) / rect.height, 0, 1)
    const nextHue = Math.round(x * 360)
    const nextOpacity = Math.round((1 - y) * 100)
    emitHslaColor(nextHue, nextOpacity)
    vibrate()
  }

  return (
    <div
      className={cn(
        "w-full max-w-[420px] bg-white/80 dark:bg-neutral-900 backdrop-blur-xl rounded-3xl p-6 space-y-6 shadow-lg",
        className,
      )}
    >
      <PreviewColor selectedColor={selectedColor} intensity={grainIntensity} />

      {/* 二维滑块：横轴 hue，纵轴 opacity */}
      <div
        ref={sliderRef}
        className="h-48 relative cursor-crosshair rounded-md overflow-hidden"
        onMouseDown={(e) => {
          handleSliderMove(e.nativeEvent)
          const handleMouseMove = (e: MouseEvent) => handleSliderMove(e)
          const handleMouseUp = () => {
            document.removeEventListener("mousemove", handleMouseMove)
            document.removeEventListener("mouseup", handleMouseUp)
          }
          document.addEventListener("mousemove", handleMouseMove)
          document.addEventListener("mouseup", handleMouseUp)
        }}
        onTouchStart={(e) => {
          handleSliderMove(e.nativeEvent)
          const handleTouchMove = (e: TouchEvent) => handleSliderMove(e)
          const handleTouchEnd = () => {
            document.removeEventListener("touchmove", handleTouchMove)
            document.removeEventListener("touchend", handleTouchEnd)
          }
          document.addEventListener("touchmove", handleTouchMove)
          document.addEventListener("touchend", handleTouchEnd)
        }}
        aria-valuetext={`Hue: ${hue}, Opacity: ${opacity}%`}
        aria-valuemin={0}
        aria-valuemax={360}
        onKeyDown={(e) => {
          const step = 5
          switch (e.key) {
            case "ArrowLeft":
              emitHslaColor(clampNumber(hue - step, 0, 360), opacity)
              break
            case "ArrowRight":
              emitHslaColor(clampNumber(hue + step, 0, 360), opacity)
              break
            case "ArrowUp":
              emitHslaColor(hue, clampNumber(opacity + step, 0, 100))
              break
            case "ArrowDown":
              emitHslaColor(hue, clampNumber(opacity - step, 0, 100))
              break
            default:
              break
          }
        }}
      >
        <div
          className="absolute inset-0 border-4 border-white/50 dark:border-black/50"
          style={{
            backgroundImage:
              "linear-gradient(90deg, oklch(90% 0.10 0), oklch(90% 0.10 60), oklch(90% 0.10 120), oklch(90% 0.10 180), oklch(90% 0.10 240), oklch(90% 0.10 300), oklch(90% 0.10 360))",
            maskImage: "linear-gradient(to bottom, white, transparent)",
          }}
        />

        <DotsPattern
          className="absolute inset-0 text-neutral-400/20"
          width={8}
          height={8}
        />
        <StaticNoise
          opacity={grainIntensity / 100 / 2}
          backgroundSize="200px"
          className="inset-0 absolute mix-blend-screen dark:mix-blend-multiply z-20"
        />
        <div
          className="absolute w-4 h-4 border-2 border-white dark:border-black rounded-full shadow-lg transform -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${(hue / 360) * 100}%`, top: `${100 - opacity}%` }}
        />
      </div>

      <ColorSwatches
        handleColorSelect={handleColorSelect}
        selectedColor={selectedColor}
      />
      <GrainSlider
        intensity={grainIntensity}
        handleIntensityChange={handleIntensityChange}
      />
    </div>
  )
}

export const PreviewColor = ({
  selectedColor,
  intensity,
}: {
  selectedColor: string
  intensity: number
}) => {
  return (
    <div className="flex justify-center">
      <div className="relative size-16 rounded-full border-white dark:border-white/80 shadow-neutral-400/50 dark:shadow-none shadow-xl overflow-hidden border-4">
        <div className="size-full opacity-50 z-10" style={{ background: selectedColor }} />
        <StaticNoise
          opacity={intensity / 100}
          backgroundSize="150px"
          className="inset-0 absolute mix-blend-screen dark:mix-blend-multiply z-20"
        />
      </div>
    </div>
  )
}

const ColorSwatches = ({
  handleColorSelect,
  selectedColor,
}: {
  handleColorSelect: (color: Color) => void
  selectedColor: string
}) => {
  return (
    <div className="relative">
      <div className="flex justify-evenly w-full gap-2">
        {COLORS.map((color, index) => (
          <button
            type="button"
            key={`${index}-${color.value}`}
            onClick={() => handleColorSelect(color)}
            className={cn(
              "size-8 rounded-full transition-transform hover:scale-110",
              selectedColor === color.value
                ? "border-2 border-white shadow-lg"
                : "outline-transparent",
            )}
            style={{ background: color.value }}
          />
        ))}
      </div>
      {/* 预留扩展位：左右切换颜色页 */}
      <button
        type="button"
        className="absolute left-0 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
        disabled
      >
        <span className="sr-only">Previous colors</span>‹
      </button>
      <button
        type="button"
        className="absolute right-0 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
        disabled
      >
        <span className="sr-only">Next colors</span>›
      </button>
    </div>
  )
}

const GrainSlider = ({
  intensity,
  handleIntensityChange,
}: {
  intensity: number
  handleIntensityChange: (intensity: number) => void
}) => {
  return (
    <div className="relative h-12 flex items-center">
      <svg className="w-full h-8" viewBox="0 0 200 20">
        <title>Intensity</title>
        <path
          d="M0 10 Q 20 20, 40 10 T 80 10 T 120 10 T 160 10 T 200 10"
          fill="none"
          stroke="currentColor"
          className="text-neutral-300 dark:text-neutral-700"
          strokeWidth="2"
        />
      </svg>
      <input
        type="range"
        min="0"
        max="100"
        value={intensity}
        onChange={(e) => {
          handleIntensityChange(Number(e.target.value))
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
      <div
        className="absolute top-1/2 -translate-y-1/2 w-7 h-12 border-2 border-neutral-400/20 bg-white dark:bg-neutral-700 rounded-full shadow-lg transition-all pointer-events-none"
        style={{ left: `calc(${intensity}% - 16px)` }}
      />
    </div>
  )
}
