import type { NextConfig } from "next"
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare"
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
    typedRoutes: false,
}

export default nextConfig

if (process.env.NODE_ENV === "development") {
    initOpenNextCloudflareForDev()
}
