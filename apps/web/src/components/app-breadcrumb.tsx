import * as React from "react"
import { HomeIcon } from "@/components/iconimate"
import { Link, useLocation } from "react-router-dom"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { gsap } from "@/lib/gsap"
import { Separator } from "@/components/ui/separator"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { getSettingsSection } from "@/lib/settings-navigation"
import { getKnowledgeBaseCrumbName } from "@/features/pages/knowledge/kb-recent"

interface BreadcrumbItem {
  label: string
  href?: string
}

const routeMap: Record<string, BreadcrumbItem[]> = {
  [dashboardRoutes.root]: [{ label: "随笔" }],
  [dashboardRoutes.inbox]: [{ label: "随笔" }],
  [dashboardRoutes.knowledge]: [{ label: "知识库" }],
  [dashboardRoutes.imports]: [{ label: "知识库", href: dashboardRoutes.knowledge }, { label: "导入任务" }],
  [dashboardRoutes.wiki]: [{ label: "知识 Wiki" }],
  [`${dashboardRoutes.knowledge}/articles`]: [{ label: "知识库", href: dashboardRoutes.knowledge }, { label: "文章列表" }],
  [`${dashboardRoutes.knowledge}/categories`]: [{ label: "知识库", href: dashboardRoutes.knowledge }, { label: "分类管理" }],
  [dashboardRoutes.assistant]: [{ label: "助手" }],
}

function resolveBreadcrumbItems(pathname: string): BreadcrumbItem[] | undefined {
  const section = getSettingsSection(pathname)
  const settingsPage = section?.pages.find((page) => page.url === pathname)
  if (section && settingsPage) {
    // 与侧栏设置分组保持一致：「分组 / 页面」。
    return [{ label: section.label }, { label: settingsPage.label }]
  }
  const matched = routeMap[pathname]
  if (matched) {
    return matched
  }

  if (new RegExp(`^${dashboardRoutes.knowledge}/[^/]+/articles/[^/]+/mindmap$`).test(pathname)) {
    return [
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: "思维导图" },
    ]
  }

  if (new RegExp(`^${dashboardRoutes.knowledge}/[^/]+/articles/[^/]+$`).test(pathname)) {
    return [
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: "文章编辑" },
    ]
  }

  if (new RegExp(`^${dashboardRoutes.imports}/[^/]+$`).test(pathname)) {
    return [
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: "导入任务", href: dashboardRoutes.imports },
      { label: "任务详情" },
    ]
  }

  if (new RegExp(`^${dashboardRoutes.knowledge}/[^/]+/imports$`).test(pathname)) {
    return [
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: "导入任务", href: dashboardRoutes.imports },
      { label: "知识库任务" },
    ]
  }

  const knowledgeBaseMatch = pathname.match(new RegExp(`^${dashboardRoutes.knowledge}/([^/]+)$`))
  if (knowledgeBaseMatch?.[1]) {
    const kbId = knowledgeBaseMatch[1]
    const kbName = getKnowledgeBaseCrumbName(kbId)
    return [
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: kbName || "浏览" },
    ]
  }

  return undefined
}

export function AppBreadcrumb() {
  const location = useLocation()
  // 知识库详情异步写入名称后刷新末级面包屑
  const [kbCrumbTick, setKbCrumbTick] = React.useState(0)
  React.useEffect(() => {
    const onCrumb = () => setKbCrumbTick((n) => n + 1)
    window.addEventListener("petrichor:kb-crumb", onCrumb)
    return () => window.removeEventListener("petrichor:kb-crumb", onCrumb)
  }, [])
  const items = React.useMemo(() => {
    void kbCrumbTick // 事件只负责让 localStorage 中的知识库名称重新参与计算。
    return resolveBreadcrumbItems(location.pathname) || [{ label: "首页" }]
  },
    [location.pathname, kbCrumbTick],
  )
  // GSAP 接管 header 高度过渡（替代 transition-[width,height]）
  const { state: sidebarState } = useSidebar()
  const headerRef = React.useRef<HTMLElement | null>(null)
  const headerMountedRef = React.useRef(false)
  React.useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const target = sidebarState === "collapsed" ? "3rem" : "3.5rem"
    if (!headerMountedRef.current) {
      headerMountedRef.current = true
      gsap.set(el, { height: target })
      return
    }
    const tween = gsap.to(el, {
      height: target,
      duration: 0.55,
      ease: "expo.inOut",
      overwrite: "auto",
    })
    return () => {
      tween.kill()
    }
  }, [sidebarState])

  return (
    <header ref={headerRef} className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur-sm will-change-[height]">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mr-1 data-[orientation=vertical]:h-4"
        />
        <Breadcrumb className="min-w-0 overflow-hidden">
          <BreadcrumbList className="flex-nowrap gap-1.5 text-sm">
            <BreadcrumbItem className="shrink-0">
              <BreadcrumbLink asChild className="flex items-center text-muted-foreground hover:text-foreground transition-colors">
                <Link to={dashboardRoutes.root}>
                  <HomeIcon className="size-3.5" />
                  <span className="sr-only">首页</span>
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {items.map((item, index) => {
              const isLast = index === items.length - 1
              // 手机端只保留末级，避免长链路撑破顶栏
              const hideOnMobile = items.length > 1 && !isLast
              return (
                <span
                  key={index}
                  className={hideOnMobile ? "hidden sm:contents" : "contents"}
                >
                  <BreadcrumbSeparator className="shrink-0 text-muted-foreground/50" />
                  <BreadcrumbItem className="min-w-0">
                    {isLast || !item.href ? (
                      <BreadcrumbPage className="block max-w-[42vw] truncate text-foreground font-medium sm:max-w-[min(28rem,40vw)] md:max-w-none">
                        {item.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild className="text-muted-foreground hover:text-foreground transition-colors">
                        <Link to={item.href}>{item.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </span>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  )
}
