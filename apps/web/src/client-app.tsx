"use client"

import { BrowserRouter, Routes, Route, useLocation, useNavigate, useSearchParams, Outlet } from 'react-router-dom'
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
import { KnowledgeBasePage } from '@/features/pages/knowledge/KnowledgeBasePage'
import { KnowledgeBaseArticleEditorPage } from '@/features/pages/knowledge/KnowledgeBaseArticleEditorPage'
import { KnowledgeQaPage } from '@/features/pages/knowledge/KnowledgeQaPage'
import { KnowledgeBaseArticleMindMapPage } from '@/features/pages/knowledge/KnowledgeBaseArticleMindMapPage'
import { KnowledgeBaseTreePage } from '@/features/pages/knowledge/KnowledgeBaseTreePage'
import { AiModelConfigPage } from '@/features/pages/ai/AiModelConfigPage'
import { AiReviewPage } from '@/features/pages/ai/AiReviewPage'
import { AgentKeysPage } from '@/features/pages/agent/AgentKeysPage'
import { AgentCallLogsPage } from '@/features/pages/agent/AgentCallLogsPage'
import { AgentSkillPage } from '@/features/pages/agent/AgentSkillPage'
import { BlogHomePage } from '@/features/pages/blog/BlogHomePage'
import { TagsPage } from '@/features/pages/blog/TagsPage'
import { AboutPage } from '@/features/pages/about/AboutPage'
import { AccountPage } from '@/features/pages/account/AccountPage'
import { DashboardMetricsPage } from '@/features/pages/dashboard/DashboardMetricsPage'
import { PublicArticlePage } from '@/features/pages/public/PublicArticlePage'
import { UserManagementPage } from '@/features/pages/admin/UserManagementPage'
import { AboutProfileConfigPage } from '@/features/pages/admin/AboutProfileConfigPage'
import { NotificationPage } from '@/features/pages/notification/NotificationPage'
import { dashboardRoutes } from '@/lib/dashboard-routes'
import { isPublicLightThemePath } from '@/lib/public-theme-routes'
import type { RetypesetAppearanceConfig } from '@/lib/retypeset-themes'
import { RetypesetThemeProvider } from '@/features/retypeset-theme/RetypesetThemeContext'
import { SiteAppearanceConfigPage } from '@/features/pages/admin/SiteAppearanceConfigPage'

export type ClientAppProps = {
  initialAppearance?: RetypesetAppearanceConfig
}

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

function AppThemeScope({ initialAppearance }: ClientAppProps) {
  const location = useLocation()
  const forcedTheme = isPublicLightThemePath(location.pathname) ? 'light' : undefined

  return (
    <ThemeProvider defaultTheme="system" forcedTheme={forcedTheme}>
      <RetypesetThemeProvider initialAppearance={initialAppearance}>
      <TooltipProvider>
        <Toaster />
        <div style={{ position: 'relative', minHeight: '100vh' }}>
          <Routes>
            <Route path="/" element={<BlogHomePage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/p/:shareCode" element={<PublicArticlePage />} />
            <Route path="/dashboard" element={<DashboardLayout />}>
              <Route index element={<DashboardMetricsPage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="notifications" element={<NotificationPage />} />
              <Route path="knowledge" element={<KnowledgeBasePage />} />
              <Route path="knowledge/:knowledgeBaseId" element={<KnowledgeBaseTreePage />} />
              <Route path="qa" element={<KnowledgeQaPage />} />
              <Route path="knowledge/:knowledgeBaseId/articles/:articleId" element={<KnowledgeBaseArticleEditorPage />} />
              <Route path="knowledge/:knowledgeBaseId/articles/:articleId/mindmap" element={<KnowledgeBaseArticleMindMapPage />} />
              <Route path="admin/users" element={<UserManagementPage />} />
              <Route path="admin/about" element={<AboutProfileConfigPage />} />
              <Route path="admin/appearance" element={<SiteAppearanceConfigPage />} />
              <Route path="ai/config" element={<AiModelConfigPage />} />
              <Route path="ai/review" element={<AiReviewPage />} />
              <Route path="agent" element={<AgentKeysPage />} />
              <Route path="agent/keys" element={<AgentKeysPage />} />
              <Route path="agent/logs" element={<AgentCallLogsPage />} />
              <Route path="agent/skill" element={<AgentSkillPage />} />
            </Route>
          </Routes>
        </div>
      </TooltipProvider>
      </RetypesetThemeProvider>
    </ThemeProvider>
  )
}

function App({ initialAppearance }: ClientAppProps) {
  return (
    <BrowserRouter>
      <AppThemeScope initialAppearance={initialAppearance} />
    </BrowserRouter>
  )
}

export default App
