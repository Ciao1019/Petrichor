import { buildInitialMigrationSql } from "../src/server/db/full-migration"

try {
    const sql = buildInitialMigrationSql()

    process.stdout.write(`${sql}\n`)
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`生成 Supabase 初始化 SQL 失败：${message}\n`)
    process.exitCode = 1
}
