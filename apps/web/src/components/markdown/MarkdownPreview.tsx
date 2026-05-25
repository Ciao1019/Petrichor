import ReactMarkdown from "react-markdown"
import type { ComponentProps } from "react"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import rehypeSanitize from "rehype-sanitize"
import rehypeSlug from "rehype-slug"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"
import {
  createMarkdownComponents,
  type MarkdownPreviewVariant,
} from "@/components/markdown/markdown-preview-components"

type ElementContent = Record<string, unknown>

type MarkdownPreviewProps = {
  value: string
  className?: string
  variant?: MarkdownPreviewVariant
  enableHeadingAnchor?: boolean
}

const HEADING_ANCHOR_ICON: ElementContent = {
  type: "element",
  tagName: "svg",
  properties: {
    viewBox: "0 0 24 24",
    fill: "currentColor",
    ariaHidden: "true",
  },
  children: [
    {
      type: "element",
      tagName: "path",
      properties: {
        d: "M2.6 21.4c2 2 5.9 2.9 8.9 0l3.5-3.5-1-1-3.5 3.5c-1.4 1.4-4.2 1.9-6.4-.3s-1.8-5-.3-6.4l3.5-3.5-1-1-3.5 3.5c-3 3-2 6.9 0 8.9ZM21.4 2.6c2 2 2.9 5.9 0 8.9L17.9 15l-1-1 3.5-3.5c1.4-1.4 1.9-4.2-.3-6.4s-5-1.8-6.4-.3l-3.5 3.5-1-1 3.5-3.5c3-3 6.9-2 8.9 0Z",
      },
      children: [],
    },
    {
      type: "element",
      tagName: "path",
      properties: {
        d: "m8.01 14.97 6.93-6.93 1.061 1.06-6.93 6.93z",
      },
      children: [],
    },
  ],
}

type RehypePluginList = NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>

function buildRehypePlugins(enableHeadingAnchor: boolean) {
  const plugins: RehypePluginList = [rehypeSanitize, rehypeSlug]
  if (enableHeadingAnchor) {
    plugins.push([
      rehypeAutolinkHeadings,
      {
        behavior: "append",
        test: ["h1", "h2", "h3", "h4"],
        properties: {
          ariaHidden: "true",
          tabIndex: -1,
          className: ["heading-anchor-link"],
        },
        content: [HEADING_ANCHOR_ICON],
      },
    ])
  }
  return plugins
}

export function MarkdownPreview({
  value,
  className,
  variant = "default",
  enableHeadingAnchor = false,
}: MarkdownPreviewProps) {
  const components = createMarkdownComponents(variant)
  const rehypePlugins = buildRehypePlugins(enableHeadingAnchor)
  const wrapperClassName =
    variant === "heti"
      ? "heti"
      : variant === "typography"
        ? "md-typography text-[15px] text-foreground/95"
        : "text-[15px] leading-7 text-foreground/95"

  return (
    <div className={cn(wrapperClassName, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={components}>
        {value || ""}
      </ReactMarkdown>
    </div>
  )
}
