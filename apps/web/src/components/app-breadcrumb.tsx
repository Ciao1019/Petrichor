import * as React from "react"
import { Bell, HomeIcon, Loader2 } from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { NotificationDropdown } from "@/components/notification/notification-dropdown"
import { DynamicIslandBridge } from "@/components/notification/dynamic-island-bridge"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { gsap } from "@/lib/gsap"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { notificationApi } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { emitNotificationRefresh, useNotificationCenter } from "@/hooks/use-notification-center"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { toast } from "sonner"

interface BreadcrumbItem {
  label: string
  href?: string
}

const routeMap: Record<string, BreadcrumbItem[]> = {
  [dashboardRoutes.root]: [{ label: "系统看板" }],
  [dashboardRoutes.account]: [{ label: "个人中心" }, { label: "账号资料" }],
  [dashboardRoutes.knowledge]: [{ label: "笔记管理" }, { label: "知识库" }],
  [dashboardRoutes.notifications]: [{ label: "系统消息" }, { label: "消息中心" }],
  [`${dashboardRoutes.knowledge}/articles`]: [{ label: "笔记管理" }, { label: "知识库", href: dashboardRoutes.knowledge }, { label: "文章列表" }],
  [`${dashboardRoutes.knowledge}/categories`]: [{ label: "笔记管理" }, { label: "知识库", href: dashboardRoutes.knowledge }, { label: "分类管理" }],
  [dashboardRoutes.aiConfig]: [{ label: "笔记管理" }, { label: "模型配置" }],
  [dashboardRoutes.qa]: [{ label: "笔记管理" }, { label: "文档问答" }],
  [dashboardRoutes.agentKeys]: [{ label: "Agent 集成" }, { label: "API Key 管理" }],
  [dashboardRoutes.agentLogs]: [{ label: "Agent 集成" }, { label: "调用日志" }],
  [dashboardRoutes.agentSkill]: [{ label: "Agent 集成" }, { label: "Skill 包" }],
  [dashboardRoutes.adminUsers]: [{ label: "系统管理" }, { label: "用户管理" }],
  [dashboardRoutes.adminAbout]: [{ label: "系统管理" }, { label: "关于我配置" }],
}

function resolveBreadcrumbItems(pathname: string): BreadcrumbItem[] | undefined {
  const matched = routeMap[pathname]
  if (matched) {
    return matched
  }

  if (new RegExp(`^${dashboardRoutes.knowledge}/[^/]+/articles/[^/]+/mindmap$`).test(pathname)) {
    return [
      { label: "笔记管理" },
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: "思维导图" },
    ]
  }

  if (new RegExp(`^${dashboardRoutes.knowledge}/[^/]+/articles/[^/]+$`).test(pathname)) {
    return [
      { label: "笔记管理" },
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: "文章编辑" },
    ]
  }

  if (new RegExp(`^${dashboardRoutes.knowledge}/[^/]+$`).test(pathname)) {
    return [
      { label: "笔记管理" },
      { label: "知识库", href: dashboardRoutes.knowledge },
      { label: "文章列表" },
    ]
  }

  return undefined
}

export function AppBreadcrumb() {
  const location = useLocation()
  const navigate = useNavigate()
  const items = resolveBreadcrumbItems(location.pathname) || [{ label: "首页" }]
  const {
    unreadCount,
    recentItems,
    loading,
    latestNotification,
    dismissLatestNotification,
    refresh,
  } = useNotificationCenter()

  const [actionLoading, setActionLoading] = React.useState<"all" | string | null>(null)
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

  const handleRead = React.useCallback(async (notificationId: string) => {
    setActionLoading(notificationId)
    try {
      await notificationApi.read({ notificationId })
      emitNotificationRefresh()
      await refresh()
    } catch (error) {
      toast.error(resolveAxiosErrorMessage(error, "标记消息已读失败"))
    } finally {
      setActionLoading((current) => (current === notificationId ? null : current))
    }
  }, [refresh])

  const handleMarkAllRead = React.useCallback(async () => {
    setActionLoading("all")
    try {
      await notificationApi.readAll({})
      emitNotificationRefresh()
      await refresh()
    } catch (error) {
      toast.error(resolveAxiosErrorMessage(error, "全部标记已读失败"))
    } finally {
      setActionLoading((current) => (current === "all" ? null : current))
    }
  }, [refresh])

  return (
    <>
      <header ref={headerRef} className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur-sm will-change-[height]">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-1 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList className="gap-1.5 text-sm">
              <BreadcrumbItem>
                <BreadcrumbLink asChild className="flex items-center text-muted-foreground hover:text-foreground transition-colors">
                  <Link to={dashboardRoutes.root}>
                    <HomeIcon className="size-3.5" />
                    <span className="sr-only">首页</span>
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              {items.map((item, index) => (
                <span key={index} className="contents">
                  <BreadcrumbSeparator className="text-muted-foreground/50" />
                  <BreadcrumbItem>
                    {index === items.length - 1 || !item.href ? (
                      <BreadcrumbPage className="text-foreground font-medium">{item.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild className="text-muted-foreground hover:text-foreground transition-colors">
                        <Link to={item.href}>{item.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </span>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        <div className="flex items-center gap-1 px-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <NotificationDropdown
                unreadCount={unreadCount}
                items={recentItems}
                loading={loading}
                onRead={(item) => void handleRead(item.id)}
                onMarkAllRead={() => void handleMarkAllRead()}
                onOpenNotifications={() => navigate(dashboardRoutes.notifications)}
                trigger={
                  <Button type="button" variant="ghost" size="icon" className="relative size-9 rounded-full">
                    <Bell className="size-4" />
                    {actionLoading === "all" ? (
                      <Loader2 className="absolute -right-1 -top-1 size-3 animate-spin text-muted-foreground" />
                    ) : null}
                    {unreadCount > 0 ? (
                      <Badge className="absolute -right-1.5 -top-1.5 min-w-4 h-4 justify-center rounded-full px-1 text-[10px] leading-none">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </Badge>
                    ) : null}
                    <span className="sr-only">消息中心</span>
                  </Button>
                }
              />
            </TooltipTrigger>
            <TooltipContent>消息中心</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <DynamicIslandBridge
        notification={latestNotification}
        onDismiss={dismissLatestNotification}
      />
    </>
  )
}
