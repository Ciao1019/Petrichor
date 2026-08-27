import path from "node:path"

type GoConfigFile = {
    database?: {
        url?: unknown
        migration_url?: unknown
    }
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const configPath = path.join(repositoryRoot, "apps/api/config.toml")

export async function readGoDatabaseUrl(options: { preferMigration?: boolean } = {}) {
    const file = Bun.file(configPath)
    if (!await file.exists()) {
        throw new Error(`未找到 ${configPath}，请先从 apps/api/config.example.toml 复制并填写`)
    }

    const parsed = Bun.TOML.parse(await file.text()) as GoConfigFile
    const runtimeURL = stringValue(parsed.database?.url)
    const migrationURL = stringValue(parsed.database?.migration_url)
    const selected = options.preferMigration ? migrationURL || runtimeURL : runtimeURL
    if (!selected) {
        throw new Error(`apps/api/config.toml 中的 database.${options.preferMigration ? "migration_url 或 database.url" : "url"} 不能为空`)
    }
    return selected
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : ""
}
