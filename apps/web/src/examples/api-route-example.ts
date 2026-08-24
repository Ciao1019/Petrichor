/**
 * 🎯 API Route 示例：使用速率限制和输入验证
 */

import type { AppRequest } from "@/server/http/request"
import { withRateLimit, rateLimitPresets } from "@/lib/with-rate-limit"
import { createArticleSchema } from "@/lib/validation"
import { createLogger } from "@/lib/logger"

const logger = createLogger("api-article")

async function handler(req: AppRequest) {
    try {
        // 1. 解析请求体
        const body = await req.json()

        // 2. 输入验证
        const validationResult = createArticleSchema.safeParse(body)

        if (!validationResult.success) {
            logger.warn({
                errors: validationResult.error.issues,
                message: "Validation failed",
            })

            return Response.json(
                {
                    error: "Validation Error",
                    details: validationResult.error.issues,
                },
                { status: 400 }
            )
        }

        // 3. 业务逻辑
        const data = validationResult.data
        logger.info({ title: data.title, message: "Creating article" })

        // 这里添加实际的数据库操作
        // const article = await createArticle(data)

        // 4. 返回成功响应
        return Response.json(
            {
                success: true,
                message: "文章创建成功",
                // data: article
            },
            { status: 201 }
        )
    } catch (error) {
        logger.error({
            error: error instanceof Error ? error.message : String(error),
            message: "Failed to create article",
        })

        return Response.json(
            {
                error: "Internal Server Error",
                message: "创建文章失败，请稍后重试",
            },
            { status: 500 }
        )
    }
}

// 导出带有速率限制的 handler
export const POST = withRateLimit(handler, rateLimitPresets.moderate)
