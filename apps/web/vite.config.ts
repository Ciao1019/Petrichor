import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
    plugins: [react(), tailwindcss()],
    envPrefix: ["VITE_", "PETRICHOR_PUBLIC_"],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            "@ast-grep/napi": fileURLToPath(new URL("./src/server/stubs/ast-grep-napi.ts", import.meta.url)),
        },
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
