"use client"

import * as React from "react"
import { FileUp } from "@/components/iconimate"

import { useSignedUrl } from "@/hooks/use-signed-url"
import { normalizeS4ObjectKey, normalizeS4ObjectUrl } from "@/lib/s4-url"
import { cn } from "@/lib/utils"
import {
  protectedMediaContainerProps,
  protectedVideoProps,
} from "@/components/ui/protected-media"

// 清理 remarkVideo 转换后残留的孤立媒体闭合标签（</file> / </video> / </audio>）。
// 成对标签（<file ...></file>）在表格单元格等 inline 语境会被 Markdown 拆成多个节点，
// 开标签被转成组件，闭标签则可能作为字面文本残留，这里统一抹掉。须在 remarkVideo 之后运行。
const DANGLING_MEDIA_CLOSE_TAG = /<\/(?:file|video|audio)>/gi
export function remarkStripDanglingMediaTags() {
  return (tree: unknown) => {
    const stack: Array<Record<string, unknown>> = [tree as Record<string, unknown>]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node || typeof node !== "object") continue
      if (typeof node.value === "string" && (node.type === "text" || node.type === "html")) {
        const stripped = node.value.replace(DANGLING_MEDIA_CLOSE_TAG, "")
        if (stripped !== node.value) {
          node.value = stripped
          if (node.type === "html") node.type = "text"
        }
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) stack.push(child as Record<string, unknown>)
      }
    }
  }
}

// 问答 Markdown 里媒体标签（<video>/<audio>/<file>）经 remark 转换后，
// 会把属性透传成组件 props。这里只取我们需要的字段，其余忽略避免落到 DOM。
type MediaMarkdownProps = {
  node?: unknown
  src?: unknown
  name?: unknown
  title?: unknown
  alt?: unknown
  children?: React.ReactNode
}

/** 将原始 src 解析为可用地址：s4key: 走签名，其它原样返回。 */
function useResolvedMediaSrc(rawSrc: unknown) {
  const src = typeof rawSrc === "string" ? rawSrc : undefined
  const normalizedStorageUrl = React.useMemo(() => normalizeS4ObjectUrl(src), [src])
  const effectiveSrc = normalizedStorageUrl ?? src
  const signedSrc = useSignedUrl(effectiveSrc)
  return {
    effectiveSrc,
    signedSrc,
    // s4key: 对象需要等签名 URL 就绪
    isStorage: normalizedStorageUrl != null,
  }
}

function MediaLoading({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "my-3 inline-flex min-h-12 w-full items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/40 px-4 py-4 text-sm text-muted-foreground",
        className,
      )}
      role="status"
    >
      {label}
    </span>
  )
}

/** 从对象地址/URL 推断文件名兜底（name 缺失时用）。 */
function deriveFileName(src: string | undefined): string {
  if (!src) return "附件"
  const objectKey = normalizeS4ObjectKey(src)
  const path = objectKey ?? src
  const lastSegment = path.split(/[?#]/)[0]?.split("/").pop() ?? ""
  if (!lastSegment) return "附件"
  try {
    return decodeURIComponent(lastSegment)
  } catch {
    return lastSegment
  }
}

/** 视频：跟文档编辑一致——可直接播放，带防盗链保护。 */
export const SignedMarkdownVideo: React.FC<MediaMarkdownProps> = ({
  node,
  src,
  children,
}) => {
  void node
  void children
  const { effectiveSrc, signedSrc, isStorage } = useResolvedMediaSrc(src)

  if (!effectiveSrc) return null
  if (isStorage && !signedSrc) {
    return <MediaLoading label="视频加载中..." />
  }

  return (
    <video
      {...protectedVideoProps}
      controls
      preload="metadata"
      src={signedSrc ?? effectiveSrc}
      className="my-3 max-w-full rounded-lg border border-border/60 shadow-sm"
    />
  )
}

/** 音频：可直接播放。 */
export const SignedMarkdownAudio: React.FC<MediaMarkdownProps> = ({
  node,
  src,
  children,
}) => {
  void node
  void children
  const { effectiveSrc, signedSrc, isStorage } = useResolvedMediaSrc(src)

  if (!effectiveSrc) return null
  if (isStorage && !signedSrc) {
    return <MediaLoading label="音频加载中..." />
  }

  return (
    <audio
      {...protectedMediaContainerProps}
      controls
      preload="metadata"
      src={signedSrc ?? effectiveSrc}
      className="my-3 w-full"
    />
  )
}

/** 文件：跟文档编辑一致——点击即下载（签名 URL）。 */
export const SignedMarkdownFile: React.FC<MediaMarkdownProps> = ({
  node,
  src,
  name,
  title,
  children,
}) => {
  void node
  void children
  const { effectiveSrc, signedSrc, isStorage } = useResolvedMediaSrc(src)

  const explicitName =
    (typeof name === "string" && name.trim()) ||
    (typeof title === "string" && title.trim()) ||
    undefined
  const fileName = explicitName ?? deriveFileName(effectiveSrc)

  if (!effectiveSrc) return null

  const isLoadingSignedUrl = isStorage && !signedSrc
  const href = signedSrc ?? effectiveSrc

  return (
    <a
      className={cn(
        "group my-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm font-medium text-foreground no-underline shadow-sm transition-colors hover:bg-muted",
        isLoadingSignedUrl && "pointer-events-none opacity-60",
      )}
      href={isLoadingSignedUrl ? undefined : href}
      download={fileName}
      target="_blank"
      rel="noopener noreferrer"
      role="button"
      aria-disabled={isLoadingSignedUrl}
    >
      <FileUp className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{fileName}</span>
    </a>
  )
}
