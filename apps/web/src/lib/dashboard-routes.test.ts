import { describe, expect, it } from "vitest"

import {
    DASHBOARD_ROOT,
    dashboardPath,
    dashboardRoutes,
    isDashboardSectionPath,
    knowledgeBaseArticleMindMapPath,
    knowledgeBaseArticlePath,
    knowledgeBasePath,
} from "./dashboard-routes"

describe("dashboard routes", () => {
    it("generates dashboard-prefixed routes for every admin page", () => {
        expect(DASHBOARD_ROOT).toBe("/dashboard")
        expect(dashboardRoutes).toMatchObject({
            root: "/dashboard",
            account: "/dashboard/account",
            notifications: "/dashboard/notifications",
            knowledge: "/dashboard/knowledge",
            adminUsers: "/dashboard/admin/users",
            aiConfig: "/dashboard/ai/config",
            qa: "/dashboard/qa",
        })
    })

    it("builds nested knowledge-base paths under dashboard", () => {
        expect(knowledgeBasePath("kb1")).toBe("/dashboard/knowledge/kb1")
        expect(knowledgeBaseArticlePath("kb1", "article1")).toBe("/dashboard/knowledge/kb1/articles/article1")
        expect(knowledgeBaseArticleMindMapPath("kb1", "article1")).toBe("/dashboard/knowledge/kb1/articles/article1/mindmap")
    })

    it("normalizes relative dashboard paths", () => {
        expect(dashboardPath()).toBe("/dashboard")
        expect(dashboardPath("/")).toBe("/dashboard")
        expect(dashboardPath("knowledge")).toBe("/dashboard/knowledge")
        expect(dashboardPath("/knowledge")).toBe("/dashboard/knowledge")
    })

    it("matches only the intended dashboard section", () => {
        expect(isDashboardSectionPath("/dashboard/knowledge", "knowledge")).toBe(true)
        expect(isDashboardSectionPath("/dashboard/knowledge/kb1", "knowledge")).toBe(true)
        expect(isDashboardSectionPath("/dashboard/knowledge-shared", "knowledge")).toBe(false)
        expect(isDashboardSectionPath("/knowledge/kb1", "knowledge")).toBe(false)
    })
})
