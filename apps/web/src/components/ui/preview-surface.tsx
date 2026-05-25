import * as React from "react"

import { cn } from "@/lib/utils"

type PreviewSurfaceProps = {
  children: React.ReactNode
  className?: string
}

export function PreviewSurface({ children, className }: PreviewSurfaceProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border border-neutral-500/10 bg-neutral-50/80 p-10",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.02),0_30px_120px_rgba(0,0,0,0.08)_inset]",
        "dark:border-white/10 dark:bg-neutral-950/90",
        "dark:shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_50px_160px_rgba(0,0,0,0.55)_inset]",
        className
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 opacity-30 mix-blend-overlay",
          "dark:opacity-25"
        )}
        style={{
          backgroundImage: "url(/noise.svg)",
          backgroundRepeat: "repeat",
        }}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0",
          "bg-[radial-gradient(circle_at_20%_0%,rgba(255,255,255,0.55),transparent_60%)]",
          "dark:bg-[radial-gradient(circle_at_20%_0%,rgba(255,255,255,0.12),transparent_55%)]"
        )}
      />
      <div className="relative">{children}</div>
    </div>
  )
}
