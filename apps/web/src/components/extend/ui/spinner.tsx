import type React from "react"
import { Loading03Icon } from "@/components/iconimate"
import { HugeiconsIcon } from "@/components/iconimate"

import { cn } from "@/components/extend/lib/utils"

export function Spinner({
  className,
  ...props
}: Omit<
  React.ComponentProps<typeof HugeiconsIcon>,
  "icon"
>): React.ReactElement {
  return (
    <HugeiconsIcon
      aria-label="Loading"
      className={cn("animate-spin", className)}
      icon={Loading03Icon}
      role="status"
      {...props}
    />
  )
}
