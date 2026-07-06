import type { NextConfig } from "next"
import fs from "node:fs"
import path from "node:path"

const workspaceRoot = path.resolve(process.cwd(), "../..")
const turbopackRoot = fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))
    ? workspaceRoot
    : process.cwd()

// Cloudflare Workers Builds 免费版仅 2 vCPU 且有 20 分钟构建硬超时，
// 而 in-build 的类型检查在 CI 上会拖到十几分钟导致超时。
// 通过 CF_BUILD 环境变量在 Cloudflare 构建时跳过 tsc/eslint（由独立的
// `pnpm typecheck` / `pnpm lint` 和 Vercel 构建保证质量），Vercel 构建不受影响。
const skipInBuildChecks = process.env.CF_BUILD === "1"

const nextConfig: NextConfig = {
    reactStrictMode: true,
    typescript: {
        ignoreBuildErrors: skipInBuildChecks,
    },
    eslint: {
        ignoreDuringBuilds: skipInBuildChecks,
    },
    turbopack: {
        root: turbopackRoot,
    },
    // sharp 是原生模块，交给运行时直接 require，不要打进 server bundle。
    serverExternalPackages: ["better-sqlite3", "sharp"],
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
                    // 单个 chunk 体积上限（约 20MB）。Cloudflare Workers 静态资源单文件
                    // 上限 25MiB，若把整个 vendor 合成一个文件会超限，这里让 webpack
                    // 按体积自动拆分为多个子 chunk。
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
                        // 其他 vendor 库（不固定 name，交给 webpack 按 maxSize 自动切分，
                        // 避免合成单个超过 Cloudflare 25MiB 限制的巨型文件）
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

// 让 `next dev` 也能访问 Cloudflare 绑定（R2/KV 等）与 env，仅本地开发生效。
// 对 Vercel 构建无副作用：只在 dev 时惰性加载 @opennextjs/cloudflare。
import("@opennextjs/cloudflare").then((m) => m.initOpenNextCloudflareForDev()).catch(() => {})
