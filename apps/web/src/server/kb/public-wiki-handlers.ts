import type { NextRequest } from "next/server"
import { z } from "zod"
import { ok, toErrorResponse } from "@/server/http/response"
import { loadPublicArticleScope } from "@/server/kb/public-qa-logic"
import { readPublicWikiPageDetail } from "@/server/kb/public-wiki-qa"

const pageKeySchema = z.string().trim().min(1).max(200)

/**
 * 公开 Wiki 页面详情（前台问答弹窗用）。
 * 仅返回 sourceRefs 关联到公开文章的页面；index 页在其知识库有公开文章时放行。
 */
export async function publicWikiPageDetail(request: NextRequest) {
    try {
        const pageKey = pageKeySchema.parse(request.nextUrl.searchParams.get("pageKey") ?? "")
        const scope = await loadPublicArticleScope()
        const detail = await readPublicWikiPageDetail(scope, pageKey)
        return ok(detail)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
