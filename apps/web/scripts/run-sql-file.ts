import fs from "node:fs"
import path from "node:path"
import postgres from "postgres"
import { readGoDatabaseUrl } from "./go-config"

const file = process.argv[2]
if (!file) {
    throw new Error("用法：tsx scripts/run-sql-file.ts <path-to-sql>")
}
const url = await readGoDatabaseUrl({ preferMigration: true })

const raw = fs.readFileSync(path.resolve(file), "utf8")
// 去掉整行注释后按分号切分，逐条执行（Supabase 连的是事务池，多语句一次发容易出问题）
const statements = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)

const sql = postgres(url, { max: 1, prepare: false })

try {
    console.log(`共 ${statements.length} 条语句\n`)
    for (const [index, statement] of statements.entries()) {
        const preview = statement.replace(/\s+/g, " ").slice(0, 100)
        process.stdout.write(`[${index + 1}/${statements.length}] ${preview}\n`)
        await sql.unsafe(statement)
        console.log("    ✓ ok")
    }
    console.log("\n迁移执行完毕")
} finally {
    await sql.end()
}
