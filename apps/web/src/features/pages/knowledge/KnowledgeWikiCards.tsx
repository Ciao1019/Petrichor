import * as React from "react"

import { cn } from "@/lib/utils"
import type { KnowledgeBaseWikiTreeNode } from "@/lib/api"

/** PageIndex 式文档目录树。 */
export function WikiTreeOutline({ nodes }: { nodes: KnowledgeBaseWikiTreeNode[] }) {
  if (nodes.length === 0) {
    return <p className="text-xs text-muted-foreground">该文档暂无目录树节点，重新生成 Wiki 后会自动构建。</p>
  }
  return (
    <ul className="app-scrollbar max-h-[32vh] space-y-0.5 overflow-auto rounded-md border bg-muted/20 p-2">
      {nodes.map((node) => (
        <li
          key={node.nodeKey}
          className="rounded px-2 py-1 hover:bg-accent/60"
          style={{ paddingLeft: `${Math.min(node.depth, 6) * 14 + 8}px` }}
        >
          <div className="flex items-baseline gap-2">
            <span className={cn("truncate text-sm", node.depth === 0 ? "font-semibold" : "font-medium")}>
              {node.title}
            </span>
            {node.tokenEstimate > 0 ? (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">~{node.tokenEstimate} tok</span>
            ) : null}
          </div>
          {node.summary ? <p className="truncate text-xs text-muted-foreground">{node.summary}</p> : null}
        </li>
      ))}
    </ul>
  )
}

export function StatCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  detail: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm shadow-black/[0.02]">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-3.5" />
        </span>
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}
