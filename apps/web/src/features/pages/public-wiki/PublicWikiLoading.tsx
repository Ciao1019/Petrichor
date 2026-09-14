export function PublicWikiLoading() {
  return (
    <div
      role="status"
      aria-label="Wiki 页面加载中"
      className="motion-safe:animate-pulse space-y-4 py-2"
    >
      {/* 卡片骨架列表 */}
      <div className="space-y-3 pt-2">
        {[1, 2, 3].map((index) => (
          <div
            key={index}
            className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5"
          >
            <div className="flex items-center gap-2">
              <div className="h-5 w-16 rounded-md bg-white/[0.07]" />
              <div className="h-4 w-24 rounded bg-white/[0.04]" />
            </div>
            <div className="mt-3.5 h-6 w-1/2 rounded bg-white/[0.08]" />
            <div className="mt-3 space-y-2">
              <div className="h-4 w-full rounded bg-white/[0.04]" />
              <div className="h-4 w-4/5 rounded bg-white/[0.03]" />
            </div>
            <div className="mt-4 flex items-center gap-4 pt-1">
              <div className="h-3.5 w-24 rounded bg-white/[0.04]" />
              <div className="h-3.5 w-20 rounded bg-white/[0.04]" />
              <div className="h-3.5 w-16 rounded bg-white/[0.04]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
