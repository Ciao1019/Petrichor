import * as React from "react"
import { Outlet, useLocation } from "react-router-dom"

// 设置入口统一放在全局侧栏，页面只承载当前内容。
export function SettingsLayout() {
  const { pathname } = useLocation()
  const contentRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" })
    window.scrollTo({ top: 0, behavior: "instant" })
  }, [pathname])

  return (
    <div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
      <Outlet />
    </div>
  )
}
