"use client"

import * as React from "react"
import { Copy } from "@/components/iconimate"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { copyToClipboard } from "./agent-shared"

// Agent 集成四个页面共用的展示组件，保持视觉一致。

export function AgentPageHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function AgentStepList({
  steps,
}: {
  steps: Array<{ title: React.ReactNode; description?: React.ReactNode }>
}) {
  return (
    <ol>
      {steps.map((step, index) => (
        <li key={index} className="relative flex gap-3 pb-5 last:pb-0">
          {index < steps.length - 1 ? (
            <span className="absolute left-[11px] top-7 h-[calc(100%-1.75rem)] w-px bg-border" aria-hidden />
          ) : null}
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-[11px] font-semibold text-muted-foreground">
            {index + 1}
          </span>
          <div className="min-w-0 space-y-0.5 pt-0.5">
            <div className="text-sm font-medium leading-tight">{step.title}</div>
            {step.description ? (
              <div className="text-xs leading-relaxed text-muted-foreground">{step.description}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

export function AgentCopyRow({
  label,
  value,
  hint,
  actions,
  className,
}: {
  label: string
  value: string
  hint?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("rounded-lg border bg-muted/30 p-3", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="break-all font-mono text-sm">{value}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyToClipboard(value, label)}
          >
            <Copy className="mr-2 size-4" />
            复制
          </Button>
          {actions}
        </div>
      </div>
      {hint ? <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

export function AgentToolChips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
        >
          {item}
        </span>
      ))}
    </div>
  )
}

export function AgentScopeBadge({ scope }: { scope: string }) {
  return (
    <Badge variant="outline" className="border-primary/25 bg-primary/5 font-mono text-[11px] font-normal text-primary">
      {scope}
    </Badge>
  )
}
