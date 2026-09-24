import { describe, expect, it } from "vitest"
import {
  getAllSettingsPages,
  getSettingsPage,
  getSettingsSection,
  getSettingsSections,
  isSettingsPath,
} from "./settings-navigation"
import { dashboardRoutes } from "./dashboard-routes"

describe("settings navigation", () => {
  it("identifies settings paths correctly", () => {
    expect(isSettingsPath(dashboardRoutes.settings)).toBe(true)
    expect(isSettingsPath(dashboardRoutes.account)).toBe(true)
    expect(isSettingsPath(dashboardRoutes.aiConfig)).toBe(true)
    expect(isSettingsPath(dashboardRoutes.adminUsers)).toBe(true)
    expect(isSettingsPath(dashboardRoutes.knowledge)).toBe(false)
    expect(isSettingsPath(dashboardRoutes.inbox)).toBe(false)
    expect(isSettingsPath("/dashboard/assistant")).toBe(false)
  })

  it("retrieves the correct section for a path", () => {
    const accountSection = getSettingsSection(dashboardRoutes.account)
    expect(accountSection?.id).toBe("personal")
    expect(accountSection?.label).toBe("个人")

    const aiSection = getSettingsSection(dashboardRoutes.aiConfig)
    expect(aiSection?.id).toBe("ai")
    expect(aiSection?.label).toBe("AI 与模型")

    expect(getSettingsSection(dashboardRoutes.agentKeys)?.id).toBe("platform")
    expect(getSettingsSection(dashboardRoutes.adminAbout)?.id).toBe("site")

    const adminSection = getSettingsSection(dashboardRoutes.adminUsers)
    expect(adminSection?.id).toBe("ops")
    expect(adminSection?.label).toBe("系统运维")

    expect(getSettingsSection(dashboardRoutes.inbox)).toBeUndefined()
  })

  it("retrieves the specific page for a path", () => {
    const page = getSettingsPage(dashboardRoutes.account)
    expect(page?.id).toBe("account")
    expect(page?.label).toBe("账号设置")
    expect(page?.url).toBe(dashboardRoutes.account)

    expect(getSettingsPage(dashboardRoutes.inbox)).toBeUndefined()
  })

  it("filters admin-only sections for non-super-admins", () => {
    const userSections = getSettingsSections("USER")
    expect(userSections.map((s) => s.id)).toEqual(["personal", "ai", "platform"])

    const adminSections = getSettingsSections("SUPER_ADMIN")
    expect(adminSections.map((s) => s.id)).toEqual(["personal", "ai", "platform", "site", "ops"])

    const userPages = getAllSettingsPages("USER")
    expect(userPages.some((p) => p.id === "admin-users")).toBe(false)

    const adminPages = getAllSettingsPages("SUPER_ADMIN")
    expect(adminPages.some((p) => p.id === "admin-users")).toBe(true)
  })

  it("keeps every settings page in exactly one section with a distinct icon", () => {
    const pages = getAllSettingsPages("SUPER_ADMIN")
    expect(new Set(pages.map((p) => p.url)).size).toBe(pages.length)
    expect(new Set(pages.map((p) => p.icon)).size).toBe(pages.length)
  })
})
