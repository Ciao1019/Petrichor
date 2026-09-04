export function RouteLoadingFallback({ silent = false }: { silent?: boolean }) {
  if (silent) {
    return <div className="min-h-[40vh] flex-1" aria-hidden="true" />
  }

  return (
    <div className="flex min-h-[40vh] flex-1 items-center justify-center px-4" role="status" aria-live="polite">
      <span className="text-sm text-muted-foreground motion-safe:animate-pulse">页面加载中…</span>
    </div>
  )
}
