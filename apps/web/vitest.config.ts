import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
    test: {
        environment: "node",
        globals: true,
        include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
        setupFiles: ["./src/test/setup.ts"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html", "lcov"],
            exclude: [
                "node_modules/",
                "src/test/",
                // 生成式 UI 与纯传输层 API 声明由上游升级/契约测试负责，不纳入业务覆盖率。
                "src/components/ui/",
                "src/components/extend/",
                "src/components/assistant-ui/",
                "src/components/tool-ui/",
                "src/cuicui/",
                "src/lib/api.ts",
                "src/lib/api-core.ts",
                "src/lib/api-ai.ts",
                "src/lib/api-knowledge.ts",
                "src/lib/api-wiki.ts",
                "src/lib/api-workspace.ts",
                "**/*.d.ts",
                "**/*.config.*",
                "**/mockData",
                "**/*.test.*",
            ],
            // 四项核心覆盖率均至少守住 60%，已有更高棘轮不回退。
            thresholds: {
                lines: 65,
                functions: 60,
                branches: 60,
                statements: 61,
            },
        },
        // 测试超时时间
        testTimeout: 10000,
    },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
})
