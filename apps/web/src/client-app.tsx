"use client"

import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useSearchParams, Outlet, Link } from 'react-router-dom'
import { LoginForm } from '@/components/login-form'
import { AuthCallback } from '@/components/auth-callback'
import { ThemeProvider } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'
import { useEffect } from 'react'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppSidebar } from '@/components/app-sidebar'
import { AppBreadcrumb } from '@/components/app-breadcrumb'
import { AssistantChatPage } from '@/features/pages/assistant/AssistantChatPage'
import { KnowledgeBasePage } from '@/features/pages/knowledge/KnowledgeBasePage'
import { KnowledgeBaseDetailPage } from '@/features/pages/knowledge/KnowledgeBaseDetailPage'
import { KnowledgeBaseDocumentPage } from '@/features/pages/knowledge/KnowledgeBaseDocumentPage'
import { KnowledgeBaseArticleEditorPage } from '@/features/pages/knowledge/KnowledgeBaseArticleEditorPage'
import { KnowledgeBaseArticleMindMapPage } from '@/features/pages/knowledge/KnowledgeBaseArticleMindMapPage'
import { DocumentImportJobsPage } from '@/features/pages/knowledge/DocumentImportJobsPage'
import { DocumentImportJobDetailPage } from '@/features/pages/knowledge/DocumentImportJobDetailPage'
import { AiModelConfigPage } from '@/features/pages/ai/AiModelConfigPage'
import { AiReviewPage } from '@/features/pages/ai/AiReviewPage'
import { AgentKeysPage } from '@/features/pages/agent/AgentKeysPage'
import { AgentCallLogsPage } from '@/features/pages/agent/AgentCallLogsPage'
import { AgentSkillPage } from '@/features/pages/agent/AgentSkillPage'
import { AgentMcpPage } from '@/features/pages/agent/AgentMcpPage'
import { BlogHomePage } from '@/features/pages/blog/BlogHomePage'
import { TagsPage } from '@/features/pages/blog/TagsPage'
import { AboutPage } from '@/features/pages/about/AboutPage'
import { ProjectsPage } from '@/features/pages/projects/ProjectsPage'
import { PetrichorPage } from '@/features/pages/petrichor/PetrichorPage'
import { PublicQaPage } from '@/features/pages/ask/PublicQaPage'
import { AccountPage } from '@/features/pages/account/AccountPage'
import { DashboardMetricsPage } from '@/features/pages/dashboard/DashboardMetricsPage'
import { PublicArticlePage } from '@/features/pages/public/PublicArticlePage'
import { BurnReadPage } from '@/features/pages/public/burn/BurnReadPage'
import { UserManagementPage } from '@/features/pages/admin/UserManagementPage'
import { AboutProfileConfigPage } from '@/features/pages/admin/AboutProfileConfigPage'
import { ProjectsConfigPage } from '@/features/pages/admin/ProjectsConfigPage'
import { NotificationPage } from '@/features/pages/notification/NotificationPage'
import { dashboardRoutes, isFixedViewportRoute } from '@/lib/dashboard-routes'
import { enterDemoMode } from '@/lib/demo/demo-mode'
import { DemoModeBanner } from '@/components/demo-mode-banner'
import { isPublicSitePath } from '@/lib/public-theme-routes'
import { SiteAppearanceConfigPage } from '@/features/pages/admin/SiteAppearanceConfigPage'

function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const handleLoginSuccess = () => {
    const redirect = searchParams.get('redirect')
    const target =
      redirect && redirect.startsWith('/') && !redirect.startsWith('//')
        ? redirect
        : dashboardRoutes.root
    navigate(target)
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
  /* 助手这类应用型页面必须给外壳一个确定高度：默认的 min-h-svh 会让整条 flex 链高度为 auto，
     内部的 overflow-y-auto 永远不触发，长回答会把整页撑高，左侧会话列表被推出视口。 */
  const lockViewport = isFixedViewportRoute(location.pathname)
  const isKnowledgeWorkspace = new RegExp(`^${dashboardRoutes.knowledge}/[^/]+$`).test(location.pathname)

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
    const previousOverflow = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = previousOverflow
    }
  }, [lockViewport])

  return (
    <SidebarProvider className={lockViewport ? 'h-svh overflow-hidden' : undefined}>
      <AppSidebar variant="inset" />
      <SidebarInset>
        {isKnowledgeWorkspace ? null : <AppBreadcrumb />}
        <DemoModeBanner />
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
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
          <Routes>
            <Route path="/" element={<BlogHomePage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/ask" element={<PublicQaPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/petrichor" element={<PetrichorPage />} />
            <Route path="/demo" element={<DemoEntry />} />
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
              <Route path="knowledge/:knowledgeBaseId" element={<KnowledgeBaseDetailPage />} />
              <Route path="knowledge/:knowledgeBaseId/documents/:documentId" element={<KnowledgeBaseDocumentPage />} />
              <Route path="knowledge/:knowledgeBaseId/imports" element={<DocumentImportJobsPage />} />
              <Route path="imports" element={<DocumentImportJobsPage />} />
              <Route path="imports/:jobId" element={<DocumentImportJobDetailPage />} />
              <Route path="knowledge/:knowledgeBaseId/articles/:articleId" element={<KnowledgeBaseArticleEditorPage />} />
              <Route path="knowledge/:knowledgeBaseId/articles/:articleId/mindmap" element={<KnowledgeBaseArticleMindMapPage />} />
              <Route path="admin/users" element={<UserManagementPage />} />
              <Route path="admin/about" element={<AboutProfileConfigPage />} />
              <Route path="admin/projects" element={<ProjectsConfigPage />} />
              <Route path="admin/appearance" element={<SiteAppearanceConfigPage />} />
              <Route path="ai/config" element={<AiModelConfigPage />} />
              <Route path="ai/review" element={<AiReviewPage />} />
              <Route path="agent" element={<AgentKeysPage />} />
              <Route path="agent/keys" element={<AgentKeysPage />} />
              <Route path="agent/logs" element={<AgentCallLogsPage />} />
              <Route path="agent/mcp" element={<AgentMcpPage />} />
              <Route path="agent/skill" element={<AgentSkillPage />} />
            </Route>
          </Routes>
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
