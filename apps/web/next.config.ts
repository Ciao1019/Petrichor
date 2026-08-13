import type { NextConfig } from "next"
import fs from "node:fs"
import path from "node:path"

const workspaceRoot = path.resolve(process.cwd(), "../..")
const turbopackRoot = fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))
    ? workspaceRoot
    : process.cwd()

const goApiURL = process.env.PETRICHOR_GO_API_URL?.trim()

const nextConfig: NextConfig = {
    reactStrictMode: true,
    // Docker 部署用：产出精简的 standalone server（含 node_modules 裁剪），
    // 追踪根设为 monorepo 根，避免把 pnpm-lock.yaml 所在目录之外的文件误判进/出依赖树。
    output: "standalone",
    outputFileTracingRoot: turbopackRoot,
    // 业务 API 已迁至 Go：必须设置 PETRICHOR_GO_API_URL，将 /api 与 Feed 代理过去。
    async rewrites() {
        const base = (goApiURL || "http://127.0.0.1:8080").replace(/\/$/, "")
        if (!goApiURL) {
            console.warn(
                "[petrichor] PETRICHOR_GO_API_URL 未设置，默认代理到 http://127.0.0.1:8080。请启动 pnpm dev:api。",
            )
        }
        return [
            { source: "/api/:path*", destination: `${base}/api/:path*` },
            { source: "/rss.xml", destination: `${base}/rss.xml` },
            { source: "/atom.xml", destination: `${base}/atom.xml` },
            { source: "/healthz", destination: `${base}/healthz` },
        ]
    },
    turbopack: {
        root: turbopackRoot,
    },
    // Next 图片优化在 Node 运行时使用 sharp，不打进业务 bundle。
    serverExternalPackages: ["sharp"],
    typedRoutes: false,
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
            "@tabler/icons-react",
            "lucide-react",
            "@platejs/basic-nodes",
            "@platejs/basic-styles",
            "@platejs/autoformat",
            "@platejs/code-block",
            "@platejs/table",
            "@platejs/media",
            "@platejs/link",
            "@platejs/list",
            "@lobehub/icons",
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
                        // 图标库单独打包
                        icons: {
                            test: /(lucide-react|@tabler\/icons-react|@lobehub\/icons)/,
                            priority: 8,
                            name: "icons-bundle",
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
