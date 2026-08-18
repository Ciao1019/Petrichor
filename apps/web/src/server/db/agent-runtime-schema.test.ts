import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"
import { buildInitialMigrationSql } from "./full-migration"
import { buildSqliteMigrationSql } from "./sqlite-migration"

/**
 * 库表结构自检。
 *
 * 教训：BM25 词元列一度只写在 alter table 里，而 SQLite 迁移会跳过所有 alter，
 * 导致 SQLite/全新安装缺列、写树节点直接失败。这类问题必须由测试兜住。
 */

const require = createRequire(import.meta.url)
const hasSqlite = (() => {
    try {
        require("better-sqlite3")
        return true
    } catch {
        return false
    }
})()

const BM25_COLUMNS = ["search_title_tokens", "search_summary_tokens", "search_content_tokens"]
const AGENT_TABLES = [
    "petrichor_agent_run",
    "petrichor_agent_trace_event",
    "petrichor_agent_evidence",
    "petrichor_agent_subtask",
]

describe("初始化 SQL", () => {
    const sql = buildInitialMigrationSql()

    it("包含全部 Agent Runtime 表", () => {
        for (const table of AGENT_TABLES) {
            expect(sql, table).toContain(`create table if not exists ${table}`)
        }
    })

    it("BM25 词元列写在 create table 里，而不只有 alter table", () => {
        const createStatement = sql.slice(
            sql.indexOf("create table if not exists petrichor_kb_wiki_tree_node"),
        ).split(");")[0]
        for (const column of BM25_COLUMNS) {
            expect(createStatement, column).toContain(column)
        }
    })

    it("仍保留 alter table，供已有 Postgres 实例增量升级", () => {
        expect(sql).toContain("alter table petrichor_kb_wiki_tree_node")
        expect(sql).toContain("add column if not exists search_title_tokens")
    })

    it("search_vector 生成列按 title>summary>content 加权", () => {
        expect(sql).toContain("setweight(to_tsvector('simple', coalesce(search_title_tokens, '')), 'A')")
        expect(sql).toContain("setweight(to_tsvector('simple', coalesce(search_summary_tokens, '')), 'B')")
        expect(sql).toContain("setweight(to_tsvector('simple', coalesce(search_content_tokens, '')), 'C')")
    })
})

describe("SQLite 迁移", () => {
    const sql = buildSqliteMigrationSql()

    it("同样建出 Agent Runtime 表", () => {
        for (const table of AGENT_TABLES) {
            expect(sql, table).toContain(table)
        }
    })

    it("词元列存在（alter table 被跳过，只能靠 create table 带出来）", () => {
        for (const column of BM25_COLUMNS) {
            expect(sql, column).toContain(column)
        }
    })

    it("不包含 Postgres 专有的生成列与 GIN 索引", () => {
        expect(sql).not.toContain("to_tsvector")
        expect(sql).not.toContain("using gin")
    })
})

describe.runIf(hasSqlite)("真实建库后可写入", () => {
    let db: typeof import("./client").getDb
    let schema: typeof import("./schema")

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-schema-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"
        ;({ getDb: db } = await import("./client"))
        schema = await import("./schema")
    })

    it("树节点带 BM25 词元列可以正常写入与读回", async () => {
        const client = db()
        // 树节点有 user/kb/page/article 四个外键，按真实链路把父行建全，
        // 避免用「关掉外键」的方式绕过——那样测不出真实写入路径
        const [user] = await client.insert(schema.users).values({
            email: "schema-check@example.test",
            passwordHash: "test-only",
        }).returning({ id: schema.users.id })
        const [kb] = await client.insert(schema.knowledgeBases).values({
            userId: user.id,
            name: "测试库",
        }).returning({ id: schema.knowledgeBases.id })
        const [node] = await client.insert(schema.knowledgeBaseNodes).values({
            userId: user.id,
            knowledgeBaseId: kb.id,
            name: "根",
            type: "FOLDER",
        }).returning({ id: schema.knowledgeBaseNodes.id })
        const [article] = await client.insert(schema.knowledgeBaseArticles).values({
            userId: user.id,
            knowledgeBaseId: kb.id,
            nodeId: node.id,
            title: "Redis 部署",
            contentMd: "使用 Sentinel",
        }).returning({ id: schema.knowledgeBaseArticles.id })
        const [page] = await client.insert(schema.knowledgeBaseWikiPages).values({
            userId: user.id,
            knowledgeBaseId: kb.id,
            pageKey: "redis",
            title: "Redis",
            kind: "source",
            contentMd: "使用 Sentinel",
            contentHash: "hash",
        }).returning({ id: schema.knowledgeBaseWikiPages.id })

        await client.insert(schema.knowledgeBaseWikiTreeNodes).values({
            userId: user.id,
            knowledgeBaseId: kb.id,
            pageId: page.id,
            articleId: article.id,
            nodeKey: "a1-0",
            depth: 0,
            position: 0,
            title: "Redis 部署",
            contentMd: "使用 Sentinel",
            contentHash: "hash",
            searchTitleTokens: "redis 部署",
            searchSummaryTokens: "",
            searchContentTokens: "使用 sentinel",
        })

        const [row] = await client.select().from(schema.knowledgeBaseWikiTreeNodes).limit(1)
        expect(row.searchTitleTokens).toBe("redis 部署")
        expect(row.searchContentTokens).toContain("sentinel")
    })

    it("Agent Run 表可写入并按 run_key 唯一", async () => {
        const client = db()
        await client.insert(schema.agentRuns).values({
            runKey: "run_schema_check",
            conversationId: "1",
            userId: 1,
            model: "m",
            goal: "g",
        })
        const rows = await client.select().from(schema.agentRuns)
        expect(rows.map((row) => row.runKey)).toContain("run_schema_check")
    })
})
