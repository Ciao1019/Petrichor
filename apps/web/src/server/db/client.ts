import Database from "better-sqlite3"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { getServerConfig } from "@/config/server"
import * as schema from "./schema"
import { runSqliteMigration } from "./sqlite-migration"

let client: postgres.Sql | null = null
let sqliteClient: Database.Database | null = null
let sqliteMigrated = false
type Db = ReturnType<typeof drizzlePostgres<typeof schema>>
let db: Db | null = null

function isSqliteUrl(databaseUrl: string) {
    return process.env.PETRICHOR_DB_DIALECT === "sqlite" || databaseUrl.startsWith("file:")
}

export function isSqliteDatabase() {
    return isSqliteUrl(getServerConfig().databaseUrl)
}

function sqlitePathFromUrl(databaseUrl: string) {
    return databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl
}

export function getSqlClient() {
    if (isSqliteDatabase()) {
        throw new Error("当前运行在 SQLite 模式，getSqlClient 仅用于 PostgreSQL")
    }
    client ??= postgres(getServerConfig().databaseUrl, {
        max: 5,
        prepare: false,
    })
    return client
}

function getSqliteClient() {
    const databaseUrl = getServerConfig().databaseUrl
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
    if (db) {
        return db
    }

    db = isSqliteDatabase()
        ? drizzleSqlite(getSqliteClient(), { schema }) as unknown as Db
        : drizzlePostgres(getSqlClient(), { schema })
    return db
}
