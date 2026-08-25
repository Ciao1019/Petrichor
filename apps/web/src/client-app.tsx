"use client"

import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useSearchParams, Outlet, Link } from 'react-router-dom'
import { LoginForm } from '@/components/login-form'
import { AuthCallback } from '@/components/auth-callback'
import { ThemeProvider } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppSidebar } from '@/components/app-sidebar'
import { AppBreadcrumb } from '@/components/app-breadcrumb'
import { TwoFactorEnforcementBanner } from '@/components/account/two-factor-enforcement-banner'
import { dashboardRoutes, isFixedViewportRoute } from '@/lib/dashboard-routes'
import { enterDemoMode } from '@/lib/demo/demo-mode'
import { DemoModeBanner } from '@/components/demo-mode-banner'
import { isPublicSitePath } from '@/lib/public-theme-routes'
import { authApi } from '@/lib/api'

// Next.js 迁移到 React Router 后不再自动按页面拆包；显式 lazy 才能避免把编辑器、
// 文档查看器、图表和 AI 管理页全部塞进首个 Rollup chunk。
const AssistantChatPage = lazy(() =>
  import('@/features/pages/assistant/AssistantChatPage').then((module) => ({ default: module.AssistantChatPage }))
)
const KnowledgeBasePage = lazy(() =>
  import('@/features/pages/knowledge/KnowledgeBasePage').then((module) => ({ default: module.KnowledgeBasePage }))
)
const KnowledgeBaseArticleEditorPage = lazy(() =>
  import('@/features/pages/knowledge/KnowledgeBaseArticleEditorPage').then((module) => ({ default: module.KnowledgeBaseArticleEditorPage }))
)
const DocLibraryListPage = lazy(() =>
  import('@/features/pages/doc-library/DocLibraryListPage').then((module) => ({ default: module.DocLibraryListPage }))
)
const DocLibraryBrowsePage = lazy(() =>
  import('@/features/pages/doc-library/DocLibraryBrowsePage').then((module) => ({ default: module.DocLibraryBrowsePage }))
)
const KnowledgeBaseArticleMindMapPage = lazy(() =>
  import('@/features/pages/knowledge/KnowledgeBaseArticleMindMapPage').then((module) => ({ default: module.KnowledgeBaseArticleMindMapPage }))
)
const KnowledgeBaseTreePage = lazy(() =>
  import('@/features/pages/knowledge/KnowledgeBaseTreePage').then((module) => ({ default: module.KnowledgeBaseTreePage }))
)
const DocumentImportJobsPage = lazy(() =>
  import('@/features/pages/knowledge/DocumentImportJobsPage').then((module) => ({ default: module.DocumentImportJobsPage }))
)
const DocumentImportJobDetailPage = lazy(() =>
  import('@/features/pages/knowledge/DocumentImportJobDetailPage').then((module) => ({ default: module.DocumentImportJobDetailPage }))
)
const AiModelConfigPage = lazy(() =>
  import('@/features/pages/ai/AiModelConfigPage').then((module) => ({ default: module.AiModelConfigPage }))
)
const AgentKeysPage = lazy(() =>
  import('@/features/pages/agent/AgentKeysPage').then((module) => ({ default: module.AgentKeysPage }))
)
const AgentCallLogsPage = lazy(() =>
  import('@/features/pages/agent/AgentCallLogsPage').then((module) => ({ default: module.AgentCallLogsPage }))
)
const AgentSkillPage = lazy(() =>
  import('@/features/pages/agent/AgentSkillPage').then((module) => ({ default: module.AgentSkillPage }))
)
const AgentDebugPage = lazy(() =>
  import('@/features/pages/agent-debug/AgentDebugPage').then((module) => ({ default: module.AgentDebugPage }))
)
const AgentMcpPage = lazy(() =>
  import('@/features/pages/agent/AgentMcpPage').then((module) => ({ default: module.AgentMcpPage }))
)
const BlogHomePage = lazy(() =>
  import('@/features/pages/blog/BlogHomePage').then((module) => ({ default: module.BlogHomePage }))
)
const TagsPage = lazy(() =>
  import('@/features/pages/blog/TagsPage').then((module) => ({ default: module.TagsPage }))
)
const SiteGraphPage = lazy(() =>
  import('@/features/pages/graph/SiteGraphPage').then((module) => ({ default: module.SiteGraphPage }))
)
const AboutPage = lazy(() =>
  import('@/features/pages/about/AboutPage').then((module) => ({ default: module.AboutPage }))
)
const ProjectsPage = lazy(() =>
  import('@/features/pages/projects/ProjectsPage').then((module) => ({ default: module.ProjectsPage }))
)
const PetrichorPage = lazy(() =>
  import('@/features/pages/petrichor/PetrichorPage').then((module) => ({ default: module.PetrichorPage }))
)
const PublicQaPage = lazy(() =>
  import('@/features/pages/ask/PublicQaPage').then((module) => ({ default: module.PublicQaPage }))
)
const AccountPage = lazy(() =>
  import('@/features/pages/account/AccountPage').then((module) => ({ default: module.AccountPage }))
)
const DashboardMetricsPage = lazy(() =>
  import('@/features/pages/dashboard/DashboardMetricsPage').then((module) => ({ default: module.DashboardMetricsPage }))
)
const SegmentedPreviewPage = lazy(() => import('@/features/pages/demo/SegmentedPreviewPage'))
const PublicArticlePage = lazy(() =>
  import('@/features/pages/public/PublicArticlePage').then((module) => ({ default: module.PublicArticlePage }))
)
const BurnReadPage = lazy(() =>
  import('@/features/pages/public/burn/BurnReadPage').then((module) => ({ default: module.BurnReadPage }))
)
const UserManagementPage = lazy(() =>
  import('@/features/pages/admin/UserManagementPage').then((module) => ({ default: module.UserManagementPage }))
)
const AboutProfileConfigPage = lazy(() =>
  import('@/features/pages/admin/AboutProfileConfigPage').then((module) => ({ default: module.AboutProfileConfigPage }))
)
const ProjectsConfigPage = lazy(() =>
  import('@/features/pages/admin/ProjectsConfigPage').then((module) => ({ default: module.ProjectsConfigPage }))
)
const NotificationPage = lazy(() =>
  import('@/features/pages/notification/NotificationPage').then((module) => ({ default: module.NotificationPage }))
)
const SiteAppearanceConfigPage = lazy(() =>
  import('@/features/pages/admin/SiteAppearanceConfigPage').then((module) => ({ default: module.SiteAppearanceConfigPage }))
)
const SiteGraphConfigPage = lazy(() =>
  import('@/features/pages/admin/SiteGraphConfigPage').then((module) => ({ default: module.SiteGraphConfigPage }))
)

