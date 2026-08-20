/**
 * 📊 数据库查询性能监控工具
 * 用于分析和优化数据库查询性能
 */

import { sql, type SQLWrapper } from "drizzle-orm"
import { createLogger } from "@/lib/logger"

const logger = createLogger("db-performance")

type ExecutableDatabase = {
    execute: (query: SQLWrapper) => Promise<unknown>
}

/**
 * 执行 EXPLAIN ANALYZE 并记录查询计划
 */
export async function explainQuery(db: ExecutableDatabase, query: SQLWrapper) {
    if (process.env.NODE_ENV !== "development") {
        return // 仅在开发环境启用
    }

    try {
        const explanation = await db.execute(sql`EXPLAIN ANALYZE ${query}`)
        logger.debug({
            queryPlan: explanation,
            message: "Query execution plan",
        })
        return explanation
    } catch (error) {
        logger.error({
            error: error instanceof Error ? error.message : String(error),
            message: "Failed to explain query",
        })
    }
}

/**
 * 包装查询函数，自动记录执行时间
 */
export function withQueryTiming<T>(
    name: string,
    queryFn: () => Promise<T>
): Promise<T> {
    const start = performance.now()

    return queryFn()
        .then((result) => {
            const duration = performance.now() - start
            if (duration > 100) {
                // 查询超过 100ms 记录警告
                logger.warn({
                    query: name,
                    duration: `${duration.toFixed(2)}ms`,
                    message: "Slow query detected",
                })
            } else {
                logger.debug({
                    query: name,
                    duration: `${duration.toFixed(2)}ms`,
                })
            }
            return result
        })
        .catch((error) => {
            const duration = performance.now() - start
            logger.error({
                query: name,
                duration: `${duration.toFixed(2)}ms`,
                error: error instanceof Error ? error.message : String(error),
                message: "Query failed",
            })
            throw error
        })
}

/**
 * 检查索引使用情况
 */
export async function checkIndexUsage(db: ExecutableDatabase, tableName: string) {
    if (process.env.NODE_ENV !== "development") {
        return
    }

    try {
        const result = await db.execute(sql`
            SELECT
                schemaname,
                tablename,
                indexname,
                idx_scan,
                idx_tup_read,
                idx_tup_fetch
            FROM pg_stat_user_indexes
            WHERE tablename = ${tableName}
            ORDER BY idx_scan ASC
        `)

        logger.info({
            table: tableName,
            indexes: result,
            message: "Index usage statistics",
        })

        return result
    } catch (error) {
        logger.error({
            error: error instanceof Error ? error.message : String(error),
            message: "Failed to check index usage",
        })
    }
}
