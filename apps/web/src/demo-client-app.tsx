"use client"

import { lazy, Suspense, useEffect, useRef } from "react"
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom"

import { AppBreadcrumb } from "@/components/app-breadcrumb"
import { AppSidebar } from "@/components/app-sidebar"
import { DemoModeBanner } from "@/components/demo-mode-banner"
import { RouteLoadErrorBoundary, RouteLoadSuccessMarker } from "@/components/route-load-boundary"
import { RouteLoadingFallback } from "@/components/route-loading-fallback"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { dashboardRoutes, isFixedViewportRoute } from "@/lib/dashboard-routes"
import { isPublicSitePath } from "@/lib/public-theme-routes"

/* 演示入口复用正式页面，仅由数据适配层替换后端请求，确保功能和视觉始终跟随主应用。 */
const AssistantChatPage = lazy(() =>
  import("@/features/pages/assistant/AssistantChatPage").then((module) => ({ default: module.AssistantChatPage })),
)
const KnowledgeBasePage = lazy(() =>
  import("@/features/pages/knowledge/KnowledgeBasePage").then((module) => ({ default: module.KnowledgeBasePage })),
)
const KnowledgeBaseTreePage = lazy(() =>
  import("@/features/pages/knowledge/KnowledgeBaseTreePage").then((module) => ({ default: module.KnowledgeBaseTreePage })),
)
const KnowledgeBaseArticleEditorPage = lazy(() =>
  import("@/features/pages/knowledge/KnowledgeBaseArticleEditorPage").then((module) => ({ default: module.KnowledgeBaseArticleEditorPage })),
)
const KnowledgeBaseArticleMindMapPage = lazy(() =>
  import("@/features/pages/knowledge/KnowledgeBaseArticleMindMapPage").then((module) => ({ default: module.KnowledgeBaseArticleMindMapPage })),
)
const DocumentImportJobsPage = lazy(() =>
  import("@/features/pages/knowledge/DocumentImportJobsPage").then((module) => ({ default: module.DocumentImportJobsPage })),
)
const DocumentImportJobDetailPage = lazy(() =>
  import("@/features/pages/knowledge/DocumentImportJobDetailPage").then((module) => ({ default: module.DocumentImportJobDetailPage })),
)
const DocLibraryListPage = lazy(() =>
  import("@/features/pages/doc-library/DocLibraryListPage").then((module) => ({ default: module.DocLibraryListPage })),
)
const DocLibraryBrowsePage = lazy(() =>
  import("@/features/pages/doc-library/DocLibraryBrowsePage").then((module) => ({ default: module.DocLibraryBrowsePage })),
)
const AiModelConfigPage = lazy(() =>
  import("@/features/pages/ai/AiModelConfigPage").then((module) => ({ default: module.AiModelConfigPage })),
)
const AgentKeysPage = lazy(() =>
  import("@/features/pages/agent/AgentKeysPage").then((module) => ({ default: module.AgentKeysPage })),
)
const AgentCallLogsPage = lazy(() =>
  import("@/features/pages/agent/AgentCallLogsPage").then((module) => ({ default: module.AgentCallLogsPage })),
)
const AgentMcpPage = lazy(() =>
  import("@/features/pages/agent/AgentMcpPage").then((module) => ({ default: module.AgentMcpPage })),
)
const AgentSkillPage = lazy(() =>
  import("@/features/pages/agent/AgentSkillPage").then((module) => ({ default: module.AgentSkillPage })),
)
const AgentDebugPage = lazy(() =>
  import("@/features/pages/agent-debug/AgentDebugPage").then((module) => ({ default: module.AgentDebugPage })),
)
const AccountPage = lazy(() =>
  import("@/features/pages/account/AccountPage").then((module) => ({ default: module.AccountPage })),
)
const NotificationPage = lazy(() =>
  import("@/features/pages/notification/NotificationPage").then((module) => ({ default: module.NotificationPage })),
)
const UserManagementPage = lazy(() =>
  import("@/features/pages/admin/UserManagementPage").then((module) => ({ default: module.UserManagementPage })),
)
const AboutProfileConfigPage = lazy(() =>
  import("@/features/pages/admin/AboutProfileConfigPage").then((module) => ({ default: module.AboutProfileConfigPage })),
)
const ProjectsConfigPage = lazy(() =>
  import("@/features/pages/admin/ProjectsConfigPage").then((module) => ({ default: module.ProjectsConfigPage })),
)
const SiteAppearanceConfigPage = lazy(() =>
  import("@/features/pages/admin/SiteAppearanceConfigPage").then((module) => ({ default: module.SiteAppearanceConfigPage })),
)
const SiteFilingConfigPage = lazy(() =>
  import("@/features/pages/admin/SiteFilingConfigPage").then((module) => ({ default: module.SiteFilingConfigPage })),
)
const DocumentImportDeadLettersPage = lazy(() =>
  import("@/features/pages/admin/DocumentImportDeadLettersPage").then((module) => ({ default: module.DocumentImportDeadLettersPage })),
)
const DashboardMetricsPage = lazy(() =>
  import("@/features/pages/dashboard/DashboardMetricsPage").then((module) => ({ default: module.DashboardMetricsPage })),
)
const BlogHomePage = lazy(() =>
  import("@/features/pages/blog/BlogHomePage").then((module) => ({ default: module.BlogHomePage })),
)
const TagsPage = lazy(() =>
  import("@/features/pages/blog/TagsPage").then((module) => ({ default: module.TagsPage })),
)
const PublicQaPage = lazy(() =>
  import("@/features/pages/ask/PublicQaPage").then((module) => ({ default: module.PublicQaPage })),
)
const PublicArticlePage = lazy(() =>
  import("@/features/pages/public/PublicArticlePage").then((module) => ({ default: module.PublicArticlePage })),
)
const AboutPage = lazy(() =>
  import("@/features/pages/about/AboutPage").then((module) => ({ default: module.AboutPage })),
)
const ProjectsPage = lazy(() =>
  import("@/features/pages/projects/ProjectsPage").then((module) => ({ default: module.ProjectsPage })),
)
const PetrichorPage = lazy(() =>
  import("@/features/pages/petrichor/PetrichorPage").then((module) => ({ default: module.PetrichorPage })),
)

