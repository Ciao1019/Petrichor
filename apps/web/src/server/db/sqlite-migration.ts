import { buildInitialMigrationSql } from "@/server/db/full-migration"

function toSingleQuotedSql(value: string) {
    return `'${value.replace(/'/g, "''")}'`
}

function replaceDollarQuotedStrings(sql: string) {
    return sql.replace(/\$([a-zA-Z0-9_]+)\$([\s\S]*?)\$\1\$/g, (_match, _tag, body: string) =>
        toSingleQuotedSql(body))
}

function splitStatements(sql: string) {
    return sql
        .split(/;\s*\n/g)
        .map((statement) => statement.trim())
        .filter(Boolean)
}

function shouldSkipStatement(statement: string) {
    const normalized = statement.trimStart().toLowerCase()
    return (
        normalized.includes("create extension") ||
        normalized.includes("alter table") ||
        normalized.startsWith("update ") ||
        normalized.startsWith("insert into better_auth_user") ||
        normalized.startsWith("insert into better_auth_account") ||
        normalized.includes(" using gin ")
    )
}

function convertStatement(statement: string) {
    return replaceDollarQuotedStrings(statement)
        .replace(
            /(\s+original_author_name text,\n)(\s+revoked_at timestamptz,)/i,
            "$1    pin_order integer,\n$2",
        )
        .replace(/\bbigint generated always as identity primary key\b/gi, "integer primary key autoincrement")
        .replace(/\bbigint\b/gi, "integer")
        .replace(/\btimestamptz\b/gi, "integer")
        .replace(/\bboolean\b/gi, "integer")
        .replace(/\bdefault now\(\)/gi, "default (unixepoch() * 1000)")
        .replace(/\bdefault true\b/gi, "default 1")
        .replace(/\bdefault false\b/gi, "default 0")
        .replace(/\bvalues \(1, true\)/gi, "values (1, 1)")
        .replace(/\bwhere is_default = true\b/gi, "where is_default = 1")
}

export function buildSqliteMigrationSql() {
    const statements = splitStatements(buildInitialMigrationSql())
        .filter((statement) => !shouldSkipStatement(statement))
        .map(convertStatement)

    return [
        "pragma foreign_keys = on",
        ...statements,
    ].join(";\n\n")
}

export function runSqliteMigration(client: { exec: (sql: string) => unknown }) {
    client.exec(buildSqliteMigrationSql())
}
