import { test, expect } from "@playwright/test"

/**
 * E2E 测试示例：基础页面访问
 */
test.describe("Public Pages", () => {
    test("should load home page", async ({ page }) => {
        await page.goto("/")
        await expect(page).toHaveTitle(/Petrichor/)
    })

    test("should load login page", async ({ page }) => {
        await page.goto("/login")
        await expect(page.locator('input[type="email"]')).toBeVisible()
        await expect(page.locator('input[type="password"]')).toBeVisible()
    })
})

/**
 * E2E 测试示例：登录流程
 */
test.describe("Authentication", () => {
    test("should show error on invalid credentials", async ({ page }) => {
        await page.goto("/login")

        // 填写错误的凭据
        await page.fill('input[type="email"]', "test@example.com")
        await page.fill('input[type="password"]', "wrongpassword")

        // 提交表单
        await page.click('button[type="submit"]')

        // 应该显示错误信息
        await expect(page.locator("text=/错误|error/i")).toBeVisible()
    })
})

/**
 * E2E 测试示例：响应式设计
 */
test.describe("Responsive Design", () => {
    test("should be mobile friendly", async ({ page }) => {
        // 设置移动端视口
        await page.setViewportSize({ width: 375, height: 667 })
        await page.goto("/")

        // 检查导航菜单是否可见
        const nav = page.locator("nav")
        await expect(nav).toBeVisible()
    })
})
