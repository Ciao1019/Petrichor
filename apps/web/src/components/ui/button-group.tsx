import * as React from "react"

import { cn } from "@/lib/utils"

export type ButtonGroupProps = React.HTMLAttributes<HTMLDivElement>
  & {
    orientation?: "horizontal" | "vertical"
  }

function ButtonGroup({
  className,
  orientation = "horizontal",
  ...props
}: ButtonGroupProps) {
  return (
    <div
      data-slot="button-group"
      aria-orientation={orientation}
      className={cn(
        "inline-flex overflow-hidden rounded-md border bg-background shadow-xs",
        orientation === "horizontal" ? "flex-row items-center" : "flex-col items-stretch",
        className
      )}
      {...props}
    />
  )
}

export type ButtonGroupTextProps = React.HTMLAttributes<HTMLSpanElement>

function ButtonGroupText({ className, ...props }: ButtonGroupTextProps) {
  return (
    <span
      data-slot="button-group-text"
      className={cn(
        "text-muted-foreground inline-flex items-center px-2 text-xs",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup, ButtonGroupText }
