import type { NextConfig } from "next"
import fs from "node:fs"
import path from "node:path"

const workspaceRoot = path.resolve(process.cwd(), "../..")
const turbopackRoot = fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))
    ? workspaceRoot
    : process.cwd()

const nextConfig: NextConfig = {
    reactStrictMode: true,
    turbopack: {
        root: turbopackRoot,
    },
    // 原生 / 非 ESM 可打包模块交给运行时 require，不要打进 server bundle。
    // @ast-grep/napi：Mastra 依赖，Turbopack/webpack 都无法正确打包其原生绑定。
    serverExternalPackages: ["better-sqlite3", "sharp", "@ast-grep/napi"],
    typedRoutes: false,

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
        // 减少客户端 JavaScript (Next.js 15+)
        optimizeCss: true,
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
