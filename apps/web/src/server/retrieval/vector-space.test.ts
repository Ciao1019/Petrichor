import { describe, expect, it, vi } from "vitest"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
    isSqliteDatabase: vi.fn(() => false),
}))
vi.mock("@/server/db/client", () => dbMocks)

import {
    cosineDistance,
    cosineSimilarity,
    ensureVectorIndexes,
    isValidDimensions,
    MAX_INDEXABLE_DIMENSIONS,
    VECTOR_TABLES,
    whereSameDimension,
} from "./vector-space"

/** 把 drizzle 的 SQL 片段还原成可断言的字符串（占位符按顺序填回） */
function render(fragment: { queryChunks?: unknown[] }): string {
    const chunks = fragment.queryChunks ?? []
    return chunks
        .map((chunk) => {
            if (chunk == null) return ""
            const value = chunk as { value?: unknown; queryChunks?: unknown[] }
            if (Array.isArray(value.queryChunks)) return render(value as { queryChunks: unknown[] })
            if (Array.isArray(value.value)) return (value.value as unknown[]).join("")
            if (value.value !== undefined) return String(value.value)
            return ""
        })
        .join("")
}

describe("isValidDimensions", () => {
    it("挡掉 0、负数、小数和超大值", () => {
        expect(isValidDimensions(1024)).toBe(true)
        expect(isValidDimensions(8)).toBe(true)
        expect(isValidDimensions(0)).toBe(false)
        expect(isValidDimensions(-1)).toBe(false)
        expect(isValidDimensions(7)).toBe(false)
        expect(isValidDimensions(1024.5)).toBe(false)
        expect(isValidDimensions(20_000)).toBe(false)
        expect(isValidDimensions("1024")).toBe(false)
        expect(isValidDimensions(null)).toBe(false)
    })
})

describe("查询片段", () => {
    /**
     * 两侧都要转型到 vector(N)，否则命中不了部分表达式索引；
     * 而且跨维度做 <=> pgvector 会直接抛错。
     */
    it("cosineDistance 对列和参数都做同维度转型", () => {
        const sql = render(cosineDistance("embedding", "[0.1,0.2]", 1536))
        expect(sql).toContain("embedding::vector(1536)")
        expect(sql).toContain("<=>")
        expect(sql).toContain("::vector(1536)")
    })

    it("cosineSimilarity 是 1 - 距离", () => {
        const sql = render(cosineSimilarity("e.embedding", "[0.1]", 768))
        expect(sql).toContain("1 - (")
        expect(sql).toContain("e.embedding::vector(768)")
    })

    it("whereSameDimension 生成维度过滤", () => {
        expect(render(whereSameDimension("embedding", 1024))).toBe("vector_dims(embedding) = 1024")
    })

    it("维度参数强制转数字，不把字符串拼进 SQL", () => {
        expect(render(whereSameDimension("embedding", "1024; drop table x" as unknown as number)))
            .toBe("vector_dims(embedding) = NaN")
    })
})

describe("ensureVectorIndexes", () => {
    function mockExecute() {
        const execute = vi.fn(async (_statement: { queryChunks: unknown[] }) => undefined)
        dbMocks.getDb.mockReturnValue({ execute })
        return execute
    }

    it("为每张向量表建一条该维度的部分索引", async () => {
        const execute = mockExecute()
        const result = await ensureVectorIndexes(1536)

        expect(result.indexed).toBe(true)
        expect(result.created).toHaveLength(VECTOR_TABLES.length)
        expect(execute).toHaveBeenCalledTimes(VECTOR_TABLES.length)

        const statements = execute.mock.calls.map(([statement]) => render(statement))
        for (const { table } of VECTOR_TABLES) {
            const statement = statements.find((text) => text.includes(` on ${table} `))
            expect(statement).toBeDefined()
            expect(statement).toContain("create index if not exists")
            expect(statement).toContain("using hnsw ((embedding::vector(1536)) vector_cosine_ops)")
            expect(statement).toContain("where vector_dims(embedding) = 1536")
        }
        // 索引名带维度后缀，不同维度互不冲突
        expect(result.created.every((name) => name.endsWith("_d1536"))).toBe(true)
    })

    /** 超过 HNSW 上限不报错，只是不建索引——报错会堵住写入 */
    it("超过 HNSW 上限时跳过建索引且不抛错", async () => {
        const execute = mockExecute()
        const result = await ensureVectorIndexes(MAX_INDEXABLE_DIMENSIONS + 1)

        expect(result).toEqual({ created: [], indexed: false })
        expect(execute).not.toHaveBeenCalled()
    })

    it("非法维度直接跳过", async () => {
        const execute = mockExecute()
        expect(await ensureVectorIndexes(0)).toEqual({ created: [], indexed: false })
        expect(await ensureVectorIndexes(-1)).toEqual({ created: [], indexed: false })
        expect(execute).not.toHaveBeenCalled()
    })

    it("SQLite 下不执行任何 DDL", async () => {
        const execute = mockExecute()
        dbMocks.isSqliteDatabase.mockReturnValueOnce(true)

        expect(await ensureVectorIndexes(1024)).toEqual({ created: [], indexed: false })
        expect(execute).not.toHaveBeenCalled()
    })
})
