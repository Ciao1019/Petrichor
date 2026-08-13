"use client"

import * as React from "react"
import { BookOpenText, Box, ChevronRight, FileText, Folder, FolderOpen, Lightbulb } from "lucide-react"

import { cn } from "@/lib/utils"
import type { KnowledgeBaseWikiPageResponse } from "@/lib/api"
import type { WikiTreeNode } from "./tree"

export function wikiKindLabel(kind: string) {
    if (kind === "index") return "索引"
    if (kind === "summary") return "摘要"
    if (kind === "entity") return "实体"
    if (kind === "concept") return "概念"
    return kind
}

export function WikiKindIcon({ kind, className }: { kind: string; className?: string }) {
    const shared = cn("size-4 shrink-0", className)
    if (kind === "summary") return <FileText className={cn(shared, "text-sky-600")} />
    if (kind === "entity") return <Box className={cn(shared, "text-violet-600")} />
    if (kind === "concept") return <Lightbulb className={cn(shared, "text-amber-600")} />
    return <BookOpenText className={cn(shared, "text-primary")} />
}

/**
 * Wiki 左侧目录树。目录节点由页面的 categoryPath 推导，可展开折叠并显示子树页面数；
 * 叶子是页面，点击后在右侧展示正文。
 */
export function WikiDirectory({
    nodes,
    selectedPageKey,
    expandedFolders,
    onToggleFolder,
    onSelectPage,
}: {
    nodes: WikiTreeNode[]
    selectedPageKey?: string | null
    expandedFolders: ReadonlySet<string>
    onToggleFolder: (folderId: string) => void
    onSelectPage: (page: KnowledgeBaseWikiPageResponse) => void
}) {
    if (nodes.length === 0) {
        return <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的页面</p>
    }
    return (
        <nav className="space-y-0.5 pr-1">
            {nodes.map((node) => (
                <WikiDirectoryNode
                    key={node.type === "folder" ? `folder:${node.id}` : `page:${node.id}`}
                    node={node}
                    selectedPageKey={selectedPageKey}
                    expandedFolders={expandedFolders}
                    onToggleFolder={onToggleFolder}
                    onSelectPage={onSelectPage}
                />
            ))}
        </nav>
    )
}

function WikiDirectoryNode({
    node,
    selectedPageKey,
    expandedFolders,
    onToggleFolder,
    onSelectPage,
}: {
    node: WikiTreeNode
    selectedPageKey?: string | null
    expandedFolders: ReadonlySet<string>
    onToggleFolder: (folderId: string) => void
    onSelectPage: (page: KnowledgeBaseWikiPageResponse) => void
}) {
    // 每级缩进 12px，从目录名左侧起算，让层级关系一眼可见。
    const indent = { paddingLeft: `${node.depth * 12 + 8}px` }

    if (node.type === "page") {
        const active = selectedPageKey === node.page.pageKey
        return (
            <button
                type="button"
                style={indent}
                title={node.page.title}
                className={cn(
                    "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors",
                    active ? "bg-muted font-medium text-primary" : "hover:bg-muted/70",
                )}
                onClick={() => onSelectPage(node.page)}
            >
                <WikiKindIcon kind={node.page.kind} />
                <span className="min-w-0 flex-1 truncate">{node.page.title}</span>
            </button>
        )
    }

    const expanded = expandedFolders.has(node.id)
    return (
        <div>
            <button
                type="button"
                style={indent}
                title={node.name}
                aria-expanded={expanded}
                className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm font-medium transition-colors hover:bg-muted/70"
                onClick={() => onToggleFolder(node.id)}
            >
                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
                {expanded
                    ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{node.pageCount}</span>
            </button>
            {expanded ? (
                <div className="space-y-0.5">
                    {node.children.map((child) => (
                        <WikiDirectoryNode
                            key={child.type === "folder" ? `folder:${child.id}` : `page:${child.id}`}
                            node={child}
                            selectedPageKey={selectedPageKey}
                            expandedFolders={expandedFolders}
                            onToggleFolder={onToggleFolder}
                            onSelectPage={onSelectPage}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    )
}
