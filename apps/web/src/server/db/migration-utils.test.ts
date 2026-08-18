import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
    migrationChecksum,
    parseMigrationManifest,
    splitSqlStatements,
} from "./migration-utils"

describe("数据库迁移清单", () => {
    it("读取按顺序登记的 SQL 文件", () => {
        expect(parseMigrationManifest({
            version: 1,
            migrations: [
                { file: "2026-08-18-agent-runtime-v2.sql" },
                { file: "2026-08-19-example.sql" },
            ],
        }).migrations).toHaveLength(2)
    })

    it("拒绝路径穿越、重复和乱序条目", () => {
        expect(() => parseMigrationManifest({
            version: 1,
            migrations: [{ file: "../secret.sql" }],
        })).toThrow("只能使用文件名")
        expect(() => parseMigrationManifest({
            version: 1,
            migrations: [{ file: "a.sql" }, { file: "a.sql" }],
        })).toThrow("重复")
        expect(() => parseMigrationManifest({
            version: 1,
            migrations: [{ file: "b.sql" }, { file: "a.sql" }],
        })).toThrow("升序")
    })
})

describe("SQL 语句拆分", () => {
    it("不会在字符串、注释和 dollar quote 内错误拆分", () => {
        const sql = `
            -- comment ;
            insert into example(value) values ('a;b');
            /* nested /* ; */ comment */
            do $$ begin perform ';'; end $$;
            select "semi;colon";
        `

        expect(splitSqlStatements(sql)).toEqual([
            "insert into example(value) values ('a;b')",
            "do $$ begin perform ';'; end $$",
            "select \"semi;colon\"",
        ])
    })

    it("可以解析当前自动迁移文件", () => {
        const migrationPath = path.resolve(
            process.cwd(),
            "../../docs/migrations/2026-08-18-agent-runtime-v2.sql",
        )
        const statements = splitSqlStatements(fs.readFileSync(migrationPath, "utf8"))

        expect(statements.length).toBeGreaterThan(10)
        expect(statements.some((statement) => statement.includes("petrichor_agent_run"))).toBe(true)
    })
})

describe("迁移文件校验和", () => {
    it("对相同内容生成稳定校验和", () => {
        expect(migrationChecksum("select 1")).toBe(migrationChecksum("select 1"))
        expect(migrationChecksum("select 1")).not.toBe(migrationChecksum("select 2"))
    })
})
