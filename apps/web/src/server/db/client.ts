import { createRequire } from "node:module"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type BetterSqlite3 from "better-sqlite3"
import type { drizzle as drizzleSqliteType } from "drizzle-orm/better-sqlite3"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { getServerConfig } from "@/config/server"
import * as schema from "./schema"
import { runSqliteMigration } from "./sqlite-migration"

// better-sqlite3 是原生模块，只在 SQLite 模式下用于本地开发。
// 用惰性 require 加载，避免在 Cloudflare Workers 等无原生模块的运行时
// 因顶层 import 直接加载失败（生产部署走 PostgreSQL，永远不会触达这里）。
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

// 本地 Node（非 Workers）下的 PostgreSQL 连接单例。
let localPgDb: Db | null = null
// Cloudflare Workers 下按「当前请求」缓存的连接。workerd 里 TCP socket 绑定
// 创建它的那个请求，跨请求复用会抛 "Cannot perform I/O on behalf of a
// different request" 并导致请求挂死。因此每个请求必须用独立连接。
const pgDbByRequest = new WeakMap<object, Db>()

function isSqliteUrl(databaseUrl: string) {
    return process.env.PETRICHOR_DB_DIALECT === "sqlite" || databaseUrl.startsWith("file:")
}

export function isSqliteDatabase() {
    return isSqliteUrl(getServerConfig().databaseUrl)
}

function sqlitePathFromUrl(databaseUrl: string) {
    return databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl
}

function isCloudflareWorkers() {
    return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined"
}

// 取当前 Cloudflare 请求的执行上下文（每个请求唯一），作为按请求缓存连接的键。
// 非 Workers 或拿不到上下文时返回 null。
function currentRequestKey(): object | null {
    try {
        return getCloudflareContext().ctx ?? null
    } catch {
        return null
    }
}

function createPgDb(): Db {
    const client = postgres(getServerConfig().databaseUrl, {
        // 每请求一个连接，单连接即可；并发查询由 postgres.js 在该连接上排队。
        max: 1,
        prepare: false,
    })
    return drizzlePostgres(client, { schema })
}

function getPgDb(): Db {
    if (isCloudflareWorkers()) {
        const key = currentRequestKey()
        if (key) {
            let requestDb = pgDbByRequest.get(key)
            if (!requestDb) {
                requestDb = createPgDb()
                pgDbByRequest.set(key, requestDb)
            }
            return requestDb
        }
        // 拿不到请求上下文时宁可每次新建，也绝不退化成跨请求复用的单例。
        return createPgDb()
    }
    // 本地 Node / 非 Workers：无跨请求 I/O 限制，单例复用即可。
    localPgDb ??= createPgDb()
    return localPgDb
}

// 仅保留给可能的原生 SQL 场景；同样遵循「不缓存跨请求连接」原则。
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
