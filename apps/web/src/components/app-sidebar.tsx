import * as React from "react"
import {
  IconBook,
  IconHistory,
  IconKey,
  IconListDetails,
  IconMessageChatbot,
  IconPackage,
  IconPalette,
  IconSettings,
  IconSparkles,
  IconUserCircle,
  IconUsers,
} from "@tabler/icons-react"
import { Link, useLocation } from "react-router-dom"

import { NavContent } from "@/components/nav-content"
import { NavUser } from "@/components/nav-user"
import { SiteLogo } from "@/components/site-logo"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { authApi } from "@/lib/api"
import { dashboardRoutes, isDashboardSectionPath } from "@/lib/dashboard-routes"
import type { UserResponse } from "@/lib/api"

function matchKnowledgeList(pathname: string) {
  return pathname === dashboardRoutes.knowledge || isDashboardSectionPath(pathname, "knowledge")
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const [user, setUser] = React.useState<UserResponse | null>(null)
  const [userLoaded, setUserLoaded] = React.useState(false)
  const location = useLocation()

  const noteNav = React.useMemo(() => {
    const pathname = location.pathname
    return [
      {
        title: "知识库",
        url: dashboardRoutes.knowledge,
        icon: IconBook,
        isActive: isDashboardSectionPath(pathname, "knowledge"),
        items: [
          {
            title: "知识库列表",
            url: dashboardRoutes.knowledge,
            icon: IconListDetails,
            match: matchKnowledgeList,
          },
        ],
      },
      {
        title: "文档问答",
        url: dashboardRoutes.qa,
        icon: IconMessageChatbot,
        isActive: isDashboardSectionPath(pathname, "qa"),
      },
      {
        title: "AI 回顾",
        url: dashboardRoutes.aiReview,
        icon: IconSparkles,
        isActive: isDashboardSectionPath(pathname, "ai/review"),
      },
      {
        title: "模型配置",
        url: dashboardRoutes.aiConfig,
        icon: IconSettings,
        isActive: isDashboardSectionPath(pathname, "ai/config"),
      },
    ]
  }, [location.pathname])

  const agentNav = React.useMemo(() => {
    const pathname = location.pathname
    return [
      {
        title: "API Key 管理",
        url: dashboardRoutes.agentKeys,
        icon: IconKey,
        isActive: isDashboardSectionPath(pathname, "agent/keys"),
      },
      {
        title: "调用日志",
        url: dashboardRoutes.agentLogs,
        icon: IconHistory,
        isActive: isDashboardSectionPath(pathname, "agent/logs"),
      },
      {
        title: "Skill 包",
        url: dashboardRoutes.agentSkill,
        icon: IconPackage,
        isActive: isDashboardSectionPath(pathname, "agent/skill"),
      },
    ]
  }, [location.pathname])

  const systemNav = React.useMemo(() => {
    if (user?.systemRole !== "SUPER_ADMIN") {
      return []
    }
    return [
      {
        title: "用户管理",
        url: dashboardRoutes.adminUsers,
        icon: IconUsers,
        isActive: isDashboardSectionPath(location.pathname, "admin/users"),
      },
      {
        title: "关于我",
        url: dashboardRoutes.adminAbout,
        icon: IconUserCircle,
        isActive: isDashboardSectionPath(location.pathname, "admin/about"),
      },
      {
        title: "外观设置",
        url: dashboardRoutes.adminAppearance,
        icon: IconPalette,
        isActive: isDashboardSectionPath(location.pathname, "admin/appearance"),
      },
    ]
  }, [location.pathname, user?.systemRole])

  React.useEffect(() => {
    let cancelled = false

    authApi.me()
      .then((res) => {
        if (!cancelled) setUser(res.data)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setUserLoaded(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5 group-data-[collapsible=icon]:data-[slot=sidebar-menu-button]:!p-1"
              tooltip="Petrichor"
            >
              <Link to={dashboardRoutes.root}>
                <SiteLogo className="size-6 shrink-0" />
                <span className="text-base font-semibold">Petrichor</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {userLoaded ? (
          <>
            <NavContent groupLabel="笔记管理" items={noteNav} />
            <NavContent groupLabel="Agent 集成" items={agentNav} />
            {systemNav.length > 0 ? <NavContent groupLabel="系统管理" items={systemNav} /> : null}
          </>
        ) : (
          <SidebarNavSkeleton />
        )}
      </SidebarContent>
      <SidebarFooter>
        {user && <NavUser user={user} />}
      </SidebarFooter>
    </Sidebar>
  )
}

function SidebarNavSkeleton() {
  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel className="w-20 bg-sidebar-accent/50 text-transparent">
          加载中
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel className="w-20 bg-sidebar-accent/50 text-transparent">
          加载中
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}
