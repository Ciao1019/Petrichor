import { readdir } from "node:fs/promises"
import path from "node:path"

const routesRoot = path.resolve(import.meta.dir, "../src/server/routes")
const outputPath = path.resolve(import.meta.dir, "../src/server/bun/routes.generated.ts")

async function collectRouteFiles(directory: string): Promise<string[]> {
    const files: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            files.push(...await collectRouteFiles(absolutePath))
        } else if (entry.name === "route.ts") {
            files.push(absolutePath)
        }
    }
    return files
}

function toImportPath(file: string) {
    const relative = path.relative(path.dirname(outputPath), file).replaceAll(path.sep, "/").replace(/\.ts$/, "")
    return relative.startsWith(".") ? relative : `./${relative}`
}

function toRoutePath(file: string) {
    const relative = path.relative(routesRoot, path.dirname(file)).replaceAll(path.sep, "/")
    return `/${relative}`.replace(/\/$/, "") || "/"
}

const files = (await collectRouteFiles(routesRoot)).sort()
const imports = files.map((file, index) => `import * as route${index} from "${toImportPath(file)}"`)
const definitions = files.map((file, index) => `    { path: ${JSON.stringify(toRoutePath(file))}, module: route${index} },`)
const source = `${imports.join("\n")}

import type { RouteDefinition } from "./types"

// 此文件由 scripts/generate-route-manifest.ts 生成，请勿手工编辑。
export const routeDefinitions: RouteDefinition[] = [
${definitions.join("\n")}
]
`

await Bun.write(outputPath, source)
console.log(`已生成 ${files.length} 条 Bun API 路由：${outputPath}`)

