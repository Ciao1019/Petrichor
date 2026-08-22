"use client"

import { useState } from "react"
import { BookOpen, ExternalLink, Globe, Network, Brain, Wrench } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"
import type { EvidenceViewModel } from "@/features/agent-runs/types"

/**
 * 来源面板与来源卡片（§162.13~§162.16/§162.18）。
 *
 * 桌面端 hover 预览，移动端点开抽屉；内部来源可直接跳转到对应文章。
 */
export function AgentEvidencePanel({
    evidence,
    className,
}: {
    evidence: EvidenceViewModel[]
    className?: string
}) {
    const [open, setOpen] = useState(false)
    if (evidence.length === 0) return null

    const knowledge = evidence.filter((item) => item.source === "knowledge")
    const internal = evidence.filter((item) => item.source !== "web" && item.source !== "knowledge")
    const external = evidence.filter((item) => item.source === "web")

    return (
        <Drawer open={open} onOpenChange={setOpen}>
            <DrawerTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className={cn("h-7 gap-1.5 px-2 text-[12px] text-muted-foreground", className)}
                >
                    <BookOpen className="size-3.5" aria-hidden />
                    来源 {evidence.length}
                </Button>
            </DrawerTrigger>
            <DrawerContent className="max-h-[80vh]">
                <DrawerHeader className="pb-2">
                    <DrawerTitle className="text-base">回答依据</DrawerTitle>
                    <DrawerDescription>
                        共 {evidence.length} 条可追溯证据
                        {knowledge.length > 0 ? ` · 知识库章节 ${knowledge.length}` : ""}
                        {internal.length > 0 ? ` · 站内其他 ${internal.length}` : ""}
                        {external.length > 0 ? ` · 外部 ${external.length}` : ""}
                    </DrawerDescription>
                </DrawerHeader>
                <div className="overflow-y-auto px-4 pb-6">
                    <EvidenceGroup title="知识库章节" items={knowledge} numberedChapters />
                    <EvidenceGroup title="站内其他证据" items={internal} />
                    <EvidenceGroup title="外部来源" items={external} />
                </div>
            </DrawerContent>
        </Drawer>
    )
}

function EvidenceGroup({
    title,
    items,
    numberedChapters = false,
}: {
    title: string
    items: EvidenceViewModel[]
    numberedChapters?: boolean
}) {
    if (items.length === 0) return null
    return (
        <section className="mb-4">
            <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">{title}</h3>
            <ul className="flex flex-col gap-2">
                {items.map((item, index) => (
                    <li key={item.id}>
                        <AgentEvidenceCard
                            evidence={item}
                            chapterPosition={numberedChapters ? { index: index + 1, total: items.length } : undefined}
                        />
                    </li>
                ))}
            </ul>
        </section>
    )
}

export function AgentEvidenceCard({
    evidence,
    chapterPosition,
}: {
    evidence: EvidenceViewModel
    chapterPosition?: { index: number; total: number }
}) {
    const href = evidenceHref(evidence)
    return (
        <article className="rounded-md border border-border/60 bg-muted/20 p-3">
            <header className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
                    {evidence.citationIndex}
                </span>
                <EvidenceSourceIcon source={evidence.source} />
                <div className="min-w-0 flex-1">
                    {chapterPosition ? (
                        <p className="mb-0.5 text-[10px] font-medium tracking-wide text-primary/80 uppercase">
                            章节 {chapterPosition.index}/{chapterPosition.total}
                        </p>
                    ) : null}
                    <h4 className="text-[13px] font-medium wrap-break-word">{evidence.title}</h4>
                </div>
            </header>
            {evidence.path?.length ? (
                <p className="mt-1 text-[11px] text-muted-foreground wrap-break-word">
                    <span className="font-medium text-foreground/65">目录位置：</span>
                    {evidence.path.join(" / ")}
                </p>
            ) : null}
            {evidence.snippet ? (
                <div className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
                    <p className="text-[11px] font-medium text-foreground/65">命中内容：</p>
                    <p className="line-clamp-4">{evidence.snippet}</p>
                </div>
            ) : null}
            {href ? (
                <a
                    href={href}
                    target={evidence.source === "web" ? "_blank" : undefined}
                    rel={evidence.source === "web" ? "noreferrer noopener" : undefined}
                    className="mt-2 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
                >
                    {evidence.source === "web"
                        ? "打开来源"
                        : evidence.source === "knowledge" ? "查看本章节" : "查看原文"}
                    <ExternalLink className="size-3" aria-hidden />
                </a>
            ) : null}
        </article>
    )
}

/**
 * 答案里的引用角标（§162.17/§162.18）。
 * 桌面端 hover 预览，移动端点击打开来源。
 */
export function AgentCitation({ evidence }: { evidence: EvidenceViewModel }) {
    const href = evidenceHref(evidence)
    return (
        <HoverCard openDelay={120}>
            <HoverCardTrigger asChild>
                <a
                    href={href ?? "#"}
                    target={evidence.source === "web" ? "_blank" : undefined}
                    rel={evidence.source === "web" ? "noreferrer noopener" : undefined}
                    className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 align-super text-[10px] tabular-nums text-muted-foreground hover:bg-muted/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label={`来源 ${evidence.citationIndex}：${evidence.title}`}
                >
                    {evidence.citationIndex}
                </a>
            </HoverCardTrigger>
            <HoverCardContent className="w-80 p-0" align="start">
                <AgentEvidenceCard evidence={evidence} />
            </HoverCardContent>
        </HoverCard>
    )
}

function EvidenceSourceIcon({ source }: { source: EvidenceViewModel["source"] }) {
    const common = "mt-0.5 size-3.5 shrink-0 text-muted-foreground"
    switch (source) {
        case "web":
            return <Globe className={common} aria-label="外部来源" />
        case "graph":
            return <Network className={common} aria-label="知识图谱" />
        case "memory":
            return <Brain className={common} aria-label="长期记忆" />
        case "knowledge":
            return <BookOpen className={common} aria-label="知识库" />
        default:
            return <Wrench className={common} aria-label="工具结果" />
    }
}

export function evidenceHref(evidence: EvidenceViewModel): string | null {
    // 显式 url 优先：公开问答的证据指向文章公开页 /p/<shareCode>，
    // 不能按 kbId/articleId 拼后台路由
    if (evidence.url) return evidence.url
    if (evidence.knowledgeBaseId && evidence.articleId) {
        const params = new URLSearchParams()
        params.set("citeIndex", String(evidence.citationIndex))
        if (evidence.nodeKey) {
            params.set("citeSourceId", evidence.nodeKey)
            params.set("citeChunkId", evidence.nodeKey)
        }
        if (evidence.snippet) params.set("citeSnippet", evidence.snippet)
        const terms = Array.from(new Set(
            [evidence.title, ...(evidence.path ?? [])]
                .map((item) => item.trim())
                .filter(Boolean),
        ))
        if (terms.length > 0) params.set("citeTerms", terms.join("\n"))
        return `${knowledgeBaseArticlePath(evidence.knowledgeBaseId, evidence.articleId)}?${params.toString()}`
    }
    return null
}
