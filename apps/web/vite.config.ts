import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
    plugins: [react(), tailwindcss()],
    envPrefix: ["VITE_", "PETRICHOR_PUBLIC_"],
    resolve: {
        alias: [
            { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
            {
                // 精确替换浏览器端完整 Shiki 入口；shiki/core、shiki/wasm 等子路径保持原实现。
                find: /^shiki$/,
                replacement: fileURLToPath(new URL("./src/lib/shiki-browser.ts", import.meta.url)),
            },
            {
                find: "@ast-grep/napi",
                replacement: fileURLToPath(new URL("./src/server/stubs/ast-grep-napi.ts", import.meta.url)),
            },
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
})
