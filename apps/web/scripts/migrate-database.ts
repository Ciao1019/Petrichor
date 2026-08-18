import fs from "node:fs"
import path from "node:path"
import postgres from "postgres"
import {
    migrationChecksum,
    parseMigrationManifest,
    splitSqlStatements,
} from "../src/server/db/migration-utils"

const productionOnly = process.argv.includes("--vercel-production-only")
if (productionOnly && process.env.VERCEL_ENV !== "production") {
    console.log(`[db:migrate] 跳过 ${process.env.VERCEL_ENV ?? "非 Vercel"} 环境`)
    process.exit(0)
}

const databaseUrl = process.env.MIGRATION_DATABASE_URL?.trim()
    || process.env.DATABASE_URL?.trim()
if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL 和 DATABASE_URL 均未设置")
}
if (databaseUrl.startsWith("file:")) {
    throw new Error("自动 SQL 迁移仅支持 PostgreSQL")
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const migrationsDirectory = path.join(repositoryRoot, "docs/migrations")
const manifestPath = path.join(migrationsDirectory, "manifest.json")
const manifest = parseMigrationManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")))
const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 20,
    idle_timeout: 5,
})

type AppliedMigration = {
    filename: string
    checksum: string
}

try {
    await client.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtext('petrichor-schema-migrations'))`
        await transaction.unsafe(`
            create table if not exists petrichor_schema_migration (
                filename text primary key,
                checksum text not null,
                applied_at timestamptz not null default now(),
                execution_ms integer not null
            )
        `)

        const appliedRows = await transaction<AppliedMigration[]>`
            select filename, checksum
            from petrichor_schema_migration
            order by filename asc
        `
        const applied = new Map(appliedRows.map((row) => [row.filename, row.checksum]))
        let appliedCount = 0

        for (const entry of manifest.migrations) {
            const migrationPath = path.join(migrationsDirectory, entry.file)
            if (!fs.existsSync(migrationPath)) {
                throw new Error(`迁移文件不存在：${entry.file}`)
            }

            const rawSql = fs.readFileSync(migrationPath, "utf8")
            const checksum = migrationChecksum(rawSql)
            const recordedChecksum = applied.get(entry.file)
            if (recordedChecksum) {
                if (recordedChecksum !== checksum) {
                    throw new Error(`已执行的迁移被修改：${entry.file}`)
                }
                console.log(`[db:migrate] 已执行 ${entry.file}`)
                continue
            }

            const statements = splitSqlStatements(rawSql)
            if (statements.length === 0) {
                throw new Error(`迁移文件不包含可执行 SQL：${entry.file}`)
            }

            console.log(`[db:migrate] 执行 ${entry.file}（${statements.length} 条语句）`)
            const startedAt = Date.now()
            for (const statement of statements) {
                await transaction.unsafe(statement)
            }
            const executionMs = Date.now() - startedAt

            await transaction`
                insert into petrichor_schema_migration (filename, checksum, execution_ms)
                values (${entry.file}, ${checksum}, ${executionMs})
            `
            appliedCount += 1
            console.log(`[db:migrate] 完成 ${entry.file}（${executionMs}ms）`)
        }

        console.log(`[db:migrate] 检查完成，新执行 ${appliedCount} 个迁移`)
    })
} finally {
    await client.end()
}
