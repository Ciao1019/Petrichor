export const DASHBOARD_ROOT = "/dashboard"

export const dashboardRoutes = {
    root: DASHBOARD_ROOT,
    account: `${DASHBOARD_ROOT}/account`,
    notifications: `${DASHBOARD_ROOT}/notifications`,
    knowledge: `${DASHBOARD_ROOT}/knowledge`,
    adminUsers: `${DASHBOARD_ROOT}/admin/users`,
    adminAbout: `${DASHBOARD_ROOT}/admin/about`,
    adminAppearance: `${DASHBOARD_ROOT}/admin/appearance`,
    aiConfig: `${DASHBOARD_ROOT}/ai/config`,
    aiReview: `${DASHBOARD_ROOT}/ai/review`,
    qa: `${DASHBOARD_ROOT}/qa`,
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

export function isDashboardSectionPath(pathname: string, sectionPath: string) {
    const targetPath = dashboardPath(sectionPath)
    return pathname === targetPath || pathname.startsWith(`${targetPath}/`)
}
