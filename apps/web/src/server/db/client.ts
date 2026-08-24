import { createRequire } from "node:module"
import type { Database as BunSqliteDatabase } from "bun:sqlite"
import type { drizzle as drizzleSqliteType } from "drizzle-orm/bun-sqlite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { getServerConfig } from "@/config/server"
import * as schema from "./schema"
import { runSqliteMigration } from "./sqlite-migration"

// Vitest、ESLint、tsc 仍由各自的 Node CLI 执行。Bun 专属模块必须惰性加载，
// 这样质量工具可以导入服务端模块，而 Bun 开发/生产运行时进入 SQLite 分支时
// 仍使用原生 bun:sqlite 与对应的 Drizzle 驱动。
function loadSqliteDeps() {
    const require = createRequire(import.meta.url)
    const { Database } = require("bun:sqlite") as { Database: typeof BunSqliteDatabase }
    const { drizzle: drizzleSqlite } = require(
        "drizzle-orm/bun-sqlite",
    ) as { drizzle: typeof drizzleSqliteType }
    return { Database, drizzleSqlite }
}

type Db = ReturnType<typeof drizzlePostgres<typeof schema>>

let sqliteClient: BunSqliteDatabase | null = null
let sqliteDb: Db | null = null
let sqliteMigrated = false
let pgDb: Db | null = null

function isSqliteUrl(databaseUrl: string) {
    return process.env.PETRICHOR_DB_DIALECT === "sqlite" || databaseUrl.startsWith("file:")
}

export function isSqliteDatabase() {
    return isSqliteUrl(getServerConfig().databaseUrl)
}

function sqlitePathFromUrl(databaseUrl: string) {
    return databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl
}

function createPgDb(): Db {
    const client = postgres(getServerConfig().databaseUrl, {
        max: 1,
        prepare: false,
    })
    return drizzlePostgres(client, { schema })
}

function getPgDb(): Db {
    pgDb ??= createPgDb()
    return pgDb
}

export function getSqlClient() {
    if (isSqliteDatabase()) {
        throw new Error("当前运行在 SQLite 模式，getSqlClient 仅用于 PostgreSQL")
    }
    return postgres(getServerConfig().databaseUrl, {
        max: 1,
        prepare: false,
    })
}

function getSqliteClient() {
    const databaseUrl = getServerConfig().databaseUrl
    const { Database } = loadSqliteDeps()
    sqliteClient ??= new Database(sqlitePathFromUrl(databaseUrl))
    sqliteClient.exec("pragma journal_mode = WAL")
    sqliteClient.exec("pragma foreign_keys = ON")
    if (!sqliteMigrated) {
        runSqliteMigration(sqliteClient)
        sqliteMigrated = true
    }
    return sqliteClient
}

export function getDb(): Db {
    if (isSqliteDatabase()) {
        if (!sqliteDb) {
            const { drizzleSqlite } = loadSqliteDeps()
            sqliteDb = drizzleSqlite(getSqliteClient(), { schema }) as unknown as Db
        }
        return sqliteDb
    }
    return getPgDb()
}
