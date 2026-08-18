import { createHash } from "node:crypto"
import path from "node:path"

/** 生产自动迁移清单的版本化结构。 */
export type MigrationManifest = {
    version: 1
    migrations: Array<{
        file: string
    }>
}

export function parseMigrationManifest(value: unknown): MigrationManifest {
    if (!value || typeof value !== "object") {
        throw new Error("迁移清单必须是 JSON 对象")
    }

    const record = value as Record<string, unknown>
    if (record.version !== 1) {
        throw new Error("不支持的迁移清单版本")
    }
    if (!Array.isArray(record.migrations)) {
        throw new Error("迁移清单缺少 migrations 数组")
    }

    const seen = new Set<string>()
    const migrations = record.migrations.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
            throw new Error(`第 ${index + 1} 个迁移配置无效`)
        }

        const file = (entry as Record<string, unknown>).file
        if (typeof file !== "string" || !file.endsWith(".sql")) {
            throw new Error(`第 ${index + 1} 个迁移必须指定 .sql 文件`)
        }
        if (path.basename(file) !== file) {
            throw new Error(`迁移文件只能使用文件名：${file}`)
        }
        if (seen.has(file)) {
            throw new Error(`迁移文件重复：${file}`)
        }

        seen.add(file)
        return { file }
    })

    const sorted = migrations.map((entry) => entry.file).sort()
    for (const [index, migration] of migrations.entries()) {
        if (migration.file !== sorted[index]) {
            throw new Error("迁移清单必须按文件名升序排列")
        }
    }

    return { version: 1, migrations }
}

export function migrationChecksum(sql: string): string {
    return createHash("sha256").update(sql).digest("hex")
}

export function splitSqlStatements(source: string): string[] {
    const statements: string[] = []
    let current = ""
    let state: "normal" | "single" | "double" | "line-comment" | "block-comment" | "dollar" = "normal"
    let blockDepth = 0
    let dollarTag = ""

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index]
        const next = source[index + 1]

        if (state === "line-comment") {
            if (char === "\n") {
                current += "\n"
                state = "normal"
            }
            continue
        }

        if (state === "block-comment") {
            if (char === "/" && next === "*") {
                blockDepth += 1
                index += 1
                continue
            }
            if (char === "*" && next === "/") {
                blockDepth -= 1
                index += 1
                if (blockDepth === 0) {
                    current += " "
                    state = "normal"
                }
            }
            continue
        }

        if (state === "single") {
            current += char
            if (char === "'" && next === "'") {
                current += next
                index += 1
            } else if (char === "'" && source[index - 1] !== "\\") {
                state = "normal"
            }
            continue
        }

        if (state === "double") {
            current += char
            if (char === "\"" && next === "\"") {
                current += next
                index += 1
            } else if (char === "\"") {
                state = "normal"
            }
            continue
        }

        if (state === "dollar") {
            if (source.startsWith(dollarTag, index)) {
                current += dollarTag
                index += dollarTag.length - 1
                state = "normal"
            } else {
                current += char
            }
            continue
        }

        if (char === "-" && next === "-") {
            state = "line-comment"
            index += 1
            continue
        }
        if (char === "/" && next === "*") {
            state = "block-comment"
            blockDepth = 1
            index += 1
            continue
        }
        if (char === "'") {
            current += char
            state = "single"
            continue
        }
        if (char === "\"") {
            current += char
            state = "double"
            continue
        }
        if (char === "$") {
            const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
            if (match) {
                dollarTag = match[0]
                current += dollarTag
                index += dollarTag.length - 1
                state = "dollar"
                continue
            }
        }
        if (char === ";") {
            const statement = current.trim()
            if (statement) statements.push(statement)
            current = ""
            continue
        }

        current += char
    }

    if (state === "single" || state === "double" || state === "block-comment" || state === "dollar") {
        throw new Error(`SQL 文件存在未闭合的 ${state}`)
    }

    const trailing = current.trim()
    if (trailing) statements.push(trailing)
    return statements
}