function RouteLoadingFallback() {
  return (
    <div className="flex min-h-[40vh] flex-1 items-center justify-center px-4" role="status" aria-live="polite">
      <span className="text-sm text-muted-foreground motion-safe:animate-pulse">页面加载中…</span>
    </div>
  )
}

function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [checkingSession, setCheckingSession] = useState(true)
  const redirect = searchParams.get('redirect')
  const target =
    redirect && redirect.startsWith('/') && !redirect.startsWith('//')
      ? redirect
      : dashboardRoutes.root

  useEffect(() => {
    let active = true

    void authApi.me()
      .then(() => {
        if (active) navigate(target, { replace: true })
      })
      .catch(() => {
        if (active) setCheckingSession(false)
      })

    return () => {
      active = false
    }
  }, [navigate, target])

  const handleLoginSuccess = () => {
    navigate(target)
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4 text-sm text-muted-foreground">
        正在进入工作台…
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <LoginForm className="w-full" onLoginSuccess={handleLoginSuccess} />
        <p className="mt-4 text-center text-xs text-muted-foreground">
          没有账号？
          <Link to="/demo" className="ml-1 underline underline-offset-4 hover:text-foreground">
            免登录进入演示模式
          </Link>
        </p>
      </div>
    </div>
  )
}

function DashboardLayout() {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const viewportShellRef = useRef<HTMLDivElement>(null)
  /* 助手这类应用型页面必须给外壳一个确定高度：默认的 min-h-svh 会让整条 flex 链高度为 auto，
     内部的 overflow-y-auto 永远不触发，长回答会把整页撑高。dvh 作为首屏回退，运行时再对齐真实可视视口。 */
  const lockViewport = isFixedViewportRoute(location.pathname)

  useEffect(() => {
    const token = searchParams.get('token')
    if (token) {
      window.history.replaceState({}, '', dashboardRoutes.root)
    }
  }, [searchParams])

  useEffect(() => {
    if (!lockViewport) return
    // 只锁 documentElement，body 留给 Radix 的 scroll lock，避免互相覆盖
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
        // iOS 软键盘收起后可能暂时保留可视视口偏移；用页面坐标中的可视底边才不会留白。
        const viewportBottom = viewport
          ? viewport.height + viewport.pageTop
          : window.innerHeight
        shell.style.height = `${Math.round(viewportBottom)}px`
      })
    }

    const syncAfterFocusChange = () => {
      syncViewportHeight()
      window.clearTimeout(settleTimer)
      // 空状态输入框在发送后会被对话输入框替换，需在键盘收起动画结束后再校准一次。
      settleTimer = window.setTimeout(syncViewportHeight, 350)
    }

    root.style.overflow = 'hidden'
    syncViewportHeight()
    window.addEventListener('resize', syncViewportHeight)
    window.visualViewport?.addEventListener('resize', syncViewportHeight)
    window.visualViewport?.addEventListener('scroll', syncViewportHeight)
    document.addEventListener('focusin', syncAfterFocusChange)
    document.addEventListener('focusout', syncAfterFocusChange)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(settleTimer)
      window.removeEventListener('resize', syncViewportHeight)
      window.visualViewport?.removeEventListener('resize', syncViewportHeight)
      window.visualViewport?.removeEventListener('scroll', syncViewportHeight)
      document.removeEventListener('focusin', syncAfterFocusChange)
      document.removeEventListener('focusout', syncAfterFocusChange)
      shell?.style.removeProperty('height')
      root.style.overflow = previousOverflow
    }
  }, [lockViewport])

  return (
    <SidebarProvider
      ref={viewportShellRef}
      className={lockViewport ? 'h-dvh min-h-0 overflow-hidden' : undefined}
    >
      <AppSidebar variant="inset" />
      <SidebarInset>
        <AppBreadcrumb />
        <DemoModeBanner />
        <TwoFactorEnforcementBanner />
        <div className="flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<RouteLoadingFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/* 演示模式入口：落 sessionStorage 标记后直接进真实仪表盘。
   页面组件不感知演示态，数据层由 demo adapter 全量接管。 */
function DemoEntry() {
  enterDemoMode()
  return <Navigate to={dashboardRoutes.knowledge} replace />
}

function AppThemeScope() {
  const location = useLocation()
  // 前台公开页固定暗色，后台仍可自由切换
  const forcedTheme = isPublicSitePath(location.pathname) ? 'dark' : undefined

  return (
    <ThemeProvider defaultTheme="system" forcedTheme={forcedTheme}>
      <TooltipProvider>
        <Toaster />
        <div style={{ position: 'relative', minHeight: '100vh' }}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              <Route path="/" element={<BlogHomePage />} />
              <Route path="/tags" element={<TagsPage />} />
              <Route path="/graph" element={<SiteGraphPage />} />
              <Route path="/ask" element={<PublicQaPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/petrichor" element={<PetrichorPage />} />
              <Route path="/demo" element={<DemoEntry />} />
              <Route path="/demo/segmented-preview" element={<SegmentedPreviewPage />} />
              <Route path="/p/:shareCode" element={<PublicArticlePage />} />
              <Route path="/b/:code" element={<BurnReadPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/dashboard" element={<DashboardLayout />}>
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
                <Route path="admin/site-graph" element={<SiteGraphConfigPage />} />
                <Route path="ai/config" element={<AiModelConfigPage />} />
                <Route path="agent" element={<AgentKeysPage />} />
                <Route path="agent/keys" element={<AgentKeysPage />} />
                <Route path="agent/logs" element={<AgentCallLogsPage />} />
                <Route path="agent/mcp" element={<AgentMcpPage />} />
                <Route path="agent/skill" element={<AgentSkillPage />} />
                <Route path="agent/debug" element={<AgentDebugPage />} />
              </Route>
            </Routes>
          </Suspense>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppThemeScope />
    </BrowserRouter>
  )
}

export default App
