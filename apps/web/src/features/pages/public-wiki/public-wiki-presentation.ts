import type { ComponentType } from "react"
import { BookOpen, CheckCircle2, GitForkIcon, Sparkles, Tags } from "@/components/iconimate"

export const wikiKindConfig: Record<string, { label: string; badgeClass: string; icon: ComponentType<{ className?: string }> }> = {
  concept: {
    label: "概念",
    badgeClass: "border-indigo-400/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
    icon: Sparkles,
  },
  entity: {
    label: "实体",
    badgeClass: "border-amber-400/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: Tags,
  },
  source: {
    label: "来源摘要",
    badgeClass: "border-emerald-400/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: BookOpen,
  },
  comparison: {
    label: "对比",
    badgeClass: "border-purple-400/25 bg-purple-500/10 text-purple-700 dark:text-purple-300",
    icon: GitForkIcon,
  },
  answer: {
    label: "答案",
    badgeClass: "border-sky-400/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    icon: CheckCircle2,
  },
}

export function formatWikiDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}
