import { readdir, rm } from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.resolve(import.meta.dir, "..")
const rootModules = path.join(repositoryRoot, "node_modules")

await Promise.all([
    pruneModuleLinks(rootModules),
    pruneModuleLinks(path.join(repositoryRoot, "apps/web/node_modules")),
    pruneBunStore(path.join(rootModules, ".bun")),
])

async function pruneBunStore(storeDirectory: string) {
    const entries = await readDirectory(storeDirectory)

    await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(storeDirectory, entry.name)
        if (entry.name === "next" || entry.name.startsWith("next@") || entry.name.startsWith("@next+")) {
            await rm(entryPath, { force: true, recursive: true })
            return
        }

        if (entry.name === "node_modules") {
            await pruneModuleLinks(entryPath)
            return
        }

        if (entry.isDirectory()) {
            await pruneModuleLinks(path.join(entryPath, "node_modules"))
        }
    }))
}

async function pruneModuleLinks(modulesDirectory: string) {
    await Promise.all([
        rm(path.join(modulesDirectory, "next"), { force: true, recursive: true }),
        rm(path.join(modulesDirectory, "@next"), { force: true, recursive: true }),
        rm(path.join(modulesDirectory, ".bin/next"), { force: true, recursive: true }),
    ])
}

async function readDirectory(directory: string) {
    try {
        return await readdir(directory, { withFileTypes: true })
    } catch (error) {
        if (isMissingDirectory(error)) return []
        throw error
    }
}

function isMissingDirectory(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
}
