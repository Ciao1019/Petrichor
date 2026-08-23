import type { NextConfig } from "next"
import fs from "node:fs"
import path from "node:path"

const workspaceRoot = path.resolve(process.cwd(), "../..")
const turbopackRoot = fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))
    ? workspaceRoot
    : process.cwd()

// ===== Go API 绞杀者分流（可选）=====
// PETRICHOR_GO_API_URL 指向 Go 服务（如 http://127.0.0.1:8080）时，
// 命中 PETRICHOR_GO_API_PREFIXES（逗号分隔，默认整个 /api）的请求被反代到 Go；
// 未设置该环境变量时行为与原版完全一致。
function buildGoApiRewrites() {
    const goApiUrl = process.env.PETRICHOR_GO_API_URL?.trim().replace(/\/+$/, "")
    if (!goApiUrl) {
        return []
    }
    const rawPrefixes = (process.env.PETRICHOR_GO_API_PREFIXES ?? "")
        .split(",")
        .map((item) => item.trim().replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
    const prefixes = rawPrefixes.length > 0 ? rawPrefixes : ["api"]
    return prefixes.map((prefix) => ({
        source: `/${prefix}/:path*`,
        destination: `${goApiUrl}/${prefix}/:path*`,
    }))
}

const goApiRewrites = buildGoApiRewrites()
if (goApiRewrites.length > 0) {
    console.log(`[next-config] /api 分流到 Go 后端：${process.env.PETRICHOR_GO_API_URL}`)
}

const nextConfig: NextConfig = {
    reactStrictMode: true,
    // Docker 部署用：产出精简的 standalone server（含 node_modules 裁剪），
    // 追踪根设为 monorepo 根，避免把 pnpm-lock.yaml 所在目录之外的文件误判进/出依赖树。
    output: "standalone",
    outputFileTracingRoot: turbopackRoot,
    turbopack: {
        root: turbopackRoot,
        // Mastra 可选依赖的原生绑定：Turbopack 无法打包，构建期用空 stub。
        // 路径相对 turbopack.root（monorepo 根），不是 apps/web。
        resolveAlias: {
            "@ast-grep/napi": "./apps/web/src/server/stubs/ast-grep-napi.ts",
        },
    },
    // 原生 / 非 ESM 可打包模块交给运行时 require，不要打进 server bundle。
    // @ast-grep/napi：Mastra 依赖，Turbopack/webpack 都无法正确打包其原生绑定。
    // @firecrawl/pdf-inspector：napi-rs 原生绑定，按平台走 optionalDependencies 解析。
    serverExternalPackages: ["better-sqlite3", "sharp", "@ast-grep/napi", "@firecrawl/pdf-inspector"],
    typedRoutes: false,
    // Go 后端分流（见文件顶部 buildGoApiRewrites）；beforeFiles 保证先于路由匹配。
    async rewrites() {
        return {
            beforeFiles: goApiRewrites,
            afterFiles: [],
            fallback: [],
        }
    },
    // Vercel 上偶发卡在 "Running TypeScript ..." 直到 45min 超时；类型检查交给 CI/本地 typecheck。
    typescript: {
        ignoreBuildErrors: true,
    },

    // 🚀 性能优化：启用实验性优化
    experimental: {
        // 优化大型包导入，减少重复代码
        optimizePackageImports: [
            "@radix-ui/react-avatar",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
            "@platejs/basic-nodes",
            "@platejs/basic-styles",
            "@platejs/autoformat",
            "@platejs/code-block",
            "@platejs/table",
            "@platejs/media",
            "@platejs/link",
            "@platejs/list",
        ],
    },

    // 图片优化
    images: {
        formats: ["image/avif", "image/webp"],
        minimumCacheTTL: 31536000, // 1 year
        remotePatterns: [
            {
                protocol: "https",
                hostname: "**",
            },
        ],
    },

    // 🔒 安全头配置
    async headers() {
        return [
            {
                source: "/:path*",
                headers: [
                    {
                        key: "X-DNS-Prefetch-Control",
                        value: "on",
                    },
                    {
                        key: "X-Frame-Options",
                        value: "SAMEORIGIN",
                    },
                    {
                        key: "X-Content-Type-Options",
                        value: "nosniff",
                    },
                    {
                        key: "Referrer-Policy",
                        value: "origin-when-cross-origin",
                    },
                    {
                        key: "Permissions-Policy",
                        value: "camera=(), microphone=(), geolocation=()",
                    },
                ],
            },
        ]
    },

    // Webpack 优化（当不使用 Turbopack 时生效）
    webpack: (config, { isServer }) => {
        if (!isServer) {
            // 代码分割优化
            config.optimization = {
                ...config.optimization,
                splitChunks: {
                    chunks: "all",
                    // 单个 chunk 体积上限（约 20MB），避免 vendor 合成过大文件。
                    maxSize: 20 * 1024 * 1024,
                    cacheGroups: {
                        // PlateJS 单独打包
                        platejs: {
                            test: /@platejs/,
                            priority: 10,
                            name: "platejs-bundle",
                            reuseExistingChunk: true,
                        },
                        // Radix UI 单独打包
                        radix: {
                            test: /@radix-ui/,
                            priority: 9,
                            name: "radix-bundle",
                            reuseExistingChunk: true,
                        },
                        // 其他 vendor 库（不固定 name，交给 webpack 按 maxSize 自动切分）
                        vendor: {
                            test: /[\\/]node_modules[\\/]/,
                            priority: 5,
                            reuseExistingChunk: true,
                        },
                    },
                },
            }
        }
        return config
    },
}

export default nextConfig
