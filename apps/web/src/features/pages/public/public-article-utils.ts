import type { MindElixirData } from "mind-elixir"
import type { TocItem } from "@/lib/markdown-toc"
export { buildToc, type TocItem } from "@/lib/markdown-toc"

const SCROLL_TO_BLOCK: ScrollLogicalPosition = "start"

export function buildFallbackMindmapData(title: string, toc: TocItem[]): MindElixirData {
  type TreeNode = { topic: string; root?: boolean; children?: TreeNode[] }
  const root: TreeNode = { topic: title || "文章", root: true, children: [] }
  const stack: Array<{ level: number; node: TreeNode }> = [{ level: 0, node: root }]

  for (const item of toc) {
    const node: TreeNode = { topic: item.text, children: [] }
    while (stack.length > 1 && stack[stack.length - 1].level >= item.level) {
      stack.pop()
    }
    stack[stack.length - 1].node.children?.push(node)
    stack.push({ level: item.level, node })
  }

  return { nodeData: root } as MindElixirData
}

function supportsReducedMotion(): boolean {
  if (typeof window === "undefined") return true
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function parsePx(value: string): number | null {
  const next = Number.parseFloat(value)
  return Number.isFinite(next) ? next : null
}

export function scrollToHeading(id: string): boolean {
  if (typeof window === "undefined") return false
  const el = document.getElementById(id)
  if (!el) return false

  try {
    window.history.replaceState(null, "", `#${id}`)
  } catch {
    // ignore
  }

  const behavior = supportsReducedMotion() ? "auto" : "smooth"
  const scrollMarginTop = parsePx(window.getComputedStyle(el).scrollMarginTop) ?? 0
  const absoluteTop = el.getBoundingClientRect().top + window.scrollY
  const targetTop = Math.max(0, absoluteTop - scrollMarginTop)

  if (SCROLL_TO_BLOCK === "start") {
    window.scrollTo({ top: targetTop, behavior })
  } else {
    el.scrollIntoView({ behavior, block: SCROLL_TO_BLOCK })
  }

  return true
}

export function safeOrigin(): string {
  if (typeof window === "undefined") return ""
  return window.location.origin
}

// 从 Markdown 正文中提取第一张图片的 URL
export function extractFirstImageUrl(contentMd: string): string | null {
  if (!contentMd) return null
  // 匹配标准 Markdown 图片：![alt](url) 或 ![alt](url "title")
  const mdMatch = contentMd.match(/!\[[^\]]*\]\(([^)\s"]+)/)
  if (mdMatch?.[1]) return mdMatch[1]
  // 匹配内联 HTML：<img src="url">
  const htmlMatch = contentMd.match(/<img[^>]+src=["']([^"']+)["']/)
  if (htmlMatch?.[1]) return htmlMatch[1]
  return null
}
