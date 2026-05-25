import * as React from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type Card08Props = {
  title: React.ReactNode
  description?: React.ReactNode
  className?: string
  contentClassName?: string
  children?: React.ReactNode
}

export function Card08({ title, description, className, contentClassName, children }: Card08Props) {
  return (
    <Card
      className={cn(
        "gap-0 border-primary/20 bg-gradient-to-br from-primary/15 via-primary/5 to-background",
        className
      )}
    >
      <CardHeader className="space-y-2 pb-3">
        <CardTitle className="text-xl leading-tight">{title}</CardTitle>
        {description ? <p className="text-sm text-muted-foreground leading-6">{description}</p> : null}
      </CardHeader>
      <CardContent className={cn("pt-0", contentClassName)}>{children}</CardContent>
    </Card>
  )
}

export default Card08
