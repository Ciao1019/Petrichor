export const DASHBOARD_ROOT = "/dashboard"

export const dashboardRoutes = {
    root: DASHBOARD_ROOT,
    assistant: `${DASHBOARD_ROOT}/assistant`,
    metrics: `${DASHBOARD_ROOT}/metrics`,
    account: `${DASHBOARD_ROOT}/account`,
    notifications: `${DASHBOARD_ROOT}/notifications`,
    knowledge: `${DASHBOARD_ROOT}/knowledge`,
    imports: `${DASHBOARD_ROOT}/imports`,
    adminUsers: `${DASHBOARD_ROOT}/admin/users`,
    adminAbout: `${DASHBOARD_ROOT}/admin/about`,
    adminProjects: `${DASHBOARD_ROOT}/admin/projects`,
    adminAppearance: `${DASHBOARD_ROOT}/admin/appearance`,
    aiConfig: `${DASHBOARD_ROOT}/ai/config`,
    aiReview: `${DASHBOARD_ROOT}/ai/review`,
    agentKeys: `${DASHBOARD_ROOT}/agent/keys`,
    agentLogs: `${DASHBOARD_ROOT}/agent/logs`,
    agentMcp: `${DASHBOARD_ROOT}/agent/mcp`,
    agentSkill: `${DASHBOARD_ROOT}/agent/skill`,
} as const

export function dashboardPath(path = "") {
    if (!path || path === "/") {
        return DASHBOARD_ROOT
    }

    return `${DASHBOARD_ROOT}${path.startsWith("/") ? path : `/${path}`}`
}

export function knowledgeBasePath(knowledgeBaseId: string) {
    return `${dashboardRoutes.knowledge}/${knowledgeBaseId}`
}

export function knowledgeBaseArticlePath(knowledgeBaseId: string, articleId: string) {
    return `${knowledgeBasePath(knowledgeBaseId)}/articles/${articleId}`
}

export function knowledgeBaseArticleMindMapPath(knowledgeBaseId: string, articleId: string) {
    return `${knowledgeBaseArticlePath(knowledgeBaseId, articleId)}/mindmap`
}

export function knowledgeBaseDocumentPath(knowledgeBaseId: string, documentId: string) {
    return `${knowledgeBasePath(knowledgeBaseId)}/documents/${documentId}`
}

export function knowledgeBaseImportsPath(knowledgeBaseId: string) {
    return `${knowledgeBasePath(knowledgeBaseId)}/imports`
}

export function importJobDetailPath(jobId: string) {
    return `${dashboardRoutes.imports}/${jobId}`
}

export function isDashboardSectionPath(pathname: string, sectionPath: string) {
    const targetPath = dashboardPath(sectionPath)
    return pathname === targetPath || pathname.startsWith(`${targetPath}/`)
}

/* 应用型页面：外壳锁死视口高度，滚动只发生在页面内部容器（消息区、会话列表等），
   整页不产生 document 级滚动。其余页面仍走常规的整页滚动。 */
export function isFixedViewportRoute(pathname: string) {
    return isDashboardSectionPath(pathname, "/assistant")
        || new RegExp(`^${dashboardRoutes.knowledge}/[^/]+$`).test(pathname)
        // 文档预览页里 PDF / Excel 查看器要一个确定高度的容器，滚动发生在内部。
        || new RegExp(`^${dashboardRoutes.knowledge}/[^/]+/documents/[^/]+$`).test(pathname)
}
