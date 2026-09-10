import { Suspense } from "react"
import { Outlet, useLocation } from "react-router-dom"

import { RouteLoadSuccessMarker } from "@/components/route-load-boundary"
import { PublicWikiLayout } from "./PublicWikiLayout"
import { PublicWikiLoading } from "./PublicWikiLoading"

export function PublicWikiRouteLayout() {
  const { pathname } = useLocation()

  return (
    <PublicWikiLayout>
      {/* 仅重置左侧正文；右侧标题、导航与页脚在 Wiki 路由间持续挂载。 */}
      <Suspense key={pathname} fallback={<PublicWikiLoading />}>
        <Outlet />
        <RouteLoadSuccessMarker />
      </Suspense>
    </PublicWikiLayout>
  )
}
