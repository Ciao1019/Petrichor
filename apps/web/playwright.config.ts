import { defineConfig, devices } from "@playwright/test"

/**
 * E2E 测试配置
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
    testDir: "./e2e",
    // 每个测试的最大运行时间
    timeout: 30 * 1000,
    expect: {
        timeout: 5000,
    },
    // 失败时并行运行 2 次重试
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    // CI 环境下限制并行数
    workers: process.env.CI ? 1 : undefined,
    // 报告格式
    reporter: "html",
    // 共享配置
    use: {
        // 基础 URL
        baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
        // 追踪选项
        trace: "on-first-retry",
        // 截图选项
        screenshot: "only-on-failure",
    },

    // 配置不同的浏览器项目
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "firefox",
            use: { ...devices["Desktop Firefox"] },
        },
        {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
        },
        // 移动端测试
        {
            name: "Mobile Chrome",
            use: { ...devices["Pixel 5"] },
        },
        {
            name: "Mobile Safari",
            use: { ...devices["iPhone 12"] },
        },
    ],

    // 运行测试前启动开发服务器
    webServer: process.env.CI
        ? undefined
        : {
              command: "bun run dev",
              url: "http://localhost:3000",
              reuseExistingServer: !process.env.CI,
              timeout: 120 * 1000,
          },
})
