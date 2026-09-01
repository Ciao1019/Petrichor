"use client"

/**
 * KnowledgeWikiActions 知识空间的动作条：导出、编译说明书与新鲜度提示。
 *
 * 这三件事都是「对整个知识库」而不是对某一页做的，所以放在页面列表之上、
 * 与左右两栏并列，而不是塞进详情面板。
 */

import * as React from "react"
import { Download, FileText, Loader2, TriangleAlert } from "@/components/iconimate"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  exportKnowledgeBaseSkillPack,
  exportKnowledgeBaseWikiBundle,
  knowledgeBaseWikiAgentApi,
  type KnowledgeBaseWikiExportFormat,
  type KnowledgeBaseWikiLintIssue,
} from "@/lib/api"
import { resolveApiErrorMessage } from "@/features/pages/assistant/assistant-message-utils"

/** 导出目标：前两个是 Wiki bundle 的两种链接风格，后两个是 Skill 包带不带源文档。 */
type ExportTarget = KnowledgeBaseWikiExportFormat | "skill" | "skill-with-sources"

const EXPORT_OPTIONS: Array<{ target: ExportTarget; label: string; hint: string }> = [
  { target: "okf", label: "OKF bundle", hint: "标准 Markdown 链接，供其他 Agent 消费" },
  { target: "obsidian", label: "Obsidian vault", hint: "保留 [[wikilink]]，解压即可用 Obsidian 打开" },
  { target: "skill", label: "Agent Skill 包", hint: "按引用度精选页面，装进 Claude Code / Codex 直接用" },
  { target: "skill-with-sources", label: "Agent Skill 包（含源文档）", hint: "额外带上源文档全文，体积更大但可直接引原文" },
]

const EXPORT_SUCCESS: Record<ExportTarget, string> = {
  okf: "已导出 OKF bundle",
  obsidian: "已导出 Obsidian vault",
  skill: "已导出 Agent Skill 包",
  "skill-with-sources": "已导出 Agent Skill 包（含源文档）",
}

/** 只提示需要重新编译的两类问题，结构类问题不在这个动作条的职责范围内。 */
const STALE_CODES = new Set(["stale_source", "outdated_build"])

export function KnowledgeWikiActions({
  knowledgeBaseId,
  pageCount,
}: {
  knowledgeBaseId: string
  /** 页面数为 0 时不做新鲜度检查，也没有可导出的内容 */
  pageCount: number
}) {
  const [exporting, setExporting] = React.useState(false)
  const [guideOpen, setGuideOpen] = React.useState(false)
  const [guideEnabled, setGuideEnabled] = React.useState(false)
  const [staleIssues, setStaleIssues] = React.useState<KnowledgeBaseWikiLintIssue[]>([])

  // 新鲜度只在页面列表就绪后查一次：它要读全部页面、链接和源文章，不适合跟着输入抖动重跑。
  React.useEffect(() => {
    if (pageCount === 0) {
      setStaleIssues([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await knowledgeBaseWikiAgentApi.lint(knowledgeBaseId)
        if (cancelled) return
        setStaleIssues(res.data.issues.filter((issue) => STALE_CODES.has(issue.code)))
      } catch {
        // 新鲜度只是提示，查不到就当作没有陈旧页，不打扰用户。
        if (!cancelled) setStaleIssues([])
      }
    })()
    return () => { cancelled = true }
  }, [knowledgeBaseId, pageCount])

  const runExport = React.useCallback(async (target: ExportTarget) => {
    if (typeof window === "undefined") return
    setExporting(true)
    let objectUrl: string | null = null
    try {
      const { blob, filename } = target === "skill" || target === "skill-with-sources"
        ? await exportKnowledgeBaseSkillPack({
          knowledgeBaseId,
          includeSources: target === "skill-with-sources",
        })
        : await exportKnowledgeBaseWikiBundle({ knowledgeBaseId, format: target })
      objectUrl = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      toast.success(EXPORT_SUCCESS[target])
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "导出失败"))
    } finally {
      if (objectUrl) window.URL.revokeObjectURL(objectUrl)
      setExporting(false)
    }
  }, [knowledgeBaseId])

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {staleIssues.length > 0 ? <StalePagesHint issues={staleIssues} /> : null}

      <Button
        size="sm"
        variant="outline"
        className="bg-background/70"
        onClick={() => setGuideOpen(true)}
        title="自定义这个知识库该抽什么、怎么归类、页面怎么写"
      >
        <FileText className="mr-1.5 size-3.5" />
        编译说明书
        {guideEnabled ? <Badge variant="secondary" className="ml-1.5 text-[10px]">已启用</Badge> : null}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="bg-background/70"
            disabled={exporting || pageCount === 0}
            title={pageCount === 0 ? "还没有可导出的知识页面" : "把整个知识库导出成一组带 frontmatter 的 Markdown 文件"}
          >
            <Download className={cnSpin(exporting)} />
            {exporting ? "导出中…" : "导出"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {EXPORT_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.target}
              className="flex-col items-start gap-0.5"
              onSelect={() => runExport(option.target)}
            >
              <span className="text-sm">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.hint}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <KnowledgeWikiGuideDialogLazy
        knowledgeBaseId={knowledgeBaseId}
        open={guideOpen}
        onOpenChange={setGuideOpen}
        onEnabledChange={setGuideEnabled}
      />
    </div>
  )
}

function cnSpin(spinning: boolean) {
  return spinning ? "mr-1.5 size-3.5 animate-spin" : "mr-1.5 size-3.5"
}

/** 陈旧页面提示：只报事实和影响范围，重新编译由文章列表的「构建知识」完成。 */
function StalePagesHint({ issues }: { issues: KnowledgeBaseWikiLintIssue[] }) {
  const preview = issues.slice(0, 8)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-3.5" />
          {issues.length} 页待重编译
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm">
        <p className="mb-1 font-medium">源文档已变更或编译流程已升级</p>
        <ul className="space-y-0.5">
          {preview.map((issue, index) => (
            <li key={`${issue.pageKey}-${index}`} className="text-xs">
              {issue.title || issue.pageKey}
            </li>
          ))}
        </ul>
        {issues.length > preview.length ? (
          <p className="mt-1 text-xs opacity-80">还有 {issues.length - preview.length} 页</p>
        ) : null}
        <p className="mt-1.5 text-xs opacity-80">回到文档列表，对相关文章重新执行「构建知识」即可对齐。</p>
      </TooltipContent>
    </Tooltip>
  )
}

/** 说明书弹窗按需加载：它带一个大文本域，不该拖慢知识空间首屏。 */
const KnowledgeWikiGuideDialogInner = React.lazy(() =>
  import("./KnowledgeWikiGuideDialog").then((module) => ({ default: module.KnowledgeWikiGuideDialog })),
)

function KnowledgeWikiGuideDialogLazy(props: {
  knowledgeBaseId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onEnabledChange: (enabled: boolean) => void
}) {
  if (!props.open) return null
  return (
    <React.Suspense fallback={<Loader2 className="size-4 animate-spin text-muted-foreground" />}>
      <KnowledgeWikiGuideDialogInner {...props} />
    </React.Suspense>
  )
}
