import type { NextRequest } from "next/server"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, toErrorResponse } from "@/server/http/response"
import { readUserWikiPageDetail } from "@/server/kb/wiki-qa-user"

const pageKeySchema = z.string().trim().min(1).max(200)

/**
 * 后台助手的 Wiki 页面详情（回答里的 [[..]] 引用点击弹窗用）。
 * 作用域 = 当前登录用户自己的知识库页面；focus 指定知识库时用于消除同名 pageKey 歧义。
 */
export async function assistantWikiPageDetail(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const pageKey = pageKeySchema.parse(request.nextUrl.searchParams.get("pageKey") ?? "")
        const rawKbId = request.nextUrl.searchParams.get("knowledgeBaseId")
        const knowledgeBaseId = rawKbId && /^\d+$/.test(rawKbId.trim()) ? Number(rawKbId.trim()) : null
        const detail = await readUserWikiPageDetail({
            userId: user.id,
            pageKey,
            ...(knowledgeBaseId != null ? { knowledgeBaseId } : {}),
        })
        return ok(detail)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
