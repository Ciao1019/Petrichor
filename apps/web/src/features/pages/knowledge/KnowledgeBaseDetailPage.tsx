"use client"

import * as React from "react"
import { ChevronDown, ChevronRight, CircleHelp, FileText, GitFork, Loader2, Settings2, Sparkles } from "lucide-react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { KnowledgeBaseDocumentsTab } from "@/features/pages/knowledge/KnowledgeBaseDocumentsTab"
import { KnowledgeBaseSettingsTab } from "@/features/pages/knowledge/KnowledgeBaseSettingsTab"
import { KnowledgeBaseWikiTab } from "@/features/pages/knowledge/KnowledgeBaseWikiTab"
import { rememberKnowledgeBaseCrumb } from "@/features/pages/knowledge/kb-recent"
import { knowledgeBaseApi, type KnowledgeBaseResponse } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"

type WorkspaceSection = "documents" | "wiki" | "links" | "settings"

function resolveError(error: unknown, fallback: string) {
  return (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : fallback)
}

function isWorkspaceSection(value: string | null): value is WorkspaceSection {
  return value === "documents" || value === "wiki" || value === "links" || value === "settings"
}

export function KnowledgeBaseDetailPage() {
  const { knowledgeBaseId } = useParams<{ knowledgeBaseId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const [knowledgeBase, setKnowledgeBase] = React.useState<KnowledgeBaseResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const requestedSection = searchParams.get("tab")
  const activeSection: WorkspaceSection = isWorkspaceSection(requestedSection) ? requestedSection : "documents"
  const requestedWikiPage = searchParams.get("wikiPage")

  const load = React.useCallback(async () => {
    if (!knowledgeBaseId) return
    setLoading(true)
    try {
      const response = await knowledgeBaseApi.detail(knowledgeBaseId)
      setKnowledgeBase(response.data)
      rememberKnowledgeBaseCrumb(response.data.id, response.data.name)
    } catch (error) {
      toast.error(resolveError(error, "加载知识库失败"))
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId])

  React.useEffect(() => {
    void load()
  }, [load])

  const switchSection = React.useCallback((section: WorkspaceSection) => {
    const next = new URLSearchParams(searchParams)
    next.set("tab", section)
    if (section !== "documents") {
      next.delete("documentId")
      next.delete("chunk")
    } else {
      next.delete("wikiPage")
    }
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const openWikiPage = React.useCallback((pageKey: string) => {
    const next = new URLSearchParams(searchParams)
    next.set("tab", "wiki")
    next.set("wikiPage", pageKey)
    next.delete("documentId")
    next.delete("chunk")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  if (!knowledgeBaseId) return null

  if (loading || !knowledgeBase) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {loading ? <><Loader2 className="mr-2 size-4 animate-spin" />正在加载知识库…</> : "知识库不存在"}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background px-4 pt-5 sm:px-6 lg:px-8 lg:pt-6">
      <header className="mx-auto flex w-full max-w-[1760px] shrink-0 flex-col gap-2 pb-5">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-lg font-semibold sm:text-xl">
            <SidebarTrigger className="mr-1 size-8 lg:hidden" />
            <Link to={dashboardRoutes.knowledge} className="shrink-0 text-muted-foreground transition-colors hover:text-primary">
              知识库
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
            <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted" title={knowledgeBase.name}>
              <span className="max-w-[38vw] truncate text-foreground sm:max-w-[320px]">{knowledgeBase.name}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
            <WorkspaceTab active={activeSection === "documents"} onClick={() => switchSection("documents")} icon={FileText}>文档</WorkspaceTab>
            <span className="text-muted-foreground/35">/</span>
            <WorkspaceTab active={activeSection === "wiki"} onClick={() => switchSection("wiki")} icon={Sparkles}>Wiki</WorkspaceTab>
            <span className="text-muted-foreground/35">/</span>
            <WorkspaceTab active={activeSection === "links"} onClick={() => switchSection("links")} icon={GitFork}>双链图</WorkspaceTab>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-8 rounded-full text-muted-foreground" aria-label="知识库信息">
                  <CircleHelp className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-72 leading-5">
                {knowledgeBase.documentCount} 个文件 · {knowledgeBase.wikiPageCount} 个 Wiki 页面 · {knowledgeBase.chunkStrategy} / {knowledgeBase.chunkSize}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={activeSection === "settings" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-9 rounded-full"
                  aria-label="知识库设置"
                  onClick={() => switchSection("settings")}
                >
                  <Settings2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>知识库设置</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {knowledgeBase.description || "支持点击或拖拽上传，多格式文件自动解析并切片，快速构建可检索的知识库"}
        </p>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-[1760px] flex-1 overflow-hidden">
        {activeSection === "documents" ? (
          <KnowledgeBaseDocumentsTab knowledgeBase={knowledgeBase} onChanged={load} />
        ) : activeSection === "wiki" || activeSection === "links" ? (
          <KnowledgeBaseWikiTab
            knowledgeBase={knowledgeBase}
            onChanged={load}
            mode={activeSection === "links" ? "links" : "browser"}
            selectedPageKey={requestedWikiPage}
            onOpenPage={openWikiPage}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pb-8">
            <KnowledgeBaseSettingsTab knowledgeBase={knowledgeBase} onSaved={load} />
          </div>
        )}
      </main>
    </div>
  )
}

function WorkspaceTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-base font-normal transition-colors hover:text-foreground sm:text-lg",
        active ? "font-semibold text-primary" : "text-muted-foreground",
      )}
      onClick={onClick}
    >
      <Icon className="size-4 sm:hidden" />
      {children}
    </button>
  )
}
