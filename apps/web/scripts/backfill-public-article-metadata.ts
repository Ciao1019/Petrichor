import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { knowledgeBaseArticles } from "../src/server/db/schema"
import { buildPublicArticleMetadata, parsePublicArticleTocJson } from "../src/server/kb/share-logic"

const databaseUrl = process.env.DATABASE_URL?.trim()

if (!databaseUrl) {
    throw new Error("DATABASE_URL 不能为空")
}

const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
})
const db = drizzle(sql)

try {
    const rows = await db
        .select({
            id: knowledgeBaseArticles.id,
            contentMd: knowledgeBaseArticles.contentMd,
            publicExcerpt: knowledgeBaseArticles.publicExcerpt,
            readingMinutes: knowledgeBaseArticles.readingMinutes,
            tocJson: knowledgeBaseArticles.tocJson,
            publicContentHash: knowledgeBaseArticles.publicContentHash,
        })
        .from(knowledgeBaseArticles)

    let updated = 0
    for (const row of rows) {
        const metadata = buildPublicArticleMetadata(row.contentMd)
        const hasCurrentMetadata =
            row.publicContentHash === metadata.publicContentHash &&
            Boolean(row.publicExcerpt?.trim()) &&
            typeof row.readingMinutes === "number" &&
            row.readingMinutes > 0 &&
            Boolean(parsePublicArticleTocJson(row.tocJson))

        if (hasCurrentMetadata) {
            continue
        }

        await db
            .update(knowledgeBaseArticles)
            .set(metadata)
            .where(eq(knowledgeBaseArticles.id, row.id))
        updated += 1
    }

    console.log(`公开文章元数据回填完成：扫描 ${rows.length} 篇，更新 ${updated} 篇`)
} finally {
    await sql.end({ timeout: 5 })
}
