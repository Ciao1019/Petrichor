export const DASHBOARD_ROOT = "/dashboard"

export const dashboardRoutes = {
    root: DASHBOARD_ROOT,
    account: `${DASHBOARD_ROOT}/account`,
    notifications: `${DASHBOARD_ROOT}/notifications`,
    knowledge: `${DASHBOARD_ROOT}/knowledge`,
    imports: `${DASHBOARD_ROOT}/imports`,
    wiki: `${DASHBOARD_ROOT}/wiki`,
    adminUsers: `${DASHBOARD_ROOT}/admin/users`,
    adminAbout: `${DASHBOARD_ROOT}/admin/about`,
    adminProjects: `${DASHBOARD_ROOT}/admin/projects`,
    adminAppearance: `${DASHBOARD_ROOT}/admin/appearance`,
    aiConfig: `${DASHBOARD_ROOT}/ai/config`,
    aiReview: `${DASHBOARD_ROOT}/ai/review`,
    qa: `${DASHBOARD_ROOT}/qa`,
    docLibrary: `${DASHBOARD_ROOT}/doc-library`,
    docLibraryQa: `${DASHBOARD_ROOT}/doc-library/qa`,
    agentKeys: `${DASHBOARD_ROOT}/agent/keys`,
    agentLogs: `${DASHBOARD_ROOT}/agent/logs`,
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
