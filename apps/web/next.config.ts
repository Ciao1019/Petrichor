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
    // sharp 是原生模块，交给运行时直接 require，不要打进 server bundle。
    serverExternalPackages: ["sharp"],
    typedRoutes: false,
}

export default nextConfig
