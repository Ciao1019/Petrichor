import { Component, useEffect, type ErrorInfo, type ReactNode } from "react"

const ROUTE_RELOAD_KEY_PREFIX = "petrichor:route-module-reload:"
const ROUTE_RELOAD_COOLDOWN_MS = 30_000

type RouteLoadErrorBoundaryProps = {
  children: ReactNode
  resetKey: string
}

type RouteLoadErrorBoundaryState = {
  error: unknown
}

export function isRouteModuleLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return [
    "Failed to fetch dynamically imported module",
    "Importing a module script failed",
    "error loading dynamically imported module",
    "ChunkLoadError",
    "Loading chunk",
  ].some((pattern) => message.includes(pattern))
}

function routeReloadStorageKey(pathname: string) {
  return `${ROUTE_RELOAD_KEY_PREFIX}${pathname}`
}

function tryScheduleRouteReload(error: unknown): boolean {
  if (!isRouteModuleLoadError(error) || typeof window === "undefined") return false

  const storageKey = routeReloadStorageKey(window.location.pathname)
  const now = Date.now()
  try {
    const previous = Number.parseInt(window.sessionStorage.getItem(storageKey) || "0", 10)
    if (Number.isFinite(previous) && previous > 0 && now - previous < ROUTE_RELOAD_COOLDOWN_MS) {
      return false
    }
    window.sessionStorage.setItem(storageKey, String(now))
  } catch {
    // 无法记录冷却时间时不自动刷新，避免在受限浏览器里形成刷新循环。
    return false
  }

  window.location.reload()
  return true
}

export class RouteLoadErrorBoundary extends Component<
  RouteLoadErrorBoundaryProps,
  RouteLoadErrorBoundaryState
> {
  override state: RouteLoadErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): RouteLoadErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    if (!tryScheduleRouteReload(error)) {
      console.error("[route-load] 页面模块加载失败", error, errorInfo)
    }
  }

  override componentDidUpdate(previousProps: RouteLoadErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  override render() {
    if (this.state.error === null) return this.props.children

    const isModuleError = isRouteModuleLoadError(this.state.error)
    return (
      <div className="flex min-h-[40vh] flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center shadow-sm" role="alert">
          <h2 className="text-base font-semibold">
            {isModuleError ? "页面模块加载失败" : "页面运行时发生错误"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {isModuleError
              ? "开发服务器依赖缓存可能刚刚更新。刷新页面通常即可恢复。"
              : "当前页面无法继续渲染，请刷新后重试。"}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => window.location.reload()}
            >
              刷新页面
            </button>
            <button
              type="button"
              className="rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => window.location.assign("/dashboard")}
            >
              返回工作台
            </button>
          </div>
        </div>
      </div>
    )
  }
}

// 必须放在对应 Suspense 内：只有 lazy 路由真正加载成功后才清除自动刷新标记。
export function RouteLoadSuccessMarker() {
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.sessionStorage.removeItem(routeReloadStorageKey(window.location.pathname))
    } catch {
      // sessionStorage 不可用不影响页面。
    }
  }, [])

  return null
}
