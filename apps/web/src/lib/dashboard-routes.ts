export const DASHBOARD_ROOT = "/dashboard"

export const dashboardRoutes = {
    root: DASHBOARD_ROOT,
    assistant: `${DASHBOARD_ROOT}/assistant`,
    metrics: `${DASHBOARD_ROOT}/metrics`,
    account: `${DASHBOARD_ROOT}/account`,
    notifications: `${DASHBOARD_ROOT}/notifications`,
    knowledge: `${DASHBOARD_ROOT}/knowledge`,
    imports: `${DASHBOARD_ROOT}/imports`,
    wiki: `${DASHBOARD_ROOT}/wiki`,
    adminUsers: `${DASHBOARD_ROOT}/admin/users`,
    adminAbout: `${DASHBOARD_ROOT}/admin/about`,
    adminProjects: `${DASHBOARD_ROOT}/admin/projects`,
    adminAppearance: `${DASHBOARD_ROOT}/admin/appearance`,
    adminSiteGraph: `${DASHBOARD_ROOT}/admin/site-graph`,
    aiConfig: `${DASHBOARD_ROOT}/ai/config`,
    aiReview: `${DASHBOARD_ROOT}/ai/review`,
    docLibrary: `${DASHBOARD_ROOT}/doc-library`,
    agentKeys: `${DASHBOARD_ROOT}/agent/keys`,
    agentLogs: `${DASHBOARD_ROOT}/agent/logs`,
    agentMcp: `${DASHBOARD_ROOT}/agent/mcp`,
    agentSkill: `${DASHBOARD_ROOT}/agent/skill`,
    agentDebug: `${DASHBOARD_ROOT}/agent/debug`,
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

export function knowledgeBaseImportsPath(knowledgeBaseId: string) {
    return `${knowledgeBasePath(knowledgeBaseId)}/imports`
}

export function importJobDetailPath(jobId: string) {
    return `${dashboardRoutes.imports}/${jobId}`
}

export function docLibraryBrowsePath(libraryId: string) {
    return `${dashboardRoutes.docLibrary}/${libraryId}`
}

export function docLibraryDocumentPath(libraryId: string, documentId: string) {
    return `${docLibraryBrowsePath(libraryId)}?documentId=${encodeURIComponent(documentId)}`
}

export function isDashboardSectionPath(pathname: string, sectionPath: string) {
    const targetPath = dashboardPath(sectionPath)
    return pathname === targetPath || pathname.startsWith(`${targetPath}/`)
}

/* 应用型页面：外壳锁死视口高度，滚动只发生在页面内部容器（消息区、会话列表等），
   整页不产生 document 级滚动。其余页面仍走常规的整页滚动。 */
export function isFixedViewportRoute(pathname: string) {
    return isDashboardSectionPath(pathname, "/assistant")
}
