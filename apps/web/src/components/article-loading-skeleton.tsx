import { cn } from "@/lib/utils"

/** 文章编辑页与公开 Wiki 共用的呼吸骨架屏。 */
export function ArticleLoadingSkeleton({
  className,
  showToolbar = true,
  label = "文章加载中",
}: {
  className?: string
  showToolbar?: boolean
  label?: string
}) {
  return (
    <div className={cn("w-full px-6 py-6 lg:px-10 motion-safe:animate-in motion-safe:fade-in-0 duration-300", className)} role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        {showToolbar ? (
          <div className="mb-8 flex items-center justify-between gap-4">
            <div className="h-3.5 w-32 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
            <div className="flex items-center gap-2">
              <div className="h-8 w-14 rounded-md bg-muted/60 motion-safe:animate-pulse" />
              <div className="h-8 w-14 rounded-md bg-muted/60 motion-safe:animate-pulse" />
              <div className="h-8 w-20 rounded-md bg-muted/60 motion-safe:animate-pulse" />
            </div>
          </div>
        ) : null}
        <div className="mb-3 h-9 w-2/5 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
        <div className="mb-8 flex items-center gap-2">
          <div className="h-5 w-16 rounded-full bg-muted/60 motion-safe:animate-pulse" />
          <div className="h-5 w-20 rounded-full bg-muted/60 motion-safe:animate-pulse" />
        </div>
        <div className="space-y-5 rounded-lg border bg-muted/10 px-8 py-8">
          <div className="h-3.5 w-full rounded-lg bg-muted/60 motion-safe:animate-pulse" />
          <div className="h-3.5 w-11/12 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
          <div className="h-3.5 w-4/5 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
          <div className="h-px w-full bg-muted/30" />
          <div className="h-3.5 w-full rounded-lg bg-muted/60 motion-safe:animate-pulse" />
          <div className="h-3.5 w-3/4 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
          <div className="h-3.5 w-5/6 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
          <div className="h-3.5 w-2/3 rounded-lg bg-muted/60 motion-safe:animate-pulse" />
        </div>
      </div>
    </div>
  )
}
