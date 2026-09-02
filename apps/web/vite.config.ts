import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig(({ mode }) => ({
    plugins: [react(), tailwindcss()],
    envPrefix: ["VITE_", "PETRICHOR_PUBLIC_"],
    resolve: {
        // Bun 可能为宽松 peerDependency 保留嵌套 React；强制编辑器等 lazy chunk
        // 始终复用应用入口的同一 React 实例，避免生产构建触发 Invalid Hook Call。
        dedupe: ["react", "react-dom"],
        alias: [
            ...(mode === "demo" ? [{
                // 独立演示构建不解析正式后台路由，避免把未开放页面与重依赖带进 Vercel 产物。
                find: "@/client-app",
                replacement: fileURLToPath(new URL("./src/demo-client-app.tsx", import.meta.url)),
            }] : []),
            { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
            {
                // 精确替换浏览器端完整 Shiki 入口；shiki/core、shiki/wasm 等子路径保持原实现。
                find: /^shiki$/,
                replacement: fileURLToPath(new URL("./src/lib/shiki-browser.ts", import.meta.url)),
            },
        ],
    },
    optimizeDeps: {
        // 文章编辑器位于 lazy 路由。若只从 index.html 扫描，Plate / DnD / DOCX
        // 会在首次进入编辑器时才被发现，Vite 重建公共依赖后旧 browserHash 请求会返回 504。
        // 把编辑器显式作为扫描入口，使整条静态依赖链在浏览器请求前一次性完成预构建。
        entries: [
            "index.html",
            "src/features/pages/knowledge/KnowledgeBaseArticleEditorPage.tsx",
        ],
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: false,
        target: "es2022",
    },
    worker: {
        format: "es",
    },
    server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
        hmr: {
            host: "127.0.0.1",
            clientPort: 5173,
        },
    },
}))
