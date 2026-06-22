/**
 * 🔒 输入验证 Schema 集合
 * 使用 Zod 进行严格的类型和运行时验证
 */

import { z } from "zod"

/**
 * 通用分页 Schema
 */
export const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

/**
 * 文章相关 Schema
 */
export const createArticleSchema = z.object({
    title: z.string().min(1, "标题不能为空").max(200, "标题最长 200 字符"),
    content: z.string().max(1000000, "内容最长 100 万字符"),
    folderId: z.string().uuid().optional(),
    tags: z.array(z.string().max(50)).max(20, "最多 20 个标签").optional(),
    coverImage: z.string().url().optional(),
    isPublic: z.boolean().default(false),
    excerpt: z.string().max(500).optional(),
})

export const updateArticleSchema = createArticleSchema.partial().extend({
    id: z.string().uuid(),
})

export const deleteArticleSchema = z.object({
    id: z.string().uuid(),
})

/**
 * 文件夹相关 Schema
 */
export const createFolderSchema = z.object({
    name: z.string().min(1, "文件夹名称不能为空").max(100, "名称最长 100 字符"),
    parentId: z.string().uuid().nullable().optional(),
    description: z.string().max(500).optional(),
})

export const updateFolderSchema = createFolderSchema.partial().extend({
    id: z.string().uuid(),
})

/**
 * 用户认证相关 Schema
 */
export const loginSchema = z.object({
    email: z.string().email("请输入有效的邮箱地址"),
    password: z.string().min(8, "密码至少 8 位").max(100),
})

export const registerSchema = loginSchema.extend({
    nickname: z.string().min(1, "昵称不能为空").max(50, "昵称最长 50 字符"),
    confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "两次密码输入不一致",
    path: ["confirmPassword"],
})

export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, "请输入当前密码"),
    newPassword: z.string().min(8, "新密码至少 8 位").max(100),
    confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
    message: "两次密码输入不一致",
    path: ["confirmPassword"],
})

/**
 * AI 配置相关 Schema
 */
export const aiProviderSchema = z.object({
    provider: z.enum(["openai", "gemini", "deepseek", "anthropic"]),
    apiKey: z.string().min(1, "API Key 不能为空"),
    model: z.string().min(1, "模型名称不能为空"),
    baseUrl: z.string().url().optional(),
})

/**
 * 文件上传相关 Schema
 */
export const uploadSchema = z.object({
    filename: z.string().min(1, "文件名不能为空").max(255),
    contentType: z.string().min(1, "文件类型不能为空"),
    size: z.number().int().min(1).max(50 * 1024 * 1024, "文件大小不能超过 50MB"),
})

/**
 * 分享链接相关 Schema
 */
export const createShareLinkSchema = z.object({
    articleId: z.string().uuid(),
    password: z.string().min(4).max(20).optional(),
    expiresAt: z.coerce.date().optional(),
})

/**
 * 搜索相关 Schema
 */
export const searchSchema = z.object({
    query: z.string().min(1, "搜索关键词不能为空").max(100),
    type: z.enum(["article", "folder", "tag", "all"]).default("all"),
    ...paginationSchema.shape,
})

/**
 * API Key 管理 Schema
 */
export const createApiKeySchema = z.object({
    name: z.string().min(1, "名称不能为空").max(100),
    permissions: z.array(z.enum(["article:read", "article:write", "article:delete", "doc:read", "qa:read"])),
    expiresAt: z.coerce.date().optional(),
})

/**
 * 通用 ID 验证
 */
export const uuidSchema = z.string().uuid("无效的 ID 格式")

/**
 * 日期范围验证
 */
export const dateRangeSchema = z.object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
}).refine((data) => data.endDate > data.startDate, {
    message: "结束日期必须晚于开始日期",
    path: ["endDate"],
})

/**
 * 导出所有 Schema 类型
 */
export type PaginationInput = z.infer<typeof paginationSchema>
export type CreateArticleInput = z.infer<typeof createArticleSchema>
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>
export type DeleteArticleInput = z.infer<typeof deleteArticleSchema>
export type CreateFolderInput = z.infer<typeof createFolderSchema>
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type AiProviderInput = z.infer<typeof aiProviderSchema>
export type UploadInput = z.infer<typeof uploadSchema>
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>
export type SearchInput = z.infer<typeof searchSchema>
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>
export type DateRangeInput = z.infer<typeof dateRangeSchema>
