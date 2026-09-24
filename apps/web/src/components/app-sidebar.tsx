import * as React from "react"
import { ArrowLeft, IconBook, IconFolders, IconRobot, IconSettings, PencilLine } from "@/components/iconimate"
import { Link, useLocation } from "react-router-dom"

import { NavUser } from "@/components/nav-user"
import { NavContent } from "@/components/nav-content"
import { SiteLogo } from "@/components/site-logo"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar"
import { authApi, type UserResponse } from "@/lib/api"
import { dashboardRoutes, isDashboardSectionPath } from "@/lib/dashboard-routes"
import { getSettingsSections, isSettingsPath, type SettingsPage } from "@/lib/settings-navigation"

const mainNavigation = [
  { title: "随笔", url: dashboardRoutes.inbox, icon: PencilLine, section: "inbox" },
  { title: "知识库", url: dashboardRoutes.knowledge, icon: IconBook, section: "knowledge" },
  { title: "文档库", url: dashboardRoutes.docLibrary, icon: IconFolders, section: "doc-library" },
  { title: "助手", url: dashboardRoutes.assistant, icon: IconRobot, section: "assistant" },
]

const WORKSPACE_PATH_KEY = "petrichor:last-workspace-path"

// 从设置返回时回到进入前的工作区页面；存储不可用或记录无效时回到随笔。
function readWorkspacePath() {
  try {
    const saved = window.sessionStorage.getItem(WORKSPACE_PATH_KEY)
    if (saved && saved.startsWith(`${dashboardRoutes.root}/`) && !isSettingsPath(saved)) return saved
  } catch { /* 隐私模式下使用默认入口。 */ }
  return dashboardRoutes.inbox
}

const toNavigation = (pages: SettingsPage[]) => pages.map((page) => ({ title: page.label, url: page.url, icon: page.icon }))

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const [user, setUser] = React.useState<UserResponse | null>(null)
  const [userLoaded, setUserLoaded] = React.useState(false)
  const { pathname, search } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobileMenu = () => { if (isMobile) setOpenMobile(false) }
  // 工作区与设置共用一条侧栏：进入任一设置页时切换为设置导航，避免两类入口混排。
  const settingsMode = isSettingsPath(pathname)
  const settingsSections = getSettingsSections(user?.systemRole)

  React.useEffect(() => {
    let cancelled = false
    authApi.me()
      .then((res) => { if (!cancelled) setUser(res.data) })
      .catch(() => { if (!cancelled) setUser(null) })
      .finally(() => { if (!cancelled) setUserLoaded(true) })
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    if (settingsMode) return
    try { window.sessionStorage.setItem(WORKSPACE_PATH_KEY, `${pathname}${search}`) } catch { /* 存储不可用时返回默认入口。 */ }
  }, [settingsMode, pathname, search])

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="py-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5 group-data-[collapsible=icon]:data-[slot=sidebar-menu-button]:!p-1"
              tooltip="Petrichor"
            >
              <Link to={dashboardRoutes.root} onClick={closeMobileMenu}>
                <SiteLogo className="size-6 shrink-0" />
                <span className="text-base font-semibold">Petrichor</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      {/* 模式切换即时生效：进入设置页会加载页面代码，入场动画易被阻塞而让导航短暂不可见。 */}
      <SidebarContent key={settingsMode ? "settings" : "workspace"}>
        {settingsMode ? (
          <>
            <SidebarGroup className="pb-0">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="返回工作区" className="h-9 text-sidebar-foreground/70 hover:text-sidebar-foreground">
                    <Link to={readWorkspacePath()} onClick={closeMobileMenu}>
                      <ArrowLeft />
                      <span>返回工作区</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            {settingsSections.map((section) => (
              <NavContent key={section.id} groupLabel={section.label} items={toNavigation(section.pages)} />
            ))}
            {!userLoaded && (
              <SidebarGroup aria-hidden="true">
                <SidebarMenuSkeleton showIcon />
                <SidebarMenuSkeleton showIcon />
              </SidebarGroup>
            )}
          </>
        ) : (
          <SidebarGroup>
            <nav aria-label="主导航">
              <SidebarMenu className="gap-1.5">
                {mainNavigation.map((item) => {
                  const active = isDashboardSectionPath(pathname, item.section)
                    || (item.section === "inbox" && pathname === dashboardRoutes.root)
                    || (item.section === "knowledge" && isDashboardSectionPath(pathname, "imports"))
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.title} className="h-10">
                        <Link to={item.url} aria-current={active ? "page" : undefined} onClick={closeMobileMenu}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        {!settingsMode && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="设置" className="h-10">
                <Link to={dashboardRoutes.settings} onClick={closeMobileMenu}>
                  <IconSettings />
                  <span>设置</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        {user ? <NavUser user={user} /> : !userLoaded ? <SidebarMenuSkeleton showIcon /> : null}
      </SidebarFooter>
    </Sidebar>
  )
}
