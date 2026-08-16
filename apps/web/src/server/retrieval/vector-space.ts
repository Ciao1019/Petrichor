/**
 * 多维度向量空间。
 *
 * pgvector 的 HNSW 索引要求「有声明维度」的列，但那样会把维度写死在 DDL 里，
 * 换一个输出维度不同的向量模型就得清库重建。这里改用另一种组合：
 *
 *   - 列声明为无约束的 `vector`，因此不同维度的行可以共存；
 *   - 每个实际用到的维度建一条**部分表达式索引**：
 *       create index ... using hnsw ((embedding::vector(N)) vector_cosine_ops)
 *       where vector_dims(embedding) = N
 *   - 查询时带上 `vector_dims(embedding) = N` 过滤并对列做同样的转型，
 *     planner 就会命中对应维度的索引。
 *
 * 代价是查询必须显式带维度（跨维度比较 pgvector 会直接报错，
 * 所以这个过滤本来也是必需的），换来的是换模型无需清空历史向量：
 * 旧维度的行留在原地，被 `embedding_dimensions` 元数据判定为待重算。
 *
 * 注意：维度相同不等于向量空间相同。两个都输出 1024 维的模型互换后，
 * `vector_dims` 过滤挡不住旧向量——所以有元数据列的表还要比对
 * `embedding_model` / `embedding_version`，见 kb/wiki-tree.ts。
 */

import { sql, type SQL } from "drizzle-orm"
import { getDb, isSqliteDatabase } from "@/server/db/client"

/** 带向量列的表，以及各自的向量列名 */
export const VECTOR_TABLES = [
    { table: "petrichor_kb_wiki_tree_node", column: "embedding" },
    { table: "petrichor_agent_memory", column: "embedding" },
    { table: "petrichor_assistant_message_embedding", column: "embedding" },
] as const

/** pgvector 的 HNSW 索引上限；超过这个维度只能顺序扫描 */
export const MAX_INDEXABLE_DIMENSIONS = 2000

/** 合法维度范围，用于校验探测结果 */
export const MIN_DIMENSIONS = 8
export const MAX_DIMENSIONS = 16_000

export function isValidDimensions(value: unknown): value is number {
    return Number.isInteger(value)
        && (value as number) >= MIN_DIMENSIONS
        && (value as number) <= MAX_DIMENSIONS
}

/** 索引命名：idx_<表名去前缀>_embedding_d<维度> */
function indexNameFor(table: string, dimensions: number) {
    return `${table}_embedding_d${dimensions}`.replace(/^petrichor_/, "idx_petrichor_")
}

/**
 * 为某个维度补齐各向量表的部分索引。幂等，且只在维度首次出现时才有实际开销。
 *
 * 维度超过 HNSW 上限时跳过建索引（查询降级为顺序扫描，功能仍然正确）。
 */
export async function ensureVectorIndexes(dimensions: number): Promise<{
    created: string[]
    indexed: boolean
}> {
    if (isSqliteDatabase() || !isValidDimensions(dimensions)) {
        return { created: [], indexed: false }
    }
    if (dimensions > MAX_INDEXABLE_DIMENSIONS) {
        // 超过 2000 维 pgvector 建不了 HNSW，只能顺扫。不报错，避免堵住写入。
        return { created: [], indexed: false }
    }

    const created: string[] = []
    for (const { table, column } of VECTOR_TABLES) {
        const name = indexNameFor(table, dimensions)
        // 索引名是我们自己按白名单表名拼的，不含用户输入；维度已过整数校验
        await getDb().execute(sql.raw(
            `create index if not exists ${name} on ${table} `
            + `using hnsw ((${column}::vector(${dimensions})) vector_cosine_ops) `
            + `where vector_dims(${column}) = ${dimensions}`,
        ))
        created.push(name)
    }
    return { created, indexed: true }
}

/**
 * where 片段：只保留当前维度的行。
 * 跨维度做 `<=>` pgvector 会抛 "different vector dimensions"，所以这个过滤是硬性要求。
 */
export function whereSameDimension(column: string, dimensions: number): SQL {
    return sql.raw(`vector_dims(${column}) = ${Number(dimensions)}`)
}

/**
 * 距离表达式：`column::vector(N) <=> $query::vector(N)`。
 * 两侧都转型才能命中部分表达式索引。
 */
export function cosineDistance(column: string, literal: string, dimensions: number): SQL {
    const dims = Number(dimensions)
    return sql`${sql.raw(`${column}::vector(${dims})`)} <=> ${literal}::vector(${sql.raw(String(dims))})`
}

/** 相似度 = 1 - 余弦距离 */
export function cosineSimilarity(column: string, literal: string, dimensions: number): SQL {
    return sql`1 - (${cosineDistance(column, literal, dimensions)})`
}

/** 当前库里已经建好索引的维度，用于诊断与状态展示 */
export async function listIndexedDimensions(): Promise<number[]> {
    if (isSqliteDatabase()) return []
    const rows = await getDb().execute(sql`
        select indexname from pg_indexes
        where schemaname = 'public' and indexname like '%_embedding_d%'
    `)
    const dims = new Set<number>()
    for (const row of rows as Iterable<Record<string, unknown>>) {
        const match = String(row.indexname ?? "").match(/_embedding_d(\d+)$/)
        if (match) dims.add(Number(match[1]))
    }
    return [...dims].sort((a, b) => a - b)
}
