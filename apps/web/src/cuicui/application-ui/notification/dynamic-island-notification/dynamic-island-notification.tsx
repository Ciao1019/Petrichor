"use client"

import * as React from "react"
import { BellRing, X } from "lucide-react"

import { cn } from "@/lib/utils"

type DynamicIslandNotificationProps = {
  title: string
  showNotification: boolean
  closeNotification: () => void
  children: React.ReactNode
  onClick?: () => void
}

export default function DynamicIslandNotification({
  title,
  showNotification,
  closeNotification,
  children,
  onClick,
}: DynamicIslandNotificationProps) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed left-1/2 top-4 z-[120] w-[min(92vw,28rem)] -translate-x-1/2 transition-all duration-300",
        showNotification ? "translate-y-0 opacity-100" : "-translate-y-6 opacity-0"
      )}
      aria-hidden={!showNotification}
    >
      <div
        className={cn(
          "pointer-events-auto overflow-hidden rounded-full border border-white/10 bg-neutral-950 text-white shadow-2xl",
          onClick ? "cursor-pointer" : ""
        )}
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : -1}
        onKeyDown={(event) => {
          if (!onClick) return
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          onClick()
        }}
      >
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 rounded-full bg-white/10 p-2">
            <BellRing className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{title}</div>
            <div className="mt-1 line-clamp-2 text-xs text-white/75">{children}</div>
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            onClick={(event) => {
              event.stopPropagation()
              closeNotification()
            }}
            aria-label="关闭通知"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
