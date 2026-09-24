import * as React from "react"

const PlateMarkdownPreview = React.lazy(() => import("@/components/plate/PlateMarkdownPreview").then((module) => ({ default: module.PlateMarkdownPreview })))

// 与文章详情共用渲染器，保留表格、颜色、媒体和批注；旧随笔自动回退到 Markdown。
export function InboxMarkdown({ content, contentJson, contentMetaJson }: { content: string; contentJson?: string | null; contentMetaJson?: string | null }) {
  return (
    <React.Suspense fallback={<p className="whitespace-pre-wrap break-words text-sm leading-7">{content}</p>}>
      <PlateMarkdownPreview markdown={content} contentJson={contentJson} contentMetaJson={contentMetaJson}
        className="min-w-0 overflow-x-auto [overflow-wrap:anywhere] [&_.plate-article-content]:text-sm [&_.plate-article-content]:leading-7 [&_img]:max-h-80 [&_img]:object-contain" />
    </React.Suspense>
  )
}
