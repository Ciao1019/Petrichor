import type { PublicArticleListItem } from "@/lib/api"

type GoPublicArticleRow = {
    articleId?: string
    shareCode?: string
    title?: string
    snippet?: string
    excerpt?: string
    updatedAt?: string
    href?: string
    pinOrder?: number | null
}

export async function fetchPublicArticlesFromGo(): Promise<PublicArticleListItem[]> {
    const base = process.env.PETRICHOR_GO_API_URL?.trim().replace(/\/$/, "")
    if (!base) {
        return []
    }
    try {
        const res = await fetch(`${base}/api/public/article/list`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            next: { revalidate: 60 },
        })
        if (!res.ok) {
            return []
        }
        const data = await res.json() as { rows?: GoPublicArticleRow[]; items?: GoPublicArticleRow[] }
        const rows = data.rows ?? data.items ?? []
        return rows.map((row) => ({
            articleId: String(row.articleId ?? ""),
            shareCode: String(row.shareCode ?? ""),
            title: String(row.title ?? ""),
            excerpt: String(row.excerpt ?? row.snippet ?? ""),
            updatedAt: String(row.updatedAt ?? new Date().toISOString()),
            readingMinutes: 1,
            tags: [],
            href: String(row.href ?? (row.shareCode ? `/p/${row.shareCode}` : "/")),
            expired: false,
            hasPassword: false,
            isRepost: false,
            pinOrder: row.pinOrder ?? null,
        }))
    } catch {
        return []
    }
}
