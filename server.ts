import path from "node:path"
import { createBunApp } from "./apps/web/src/server/bun/app"

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? "0.0.0.0"

const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    fetch: createBunApp({
        staticDirectory: path.join(import.meta.dir, "apps/web/dist"),
        developmentAssetsUrl: process.env.PETRICHOR_VITE_DEV_SERVER_URL,
    }),
})

console.log(`Petrichor Bun server: ${server.url}`)

