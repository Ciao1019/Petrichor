"use client"

import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useSearchParams, Outlet } from 'react-router-dom'
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
import { TwoFactorEnforcementBanner } from '@/components/account/two-factor-enforcement-banner'
import { AssistantChatPage } from '@/features/pages/assistant/AssistantChatPage'
import { KnowledgeBasePage } from '@/features/pages/knowledge/KnowledgeBasePage'
import { KnowledgeBaseArticleEditorPage } from '@/features/pages/knowledge/KnowledgeBaseArticleEditorPage'
import { DocLibraryListPage } from '@/features/pages/doc-library/DocLibraryListPage'
import { DocLibraryBrowsePage } from '@/features/pages/doc-library/DocLibraryBrowsePage'
import { KnowledgeWikiPage } from '@/features/pages/knowledge/KnowledgeWikiPage'
import { KnowledgeBaseArticleMindMapPage } from '@/features/pages/knowledge/KnowledgeBaseArticleMindMapPage'
import { KnowledgeBaseTreePage } from '@/features/pages/knowledge/KnowledgeBaseTreePage'
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
import { AccountPage } from '@/features/pages/account/AccountPage'
import { DashboardMetricsPage } from '@/features/pages/dashboard/DashboardMetricsPage'
import { PublicArticlePage } from '@/features/pages/public/PublicArticlePage'
import { BurnReadPage } from '@/features/pages/public/burn/BurnReadPage'
import { UserManagementPage } from '@/features/pages/admin/UserManagementPage'
import { AboutProfileConfigPage } from '@/features/pages/admin/AboutProfileConfigPage'
import { ProjectsConfigPage } from '@/features/pages/admin/ProjectsConfigPage'
import { NotificationPage } from '@/features/pages/notification/NotificationPage'
import { dashboardRoutes } from '@/lib/dashboard-routes'
import { isPublicLightThemePath } from '@/lib/public-theme-routes'
import { SiteAppearanceConfigPage } from '@/features/pages/admin/SiteAppearanceConfigPage'

const isDesktopMode = process.env.NEXT_PUBLIC_DESKTOP_MODE === 'true'

function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  if (isDesktopMode) {
    return <Navigate to={dashboardRoutes.root} replace />
  }

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
      <LoginForm className="w-full max-w-sm" onLoginSuccess={handleLoginSuccess} />
    </div>
  )
}

function DashboardLayout() {
  const [searchParams] = useSearchParams()

  useEffect(() => {
    const token = searchParams.get('token')
    if (token) {
      window.history.replaceState({}, '', dashboardRoutes.root)
    }
  }, [searchParams])

  return (
    <SidebarProvider>
      <AppSidebar variant="inset" />
      <SidebarInset>
        <AppBreadcrumb />
        <TwoFactorEnforcementBanner />
        <div className="flex flex-1 flex-col">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function RedirectToDashboard() {
  return <Navigate to={dashboardRoutes.root} replace />
}

function AppThemeScope() {
  const location = useLocation()
  const forcedTheme = !isDesktopMode && isPublicLightThemePath(location.pathname) ? 'light' : undefined

  return (
    <ThemeProvider defaultTheme="system" forcedTheme={forcedTheme}>
      <TooltipProvider>
        <Toaster />
        <div style={{ position: 'relative', minHeight: '100vh' }}>
          <Routes>
            {isDesktopMode ? (
              <>
                <Route path="/" element={<RedirectToDashboard />} />
                <Route path="/tags" element={<RedirectToDashboard />} />
                <Route path="/about" element={<RedirectToDashboard />} />
                <Route path="/projects" element={<RedirectToDashboard />} />
                <Route path="/p/:shareCode" element={<RedirectToDashboard />} />
                <Route path="/b/:code" element={<RedirectToDashboard />} />
              </>
            ) : (
              <>
                <Route path="/" element={<BlogHomePage />} />
                <Route path="/tags" element={<TagsPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/p/:shareCode" element={<PublicArticlePage />} />
                <Route path="/b/:code" element={<BurnReadPage />} />
              </>
            )}
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
              <Route path="wiki" element={<KnowledgeWikiPage />} />
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
