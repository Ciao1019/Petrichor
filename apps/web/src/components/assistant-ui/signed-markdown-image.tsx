"use client"

import * as React from "react"
import { defaultUrlTransform, type UrlTransform } from "react-markdown"

import { useSignedUrl } from "@/hooks/use-signed-url"
import { normalizeS4ObjectUrl } from "@/lib/s4-url"
import { cn } from "@/lib/utils"

const STORAGE_IMAGE_PATTERN = /^s4key:uploads\/\d+\/.+\.(png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#].*)?$/i

type SignedMarkdownImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  node?: unknown
}

export const storageMarkdownUrlTransform: UrlTransform = (url, key) => {
  if (key === "src") {
    const normalized = normalizeS4ObjectUrl(url)
    if (normalized && STORAGE_IMAGE_PATTERN.test(normalized)) {
      return url
    }
  }
  return defaultUrlTransform(url)
}

export const SignedMarkdownImage: React.FC<SignedMarkdownImageProps> = ({
  node,
  src,
  alt,
  className,
  loading,
  ...props
}) => {
  void node
  const rawSrc = typeof src === "string" ? src : undefined
  const normalizedStorageUrl = React.useMemo(() => normalizeS4ObjectUrl(rawSrc), [rawSrc])
  const effectiveSrc = normalizedStorageUrl ?? rawSrc
  const signedSrc = useSignedUrl(effectiveSrc)
  const isStorageImage = normalizedStorageUrl != null

  if (!effectiveSrc) return null

  if (isStorageImage && !signedSrc) {
    return (
      <span
        className={cn(
          "my-3 inline-flex min-h-28 w-full items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/40 px-4 py-6 text-sm text-muted-foreground",
          className,
        )}
        role="status"
      >
        图片加载中...
      </span>
    )
  }

  return (
    <img
      {...props}
      src={signedSrc ?? effectiveSrc}
      alt={alt ?? ""}
      loading={loading ?? "lazy"}
      className={cn(
        "my-3 max-w-full rounded-lg border border-border/60 shadow-sm",
        className,
      )}
    />
  )
}
