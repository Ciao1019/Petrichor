import * as React from "react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type InputGroupProps = React.HTMLAttributes<HTMLDivElement>

function InputGroup({ className, ...props }: InputGroupProps) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "border-input bg-background flex w-full flex-col rounded-2xl border p-2 shadow-xs",
        className
      )}
      {...props}
    />
  )
}

export type InputGroupAddonAlign = "block-start" | "center" | "block-end"

export type InputGroupAddonProps = React.HTMLAttributes<HTMLDivElement> & {
  align?: InputGroupAddonAlign
}

function InputGroupAddon({
  className,
  align = "center",
  ...props
}: InputGroupAddonProps) {
  return (
    <div
      data-slot="input-group-addon"
      className={cn(
        "flex w-full gap-1",
        align === "block-start" && "items-start",
        align === "center" && "items-center",
        align === "block-end" && "items-end",
        className
      )}
      {...props}
    />
  )
}

export type InputGroupTextareaProps = React.ComponentProps<typeof Textarea>

function InputGroupTextarea({ className, ...props }: InputGroupTextareaProps) {
  return (
    <Textarea
      data-slot="input-group-textarea"
      className={cn(
        "text-primary min-h-[44px] w-full resize-none border-0 bg-transparent px-3 py-2 shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        className
      )}
      rows={1}
      {...props}
    />
  )
}

export type InputGroupButtonProps = React.ComponentProps<typeof Button>

function InputGroupButton({ className, ...props }: InputGroupButtonProps) {
  return (
    <Button
      data-slot="input-group-button"
      className={cn("rounded-full", className)}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea }
