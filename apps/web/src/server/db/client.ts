import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { getServerConfig } from "@/config/server"
import * as schema from "./schema"

let client: postgres.Sql | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getSqlClient() {
    client ??= postgres(getServerConfig().databaseUrl, {
        max: 5,
        prepare: false,
    })
    return client
}

export function getDb() {
    db ??= drizzle(getSqlClient(), { schema })
    return db
}
