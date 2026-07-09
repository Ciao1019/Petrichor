import { createRequire } from "node:module"
import type BetterSqlite3 from "better-sqlite3"
import type { drizzle as drizzleSqliteType } from "drizzle-orm/better-sqlite3"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { getServerConfig } from "@/config/server"
import * as schema from "./schema"
import { runSqliteMigration } from "./sqlite-migration"

// better-sqlite3 是原生模块，只在 SQLite 模式下用于本地开发。
// 用惰性 require 加载，避免在无原生模块的运行时因顶层 import 直接加载失败
// （生产部署走 PostgreSQL，永远不会触达这里）。
function loadSqliteDeps() {
    const require = createRequire(import.meta.url)
    const Database = require("better-sqlite3") as typeof BetterSqlite3
    const { drizzle: drizzleSqlite } = require(
        "drizzle-orm/better-sqlite3",
    ) as { drizzle: typeof drizzleSqliteType }
    return { Database, drizzleSqlite }
}

type Db = ReturnType<typeof drizzlePostgres<typeof schema>>

let sqliteClient: BetterSqlite3.Database | null = null
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
    sqliteClient.pragma("journal_mode = WAL")
    sqliteClient.pragma("foreign_keys = ON")
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
