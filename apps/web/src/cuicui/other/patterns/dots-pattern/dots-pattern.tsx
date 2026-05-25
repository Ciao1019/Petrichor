"use client"

import * as React from "react"

import { cn } from "@/cuicui/utils/cn"

export function DotsPattern({
  width = 8,
  height = 8,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"svg"> & {
  width?: number
  height?: number
}) {
  const patternId = React.useId()

  return (
    <svg
      aria-hidden="true"
      className={cn("pointer-events-none", className)}
      {...props}
    >
      <defs>
        <pattern
          id={patternId}
          width={width}
          height={height}
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r="1" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}