function DemoDashboardLayout() {
  const location = useLocation()
  const viewportShellRef = useRef<HTMLDivElement>(null)
  const lockViewport = isFixedViewportRoute(location.pathname)

  useEffect(() => {
    if (!lockViewport) return
    const root = document.documentElement
    const shell = viewportShellRef.current
    const previousOverflow = root.style.overflow
    let animationFrame = 0
    let settleTimer = 0

    const syncViewportHeight = () => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => {
        if (!shell) return
        const viewport = window.visualViewport
        const viewportBottom = viewport ? viewport.height + viewport.pageTop : window.innerHeight
        shell.style.height = `${Math.round(viewportBottom)}px`
      })
    }
    const syncAfterFocusChange = () => {
      syncViewportHeight()
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(syncViewportHeight, 350)
    }

    root.style.overflow = "hidden"
    syncViewportHeight()
    window.addEventListener("resize", syncViewportHeight)
    window.visualViewport?.addEventListener("resize", syncViewportHeight)
    window.visualViewport?.addEventListener("scroll", syncViewportHeight)
    document.addEventListener("focusin", syncAfterFocusChange)
    document.addEventListener("focusout", syncAfterFocusChange)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(settleTimer)
      window.removeEventListener("resize", syncViewportHeight)
      window.visualViewport?.removeEventListener("resize", syncViewportHeight)
      window.visualViewport?.removeEventListener("scroll", syncViewportHeight)
      document.removeEventListener("focusin", syncAfterFocusChange)
      document.removeEventListener("focusout", syncAfterFocusChange)
      shell?.style.removeProperty("height")
      root.style.overflow = previousOverflow
    }
  }, [lockViewport])

  return (
    <SidebarProvider
      ref={viewportShellRef}
      className={lockViewport ? "h-dvh min-h-0 overflow-hidden" : undefined}
    >
      <AppSidebar variant="inset" />
      <SidebarInset>
        <AppBreadcrumb />
        <DemoModeBanner />
        <div className="flex min-h-0 flex-1 flex-col">
          <RouteLoadErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<RouteLoadingFallback />}>
              <Outlet />
              <RouteLoadSuccessMarker />
            </Suspense>
          </RouteLoadErrorBoundary>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function DemoRoutes() {
  const location = useLocation()
  const publicSite = isPublicSitePath(location.pathname)
  const forcedTheme = publicSite ? "dark" : undefined

  return (
    <ThemeProvider defaultTheme="system" forcedTheme={forcedTheme}>
      <TooltipProvider>
        <Toaster />
        <div style={{ position: "relative", minHeight: "100vh" }}>
          <RouteLoadErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<RouteLoadingFallback silent={publicSite} />}>
              <Routes>
                <Route path="/" element={<BlogHomePage />} />
                <Route path="/tags" element={<TagsPage />} />
                <Route path="/graph" element={<Navigate to="/" replace />} />
                <Route path="/ask" element={<PublicQaPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/petrichor" element={<PetrichorPage />} />
                <Route path="/search" element={<Navigate to="/" replace />} />
                <Route path="/wiki/*" element={<Navigate to="/" replace />} />
                <Route path="/p/:shareCode" element={<PublicArticlePage />} />
                <Route path="/demo" element={<Navigate to={dashboardRoutes.knowledge} replace />} />
                <Route path="/login" element={<Navigate to={dashboardRoutes.knowledge} replace />} />
                <Route path="/dashboard" element={<DemoDashboardLayout />}>
                  <Route index element={<Navigate to={dashboardRoutes.assistant} replace />} />
                  <Route path="assistant" element={<AssistantChatPage />} />
                  <Route path="metrics" element={<DashboardMetricsPage />} />
                  <Route path="account" element={<AccountPage />} />
                  <Route path="notifications" element={<NotificationPage />} />
                  <Route path="knowledge" element={<KnowledgeBasePage />} />
                  <Route path="knowledge/:knowledgeBaseId" element={<KnowledgeBaseTreePage />} />
                  <Route path="knowledge/:knowledgeBaseId/imports" element={<DocumentImportJobsPage />} />
                  <Route path="imports" element={<DocumentImportJobsPage />} />
                  <Route path="imports/:jobId" element={<DocumentImportJobDetailPage />} />
                  <Route path="doc-library" element={<DocLibraryListPage />} />
                  <Route path="doc-library/:libraryId" element={<DocLibraryBrowsePage />} />
                  <Route path="wiki" element={<Navigate to={dashboardRoutes.knowledge} replace />} />
                  <Route path="knowledge/:knowledgeBaseId/articles/:articleId" element={<KnowledgeBaseArticleEditorPage />} />
                  <Route path="knowledge/:knowledgeBaseId/articles/:articleId/mindmap" element={<KnowledgeBaseArticleMindMapPage />} />
                  <Route path="admin/users" element={<UserManagementPage />} />
                  <Route path="admin/about" element={<AboutProfileConfigPage />} />
                  <Route path="admin/projects" element={<ProjectsConfigPage />} />
                  <Route path="admin/appearance" element={<SiteAppearanceConfigPage />} />
                  <Route path="admin/filing" element={<SiteFilingConfigPage />} />
                  <Route path="admin/site-graph" element={<Navigate to={dashboardRoutes.adminAppearance} replace />} />
                  <Route path="admin/document-import-dead-letters" element={<DocumentImportDeadLettersPage />} />
                  <Route path="ai/config" element={<AiModelConfigPage />} />
                  <Route path="agent" element={<AgentKeysPage />} />
                  <Route path="agent/keys" element={<AgentKeysPage />} />
                  <Route path="agent/logs" element={<AgentCallLogsPage />} />
                  <Route path="agent/mcp" element={<AgentMcpPage />} />
                  <Route path="agent/skill" element={<AgentSkillPage />} />
                  <Route path="agent/debug" element={<AgentDebugPage />} />
                  <Route path="*" element={<Navigate to={dashboardRoutes.knowledge} replace />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <RouteLoadSuccessMarker />
            </Suspense>
          </RouteLoadErrorBoundary>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default function DemoClientApp() {
  return (
    <BrowserRouter>
      <DemoRoutes />
    </BrowserRouter>
  )
}
