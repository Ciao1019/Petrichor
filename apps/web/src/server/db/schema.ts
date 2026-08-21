import { sql } from "drizzle-orm"
import {
    bigint as pgBigint,
    boolean as pgBoolean,
    index as pgIndex,
    integer as pgInteger,
    pgTable as pgPgTable,
    text as pgText,
    timestamp as pgTimestamp,
    uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core"
import {
    index as sqliteIndex,
    integer as sqliteInteger,
    sqliteTable,
    text as sqliteText,
    uniqueIndex as sqliteUniqueIndex,
} from "drizzle-orm/sqlite-core"

const useSqliteSchema =
    process.env.PETRICHOR_DB_DIALECT === "sqlite" ||
    process.env.DATABASE_URL?.startsWith("file:")

const pgTable = (useSqliteSchema ? sqliteTable : pgPgTable) as typeof pgPgTable
const index = (useSqliteSchema ? sqliteIndex : pgIndex) as typeof pgIndex
const uniqueIndex = (useSqliteSchema ? sqliteUniqueIndex : pgUniqueIndex) as typeof pgUniqueIndex

type SqliteIdentityBuilder = {
    generatedAlwaysAsIdentity: () => SqliteIdentityBuilder
}

type SqliteBigintBuilder = {
    primaryKey: (config?: unknown) => SqliteIdentityBuilder
}

type SqliteTimestampBuilder = {
    default: (value: ReturnType<typeof sql>) => unknown
    defaultNow: () => unknown
}

const bigint = ((name: string, config?: unknown) => {
    if (!useSqliteSchema) {
        return pgBigint(name, config as Parameters<typeof pgBigint>[1])
    }

    const builder = sqliteInteger(name) as unknown as SqliteBigintBuilder
    const originalPrimaryKey = builder.primaryKey.bind(builder)
    builder.primaryKey = (primaryKeyConfig?: unknown) => {
        const primaryKeyBuilder = originalPrimaryKey(
            primaryKeyConfig ?? { autoIncrement: true },
        )
        primaryKeyBuilder.generatedAlwaysAsIdentity = () => primaryKeyBuilder
        return primaryKeyBuilder
    }
    return builder as unknown as ReturnType<typeof pgBigint>
}) as typeof pgBigint

const boolean = ((name: string) => {
    return (useSqliteSchema
        ? sqliteInteger(name, { mode: "boolean" })
        : pgBoolean(name)) as ReturnType<typeof pgBoolean>
}) as typeof pgBoolean

const integer = ((name: string) => {
    return (useSqliteSchema ? sqliteInteger(name) : pgInteger(name)) as ReturnType<typeof pgInteger>
}) as typeof pgInteger

const text = ((name: string) => {
    return (useSqliteSchema ? sqliteText(name) : pgText(name)) as ReturnType<typeof pgText>
}) as typeof pgText

const timestamp = ((name: string, config?: unknown) => {
    if (!useSqliteSchema) {
        return pgTimestamp(name, config as Parameters<typeof pgTimestamp>[1])
    }

    const builder = sqliteInteger(name, { mode: "timestamp_ms" }) as unknown as SqliteTimestampBuilder
    builder.defaultNow = () => builder.default(sql`(unixepoch() * 1000)`)
    return builder as unknown as ReturnType<typeof pgTimestamp>
}) as typeof pgTimestamp

const timestamps = {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}

export const users = pgTable("petrichor_user", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    authUserId: text("auth_user_id"),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    systemRole: text("system_role").notNull().default("USER"),
    userType: text("user_type").notNull().default("LOCAL"),
    linuxDoAccountId: text("linuxdo_account_id"),
    linuxDoUsername: text("linuxdo_username"),
    linuxDoEmail: text("linuxdo_email"),
    username: text("username"),
    nickname: text("nickname"),
    avatar: text("avatar"),
    signature: text("signature"),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_user_email").on(table.email),
    uniqueIndex("ux_petrichor_user_auth_user_id").on(table.authUserId),
    uniqueIndex("ux_petrichor_user_linuxdo_account_id").on(table.linuxDoAccountId),
])

export const betterAuthUsers = pgTable("better_auth_user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("ux_better_auth_user_email").on(table.email),
])

export const betterAuthTwoFactors = pgTable("better_auth_two_factor", {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    userId: text("user_id").notNull().references(() => betterAuthUsers.id, { onDelete: "cascade" }),
}, (table) => [
    index("idx_better_auth_two_factor_user_id").on(table.userId),
    index("idx_better_auth_two_factor_secret").on(table.secret),
])

export const betterAuthSessions = pgTable("better_auth_session", {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => betterAuthUsers.id, { onDelete: "cascade" }),
}, (table) => [
    uniqueIndex("ux_better_auth_session_token").on(table.token),
    index("idx_better_auth_session_user_id").on(table.userId),
    index("idx_better_auth_session_expires_at").on(table.expiresAt),
])

export const betterAuthAccounts = pgTable("better_auth_account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => betterAuthUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("ux_better_auth_account_provider_account").on(table.providerId, table.accountId),
    index("idx_better_auth_account_user_id").on(table.userId),
])

export const betterAuthVerifications = pgTable("better_auth_verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_better_auth_verification_identifier").on(table.identifier),
])

export const authSessions = pgTable("petrichor_auth_session", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    tokenHash: text("token_hash").notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    deviceInfo: text("device_info"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_auth_session_token_hash").on(table.tokenHash),
    index("ix_petrichor_auth_session_user_revoked").on(table.userId, table.revokedAt),
    index("ix_petrichor_auth_session_expires_at").on(table.expiresAt),
])

export const notifications = pgTable("petrichor_notification", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    category: text("category").notNull(),
    bizType: text("biz_type").notNull(),
    bizId: bigint("biz_id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    payloadJson: text("payload_json"),
    readAt: timestamp("read_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_notification_user_read").on(table.userId, table.readAt),
    index("idx_petrichor_notification_user_created").on(table.userId, table.createdAt),
    index("idx_petrichor_notification_user_category").on(table.userId, table.category),
    index("idx_petrichor_notification_biz").on(table.userId, table.bizType, table.bizId),
])

export const knowledgeBases = pgTable("petrichor_kb_knowledge_base", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_kb_user_id").on(table.userId),
    // 知识库列表：user_id 过滤 + updated_at 排序
    index("petrichor_kb_knowledge_base_user_updated_idx").on(table.userId, table.updatedAt),
])

export const knowledgeBaseNodes = pgTable("petrichor_kb_node", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    parentId: bigint("parent_id", { mode: "number" }),
    type: text("type").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_kb_node_user_kb").on(table.userId, table.knowledgeBaseId),
    index("idx_petrichor_kb_node_parent").on(table.knowledgeBaseId, table.parentId, table.sortOrder),
    // 知识库树加载：user_id + knowledge_base_id 过滤 + sort_order/id 排序
    index("petrichor_kb_node_user_kb_order_idx").on(table.userId, table.knowledgeBaseId, table.sortOrder, table.id),
])

export const knowledgeBaseArticles = pgTable("petrichor_kb_article", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    nodeId: bigint("node_id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    contentMd: text("content_md").notNull(),
    contentJson: text("content_json"),
    contentMetaJson: text("content_meta_json"),
    publicExcerpt: text("public_excerpt"),
    readingMinutes: integer("reading_minutes"),
    tocJson: text("toc_json"),
    publicContentHash: text("public_content_hash"),
    aiSummary: text("ai_summary"),
    aiSummaryContentHash: text("ai_summary_content_hash"),
    aiSummaryGeneratedAt: timestamp("ai_summary_generated_at", { withTimezone: true }),
    mindmapJson: text("mindmap_json"),
    mindmapContentHash: text("mindmap_content_hash"),
    mindmapGeneratedAt: timestamp("mindmap_generated_at", { withTimezone: true }),
    mindmapKgJson: text("mindmap_kg_json"),
    mindmapKgContentHash: text("mindmap_kg_content_hash"),
    mindmapKgGeneratedAt: timestamp("mindmap_kg_generated_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_kb_article_user_kb").on(table.userId, table.knowledgeBaseId),
    index("idx_petrichor_kb_article_public_updated").on(table.updatedAt, table.id),
    // 首页文章热力图/趋势：user_id 过滤 + created_at 时间范围聚合
    index("petrichor_kb_article_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("ux_petrichor_kb_article_node_id").on(table.nodeId),
])

// “构建知识”产生的平铺 Markdown 切片。它与旧的 Wiki PageIndex 目录树解耦：
// 每个切片独立保存 3 个推荐问题，后续问答链路迁移时可直接消费。
export const knowledgeBaseArticleChunks = pgTable("petrichor_kb_article_chunk", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    articleId: bigint("article_id", { mode: "number" }).notNull(),
    chunkKey: text("chunk_key").notNull(),
    position: integer("position").notNull().default(0),
    heading: text("heading").notNull(),
    contentMd: text("content_md").notNull(),
    contentHash: text("content_hash").notNull(),
    /** 完整标题路径 JSON 数组，如 ["架构","存储"]；存量数据为 [] */
    headingPathJson: text("heading_path_json").notNull().default("[]"),
    recommendedQuestionsJson: text("recommended_questions_json").notNull().default("[]"),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_kb_article_chunk_key").on(table.userId, table.articleId, table.chunkKey),
    index("idx_petrichor_kb_article_chunk_article").on(table.userId, table.knowledgeBaseId, table.articleId, table.position),
])

export const knowledgeBaseArticleTags = pgTable("petrichor_kb_article_tag", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    articleId: bigint("article_id", { mode: "number" }).notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("ux_petrichor_kb_article_tag_article_tag").on(table.articleId, table.tag),
    index("idx_petrichor_kb_article_tag_article").on(table.articleId),
])

export const knowledgeBaseArticleShares = pgTable("petrichor_kb_article_share", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    articleId: bigint("article_id", { mode: "number" }).notNull(),
    shareCode: text("share_code").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    passwordHash: text("password_hash"),
    isRepost: boolean("is_repost").notNull().default(false),
    originalUrl: text("original_url"),
    originalAuthorName: text("original_author_name"),
    /** 内部链接：非空时列表点击直跳该站内路径；与转载互斥 */
    internalUrl: text("internal_url"),
    pinOrder: integer("pin_order"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_kb_article_share_article").on(table.articleId),
    uniqueIndex("ux_petrichor_kb_article_share_code").on(table.shareCode),
    index("idx_petrichor_kb_article_share_public").on(table.enabled, table.revokedAt, table.articleId),
    index("idx_petrichor_kb_article_share_user").on(table.userId),
    index("idx_petrichor_kb_article_share_pin").on(table.pinOrder),
])

// 阅后即焚链接：与永久分享（petrichor_kb_article_share）完全独立的一次性 / N 次访问通道。
// 不进公开首页/搜索/RSS，也不会被公开问答索引（问答只扫永久分享表）。
export const knowledgeBaseArticleBurnLinks = pgTable("petrichor_kb_article_burn_link", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    articleId: bigint("article_id", { mode: "number" }).notNull(),
    linkCode: text("link_code").notNull(),
    maxViews: integer("max_views").notNull().default(1),
    viewCount: integer("view_count").notNull().default(0),
    passwordHash: text("password_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // ACTIVE（可访问） | BURNED（达上限自动焚毁） | REVOKED（站长手动撤销）
    status: text("status").notNull().default("ACTIVE"),
    burnedAt: timestamp("burned_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_kb_burn_link_code").on(table.linkCode),
    index("idx_petrichor_kb_burn_link_article").on(table.userId, table.articleId, table.createdAt),
])

export const knowledgeBaseWikiPages = pgTable("petrichor_kb_wiki_page", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    pageKey: text("page_key").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    contentMd: text("content_md").notNull(),
    frontmatterJson: text("frontmatter_json"),
    summary: text("summary"),
    contentHash: text("content_hash").notNull(),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_kb_wiki_page_key").on(table.userId, table.knowledgeBaseId, table.pageKey),
    index("idx_petrichor_kb_wiki_page_kb_kind").on(table.userId, table.knowledgeBaseId, table.kind),
    index("idx_petrichor_kb_wiki_page_updated").on(table.userId, table.knowledgeBaseId, table.updatedAt),
])

export const knowledgeBaseWikiLinks = pgTable("petrichor_kb_wiki_link", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    fromPageId: bigint("from_page_id", { mode: "number" }).notNull(),
    toPageKey: text("to_page_key").notNull(),
    linkType: text("link_type").notNull().default("related"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_kb_wiki_link_from").on(table.fromPageId),
    index("idx_petrichor_kb_wiki_link_to").on(table.userId, table.knowledgeBaseId, table.toPageKey),
])

export const knowledgeBaseWikiSourceRefs = pgTable("petrichor_kb_wiki_source_ref", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    pageId: bigint("page_id", { mode: "number" }).notNull(),
    articleId: bigint("article_id", { mode: "number" }).notNull(),
    anchor: text("anchor"),
    quoteHash: text("quote_hash"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_kb_wiki_source_page").on(table.pageId),
    index("idx_petrichor_kb_wiki_source_article").on(table.articleId),
])

// PageIndex 式的文档层级树：每篇源文档按 Markdown 标题拆成 TOC 节点，
// 节点带 LLM 摘要 + 原文片段 + 锚点，供推理式检索（LLM 在目录上导航选节点）。
export const knowledgeBaseWikiTreeNodes = pgTable("petrichor_kb_wiki_tree_node", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    pageId: bigint("page_id", { mode: "number" }).notNull(),
    articleId: bigint("article_id", { mode: "number" }).notNull(),
    nodeKey: text("node_key").notNull(),
    parentKey: text("parent_key"),
    depth: integer("depth").notNull().default(0),
    position: integer("position").notNull().default(0),
    title: text("title").notNull(),
    summary: text("summary"),
    contentMd: text("content_md").notNull().default(""),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    contentHash: text("content_hash").notNull(),
    // 向量生命周期元数据。维度相同不代表向量空间相同，所以换模型的判定要靠
    // model + dimensions + version 三者，而不是只看 vector_dims。
    embeddingStatus: text("embedding_status").notNull().default("pending"),
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    embeddingVersion: integer("embedding_version").notNull().default(1),
    embeddingError: text("embedding_error"),
    embeddingUpdatedAt: timestamp("embedding_updated_at", { withTimezone: true }),
    // BM25 词法召回索引列（需求 §27/§91）。中文按 2 字 n-gram 展开后存词元串，
    // Postgres 侧再由 search_vector 生成列（setweight A/B/C）+ GIN 索引承接查询。
    searchTitleTokens: text("search_title_tokens"),
    searchSummaryTokens: text("search_summary_tokens"),
    searchContentTokens: text("search_content_tokens"),
    // 注意：embedding 列（无约束 vector）仅存在于 Postgres（见 full-migration / 迁移 SQL），
    // 且只通过原生 SQL 读写。故意不在 Drizzle schema 声明，避免 loadTreeNodes 等 select() 全列查询在 SQLite（无该列）报错。
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_kb_wiki_tree_node_key").on(table.userId, table.knowledgeBaseId, table.nodeKey),
    index("idx_petrichor_kb_wiki_tree_node_page").on(table.pageId),
    index("idx_petrichor_kb_wiki_tree_node_article").on(table.articleId),
    index("idx_petrichor_kb_wiki_tree_node_kb").on(table.userId, table.knowledgeBaseId, table.position),
])

export const knowledgeBaseWikiPatches = pgTable("petrichor_kb_wiki_patch", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    threadId: bigint("thread_id", { mode: "number" }),
    runId: bigint("run_id", { mode: "number" }),
    pageKey: text("page_key").notNull(),
    title: text("title").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("PENDING"),
    beforeContentMd: text("before_content_md"),
    proposedContentMd: text("proposed_content_md").notNull(),
    diffText: text("diff_text").notNull(),
    reason: text("reason"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_kb_wiki_patch_status").on(table.userId, table.knowledgeBaseId, table.status),
    index("idx_petrichor_kb_wiki_patch_thread").on(table.threadId),
])

export const knowledgeBaseAgentThreads = pgTable("petrichor_kb_agent_thread", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    metadataJson: text("metadata_json"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_kb_agent_thread_kb").on(table.userId, table.knowledgeBaseId, table.updatedAt),
    index("idx_petrichor_kb_agent_thread_user").on(table.userId, table.updatedAt),
    // 历史对话列表：user_id/scope 过滤 + updated_at/id 稳定倒序分页
    index("petrichor_kb_agent_thread_user_history_idx").on(table.userId, table.updatedAt, table.id),
    index("petrichor_kb_agent_thread_scope_history_idx").on(table.userId, table.knowledgeBaseId, table.updatedAt, table.id),
    // 首页问答趋势：user_id 过滤 + created_at 时间范围聚合
    index("petrichor_kb_agent_thread_user_created_idx").on(table.userId, table.createdAt),
])

export const knowledgeBaseAgentMessages = pgTable("petrichor_kb_agent_message", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }),
    role: text("role").notNull(),
    contentText: text("content_text").notNull().default(""),
    contentJson: text("content_json"),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_kb_agent_message_thread").on(table.threadId, table.createdAt),
    // 历史对话详情：按 thread_id 拉取消息，并用 id 稳定同时间戳下的顺序
    index("petrichor_kb_agent_message_thread_order_idx").on(table.threadId, table.createdAt, table.id),
])

export const knowledgeBaseAgentRuns = pgTable("petrichor_kb_agent_run", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }),
    status: text("status").notNull().default("RUNNING"),
    modelName: text("model_name"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_kb_agent_run_thread").on(table.threadId, table.createdAt),
])

export const knowledgeBaseAgentSteps = pgTable("petrichor_kb_agent_step", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }),
    stepType: text("step_type").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    payloadJson: text("payload_json"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_kb_agent_step_run").on(table.runId, table.createdAt),
])

export const knowledgeBaseAgentArtifacts = pgTable("petrichor_kb_agent_artifact", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    runId: bigint("run_id", { mode: "number" }),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }),
    artifactType: text("artifact_type").notNull(),
    title: text("title").notNull(),
    payloadJson: text("payload_json"),
    contentMd: text("content_md"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_kb_agent_artifact_thread").on(table.threadId, table.updatedAt),
    index("idx_petrichor_kb_agent_artifact_kb").on(table.userId, table.knowledgeBaseId, table.artifactType),
])

export const knowledgeBaseWikiEventLogs = pgTable("petrichor_kb_wiki_event_log", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    pageId: bigint("page_id", { mode: "number" }),
    threadId: bigint("thread_id", { mode: "number" }),
    payloadJson: text("payload_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_kb_wiki_event_kb").on(table.userId, table.knowledgeBaseId, table.createdAt),
])

export const agentApiKeys = pgTable("petrichor_agent_api_key", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    scopesJson: text("scopes_json").notNull().default("[]"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_agent_api_key_hash").on(table.keyHash),
    index("idx_petrichor_agent_api_key_user").on(table.userId, table.revokedAt, table.createdAt),
])

export const agentCallLogs = pgTable("petrichor_agent_call_log", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    apiKeyId: bigint("api_key_id", { mode: "number" }).notNull(),
    apiKeyPrefix: text("api_key_prefix").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestJson: text("request_json"),
    responseJson: text("response_json"),
    statusCode: integer("status_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_agent_call_log_user_created").on(table.userId, table.createdAt),
    index("idx_petrichor_agent_call_log_key_created").on(table.apiKeyId, table.createdAt),
])

export const siteAboutProfiles = pgTable("petrichor_site_about_profile", {
    id: integer("id").primaryKey(),
    displayName: text("display_name").notNull().default("CiZai"),
    roleTitle: text("role_title").notNull().default("Creative Dev & Visual Artist"),
    intro: text("intro").notNull().default("我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。"),
    expertiseJson: text("expertise_json").notNull().default("[\"Frontend Architecture\",\"AI 应用开发\",\"Knowledge Systems\",\"Creative Coding\"]"),
    toolkitJson: text("toolkit_json").notNull().default("[\"TypeScript\",\"React\",\"Next.js\",\"AI\",\"PostgreSQL\",\"Minecraft\"]"),
    quote: text("quote").notNull().default("Code is just another medium for painting dreams."),
    // 正文逐句注记（下划线/高亮 + 悬停气泡）：JSON 数组 [{phrase,style,note?}]，style ∈ red|green|blue|yellow
    accentsJson: text("accents_json").notNull().default('[{"phrase":"CiZai","style":"red","note":"yep, that\'s me"},{"phrase":"程序员","style":"green","note":"just a dev"},{"phrase":"金山办公","style":"blue","note":"where I work"},{"phrase":"Coding / AI","style":"green","note":"my playground"},{"phrase":"Minecraft","style":"blue","note":"★ my comfort game"}]'),
    // 蓝色便签里的联系方式：引导语 + 链接文字 + 链接地址（三者均可留空以隐藏）
    contactText: text("contact_text").notNull().default("想聊点什么？随时"),
    contactLabel: text("contact_label").notNull().default("message me"),
    contactHref: text("contact_href").notNull().default("mailto:zang@linux.do"),
    ...timestamps,
})

export const siteAppearance = pgTable("petrichor_site_appearance", {
    id: integer("id").primaryKey(),
    publicQaEnabled: boolean("public_qa_enabled").notNull().default(true),
    ...timestamps,
})

// 开源项目展示页（单例）：手写桌面风的项目清单，移植自 Sn0w 首页 projects 区。
// itemsJson 为 JSON 数组 [{name,year,stack[],stamp?,stampColor?,blurb?,repoUrl?,siteUrl?}]。
export const siteProjectShowcase = pgTable("petrichor_site_project_showcase", {
    id: integer("id").primaryKey(),
    heading: text("heading").notNull().default("开源项目"),
    intro: text("intro").notNull().default(""),
    itemsJson: text("items_json").notNull().default('[{"name":"Ech0 — self-hosted microblog","year":"2025","stack":["Go","Vue"],"stamp":"popular","stampColor":"red","blurb":"An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.","repoUrl":"https://github.com/lin-snow/Ech0","siteUrl":"https://ech0.app"},{"name":"Dox — todos in terminal","year":"2026","stack":["Go","TypeScript"],"stamp":"new","stampColor":"blue","blurb":"More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.","repoUrl":"https://github.com/lin-snow/dox"},{"name":"Kemate — a Vercel-like PaaS","year":"2026","stack":["Go"],"stamp":"WIP","stampColor":"green","blurb":"A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture."}]'),
    ...timestamps,
})

// ===== 全站星图（Site Graph）=====
// 不引入图数据库：树形骨架用「邻接表」（parent_id 自引用），跨树关系单独放 petrichor_site_graph_edge，
// 子树 / N 跳邻域查询统一用 PostgreSQL 递归 CTE（见 src/server/site-graph/graph-query.ts）。

// 图谱节点：root / section（分类）/ article（公开文章）/ concept（概念）/ entity（实体）/ tag（标签）
export const siteGraphNodes = pgTable("petrichor_site_graph_node", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    // 稳定业务键：同一站点内唯一，Agent 重跑靠它做 upsert 而不是重建
    nodeKey: text("node_key").notNull(),
    // 邻接表：父节点为空表示根
    parentId: bigint("parent_id", { mode: "number" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    summary: text("summary"),
    // 前台点击后跳转的站内路径，可空（概念节点通常没有独立页面）
    route: text("route"),
    articleId: bigint("article_id", { mode: "number" }),
    // 节点属性：JSON 数组 [{name,value}]，由抽取 Agent 产出、后台可改
    attributesJson: text("attributes_json"),
    // 别名：JSON 字符串数组，用于跨文章合并同一实体
    aliasesJson: text("aliases_json"),
    weight: integer("weight").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    // DRAFT（仅后台可见）/ PUBLISHED（前台可见）/ ARCHIVED
    status: text("status").notNull().default("DRAFT"),
    // AGENT / MANUAL / SYSTEM
    source: text("source").notNull().default("AGENT"),
    // 0~100，Agent 自评置信度
    confidence: integer("confidence").notNull().default(80),
    // 人工锁定：Agent 重跑时跳过，不覆盖人工维护结果
    locked: boolean("locked").notNull().default(false),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_site_graph_node_key").on(table.userId, table.nodeKey),
    index("idx_petrichor_site_graph_node_parent").on(table.userId, table.parentId, table.sortOrder),
    index("idx_petrichor_site_graph_node_status").on(table.userId, table.status, table.kind),
    index("idx_petrichor_site_graph_node_article").on(table.articleId),
])

// 图谱关系：树形父子关系不入表（走 parent_id），这里只存跨树的引用/语义关系
export const siteGraphEdges = pgTable("petrichor_site_graph_edge", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    fromNodeId: bigint("from_node_id", { mode: "number" }).notNull(),
    toNodeId: bigint("to_node_id", { mode: "number" }).notNull(),
    // 关系名称（中文短语，如「依赖」「引用」「同类」），前台悬停时展示
    relation: text("relation").notNull(),
    // 渲染分组：reference（引用）/ semantic（语义相近）/ derived（衍生）
    kind: text("kind").notNull().default("reference"),
    attributesJson: text("attributes_json"),
    weight: integer("weight").notNull().default(1),
    directed: boolean("directed").notNull().default(true),
    status: text("status").notNull().default("DRAFT"),
    source: text("source").notNull().default("AGENT"),
    confidence: integer("confidence").notNull().default(80),
    locked: boolean("locked").notNull().default(false),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_site_graph_edge_triple").on(table.userId, table.fromNodeId, table.toNodeId, table.relation),
    index("idx_petrichor_site_graph_edge_from").on(table.userId, table.fromNodeId),
    index("idx_petrichor_site_graph_edge_to").on(table.userId, table.toNodeId),
    index("idx_petrichor_site_graph_edge_status").on(table.userId, table.status),
])

// 待确认的实体合并候选：名称相近但不能确定同一实体的对子，等后台人工拍板。
// 精确命中（名称/别名规范化后一致）在抽取阶段就直接合并了，不会进这张表。
export const siteGraphMergeCandidates = pgTable("petrichor_site_graph_merge_candidate", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    /** 新抽取到的节点键 */
    sourceKey: text("source_key").notNull(),
    /** 注册表里已有的规范键 */
    targetKey: text("target_key").notNull(),
    /** name_similar / name_contains */
    reason: text("reason").notNull(),
    /** 0~100 相似度 */
    score: integer("score").notNull().default(0),
    detail: text("detail"),
    /** PENDING / MERGED / IGNORED */
    status: text("status").notNull().default("PENDING"),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_site_graph_merge_candidate_pair").on(table.userId, table.sourceKey, table.targetKey),
    index("idx_petrichor_site_graph_merge_candidate_status").on(table.userId, table.status, table.score),
])

// 抽取 Agent 的每次运行记录：写入统计 + 校验报告，后台「生成历史」读它
export const siteGraphRuns = pgTable("petrichor_site_graph_run", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    // RUNNING / COMPLETED / FAILED
    status: text("status").notNull().default("RUNNING"),
    // FULL（全量重建）/ INCREMENTAL（仅新增文章）
    mode: text("mode").notNull().default("FULL"),
    modelName: text("model_name"),
    articleCount: integer("article_count").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    // 校验报告（score / issues / 统计），结构见 site-graph/validate.ts
    validationJson: text("validation_json"),
    warningsJson: text("warnings_json"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_site_graph_run_user").on(table.userId, table.startedAt),
])

// 前台公开问答限流：固定窗口（按小时）计数桶，bucket_key 形如 visitor:<id>:<yyyyMMddHH> 或 ip:<ip>:<yyyyMMddHH>
export const publicQaRateLimits = pgTable("petrichor_public_qa_rate_limit", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    bucketKey: text("bucket_key").notNull(),
    count: integer("count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_public_qa_rate_limit_bucket").on(table.bucketKey),
])

// ===== AI 模型接入：凭证 / 供应商 / 模型 / 用途绑定 四层 =====

// 凭证库：API Key 单独管理，一条凭证可以被多个供应商实例复用，避免重复粘贴
export const aiCredentials = pgTable("petrichor_ai_credential", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    // 限定只能用于某个供应商；为空表示通用凭证（如聚合网关的 Key）
    providerKey: text("provider_key"),
    apiKeyEnc: text("api_key_enc").notNull(),
    // 供应商额外凭证字段（Bedrock AK/SK、Vertex 服务账号），整体加密后的 JSON
    extraEnc: text("extra_enc"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_ai_credential_user").on(table.userId),
    uniqueIndex("ux_petrichor_ai_credential_user_name").on(table.userId, table.name),
])

// 供应商实例：目录里的某个供应商 + 一条凭证 + 可覆盖的 BaseUrl
export const aiProviders = pgTable("petrichor_ai_provider", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    // 对应 provider-catalog 里的 key
    providerKey: text("provider_key").notNull(),
    name: text("name").notNull(),
    // 为空表示使用目录里的默认 BaseUrl
    baseUrl: text("base_url"),
    credentialId: bigint("credential_id", { mode: "number" }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // 自定义请求头，JSON 对象
    headersJson: text("headers_json"),
    // 供应商级选项（DeepSeek thinking 等），JSON 对象
    optionsJson: text("options_json"),
    // 最近一次连通性测试结果
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastCheckStatus: text("last_check_status"),
    lastCheckMessage: text("last_check_message"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_ai_provider_user").on(table.userId),
    index("idx_petrichor_ai_provider_credential").on(table.credentialId),
    uniqueIndex("ux_petrichor_ai_provider_user_name").on(table.userId, table.name),
])

// 供应商下已启用的模型：由「获取模型列表」写入，用户勾选启用
export const aiModels = pgTable("petrichor_ai_model", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    providerId: bigint("provider_id", { mode: "number" }).notNull(),
    // 调用时传给供应商的模型 id
    modelId: text("model_id").notNull(),
    displayName: text("display_name"),
    // LANGUAGE | EMBEDDING
    kind: text("kind").notNull(),
    contextWindow: integer("context_window"),
    // 向量模型的输出维度。不写死：由一次真实 embed 调用探测得到，探测前为 null
    dimensions: integer("dimensions"),
    // 能力标记数组，JSON
    capabilitiesJson: text("capabilities_json"),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_ai_model_user_kind").on(table.userId, table.kind),
    index("idx_petrichor_ai_model_provider").on(table.providerId),
    uniqueIndex("ux_petrichor_ai_model_provider_model").on(table.providerId, table.modelId),
])

// 用途绑定：每个用途（CHAT/VISION/DOC_QA/EMBEDDING）绑定一个模型，替代旧的 configType + isDefault
export const aiBindings = pgTable("petrichor_ai_binding", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    purpose: text("purpose").notNull(),
    modelRefId: bigint("model_ref_id", { mode: "number" }).notNull(),
    // 该用途的生成参数（temperature / maxTokens / thinking），JSON
    optionsJson: text("options_json"),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_ai_binding_user_purpose").on(table.userId, table.purpose),
    index("idx_petrichor_ai_binding_model").on(table.modelRefId),
])

// ===== 文档库（Document Library）：存放原始文件 + 针对文件内容的问答 =====

// 文档库（多个命名库，镜像知识库形态）
export const docLibraries = pgTable("petrichor_doc_library", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    icon: text("icon"),
    documentCount: integer("document_count").notNull().default(0),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_doc_library_user").on(table.userId),
    index("petrichor_doc_library_user_updated_idx").on(table.userId, table.updatedAt),
])

// 文件夹树（供 Finder 浏览）
export const docFolders = pgTable("petrichor_doc_folder", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    libraryId: bigint("library_id", { mode: "number" }).notNull(),
    parentId: bigint("parent_id", { mode: "number" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_doc_folder_user_lib").on(table.userId, table.libraryId),
    index("petrichor_doc_folder_parent_idx").on(table.libraryId, table.parentId, table.sortOrder),
])

// 文档（文件）：仅支持 pdf / docx / xlsx / csv
export const docDocuments = pgTable("petrichor_doc_document", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    libraryId: bigint("library_id", { mode: "number" }).notNull(),
    folderId: bigint("folder_id", { mode: "number" }),
    fileName: text("file_name").notNull(),
    title: text("title").notNull(),
    fileType: text("file_type").notNull(),
    contentType: text("content_type"),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    pageCount: integer("page_count"),
    charCount: integer("char_count"),
    status: text("status").notNull().default("pending"),
    blocksJson: text("blocks_json"),
    summary: text("summary"),
    error: text("error"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_doc_document_user_lib").on(table.userId, table.libraryId),
    index("petrichor_doc_document_folder_idx").on(table.libraryId, table.folderId),
    index("petrichor_doc_document_status_idx").on(table.userId, table.status),
])

// 文本分块：agentic 关键词检索的检索单元
export const docChunks = pgTable("petrichor_doc_chunk", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    libraryId: bigint("library_id", { mode: "number" }).notNull(),
    documentId: bigint("document_id", { mode: "number" }).notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    locator: text("locator"),
    page: integer("page"),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_doc_chunk_document").on(table.documentId, table.chunkIndex),
    index("idx_petrichor_doc_chunk_library").on(table.libraryId),
])

// 文档库问答：对话线程（libraryId 为空表示跨库）
export const docQaThreads = pgTable("petrichor_doc_qa_thread", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    libraryId: bigint("library_id", { mode: "number" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    metadataJson: text("metadata_json"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_doc_qa_thread_user").on(table.userId, table.updatedAt),
    index("petrichor_doc_qa_thread_user_history_idx").on(table.userId, table.updatedAt, table.id),
])

// 文档库问答：消息
export const docQaMessages = pgTable("petrichor_doc_qa_message", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    role: text("role").notNull(),
    contentText: text("content_text").notNull().default(""),
    contentJson: text("content_json"),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_doc_qa_message_thread").on(table.threadId, table.createdAt),
])

// 文档库问答：Agent 运行记录
export const docQaRuns = pgTable("petrichor_doc_qa_run", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    status: text("status").notNull().default("RUNNING"),
    modelName: text("model_name"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [
    index("idx_petrichor_doc_qa_run_thread").on(table.threadId, table.startedAt),
])

// 文档库问答：Agent 步骤
export const docQaSteps = pgTable("petrichor_doc_qa_step", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    stepType: text("step_type").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    payloadJson: text("payload_json"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_doc_qa_step_run").on(table.runId, table.createdAt),
])

// 文档库问答：产物
export const docQaArtifacts = pgTable("petrichor_doc_qa_artifact", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    artifactType: text("artifact_type").notNull(),
    title: text("title").notNull(),
    payloadJson: text("payload_json"),
    contentMd: text("content_md"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("idx_petrichor_doc_qa_artifact_thread").on(table.threadId, table.createdAt),
])

// AI 回顾报告：按用户 + 周期类型 + 期次唯一，按需生成并缓存
export const aiReviews = pgTable("petrichor_ai_review", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    period: text("period").notNull(),
    periodKey: text("period_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    statsJson: text("stats_json").notNull(),
    narrative: text("narrative").notNull(),
    modelConfigId: bigint("model_config_id", { mode: "number" }),
    regenerateCount: integer("regenerate_count").notNull().default(0),
    lastRegeneratedAt: timestamp("last_regenerated_at", { withTimezone: true }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_ai_review_user_period").on(table.userId, table.period, table.periodKey),
    index("idx_petrichor_ai_review_user_generated").on(table.userId, table.generatedAt),
])

// 文档导入任务：PDF / Word 每页图片经多模态识别后合并为一篇文章
export const knowledgeBaseImportJobs = pgTable("petrichor_kb_import_job", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    knowledgeBaseId: bigint("knowledge_base_id", { mode: "number" }).notNull(),
    parentNodeId: bigint("parent_node_id", { mode: "number" }),
    sourceType: text("source_type").notNull(),
    fileName: text("file_name").notNull(),
    // 原始 PDF 在对象存储中的 key：服务端据此取字节做本地抽取，也用于失败页重新栅格化。
    sourceKey: text("source_key"),
    title: text("title").notNull(),
    totalPages: integer("total_pages").notNull().default(0),
    processedPages: integer("processed_pages").notNull().default(0),
    status: text("status").notNull().default("pending"),
    modelConfigId: bigint("model_config_id", { mode: "number" }),
    articleId: bigint("article_id", { mode: "number" }),
    error: text("error"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_kb_import_job_user").on(table.userId, table.createdAt),
    index("idx_petrichor_kb_import_job_user_kb").on(table.userId, table.knowledgeBaseId),
])

export const knowledgeBaseImportJobPages = pgTable("petrichor_kb_import_job_page", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: bigint("job_id", { mode: "number" }).notNull(),
    pageNo: integer("page_no").notNull(),
    // 仅 OCR 兜底页有整页图；本地抽取出来的文字页为 null。
    imageKey: text("image_key"),
    // "pdf" = pdf-inspector 本地抽取，"vision" = 多模态识别兜底
    extractedBy: text("extracted_by").notNull().default("vision"),
    status: text("status").notNull().default("pending"),
    markdown: text("markdown"),
    error: text("error"),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_kb_import_job_page_job_no").on(table.jobId, table.pageNo),
    index("idx_petrichor_kb_import_job_page_job").on(table.jobId),
])

// 问答 Agent 跨 thread 长期记忆：从历史对话蒸馏的用户偏好/常关注主题/背景事实。
// embedding 向量列（用于语义去重）通过迁移单独添加，走原生 SQL 读写。
export const agentMemories = pgTable("petrichor_agent_memory", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    evidenceCount: integer("evidence_count").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_agent_memory_user").on(table.userId, table.lastSeenAt),
])

// 蒸馏限频状态：每个用户一行，记录上次蒸馏时间与已消费到的消息水位
// lastMessageId = 旧 KB agent 消息水位；lastAssistantMessageId = 站内 assistant 消息水位
export const agentMemoryStates = pgTable("petrichor_agent_memory_state", {
    userId: bigint("user_id", { mode: "number" }).primaryKey(),
    lastDistilledAt: timestamp("last_distilled_at", { withTimezone: true }),
    lastMessageId: bigint("last_message_id", { mode: "number" }).notNull().default(0),
    lastAssistantMessageId: bigint("last_assistant_message_id", { mode: "number" }).notNull().default(0),
    distillCount: integer("distill_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// 站内统一 Assistant 运行时（chat-first-universal-agent roadmap 契约 4.5）。
// 与旧 petrichor_kb_agent_* / petrichor_doc_qa_* 独立，不迁移旧数据；thread 为软删（deleted_at）。
export const assistantThreads = pgTable("petrichor_assistant_thread", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    focusJson: text("focus_json"),
    contextSummaryMd: text("context_summary_md"),
    contextSummaryUntilMessageId: bigint("context_summary_until_message_id", { mode: "number" }),
    contextSummaryUpdatedAt: timestamp("context_summary_updated_at", { withTimezone: true }),
    /** 会话级危险工具放行：JSON { toolNames: string[], updatedAt: string } */
    dangerAllowlistJson: text("danger_allowlist_json"),
    /** 操作员常驻记忆线程冻结快照：{ userProfileMd, agentNotesMd, frozenAt } */
    operatorMemorySnapshotJson: text("operator_memory_snapshot_json"),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
    index("petrichor_assistant_thread_user_history_idx").on(table.userId, table.updatedAt, table.id),
])

/** 操作员常驻短文记忆（类 USER.md / MEMORY.md）；按 user_id 一行 */
export const assistantOperatorProfiles = pgTable("petrichor_assistant_operator_profile", {
    userId: bigint("user_id", { mode: "number" }).primaryKey(),
    userProfileMd: text("user_profile_md").notNull().default(""),
    agentNotesMd: text("agent_notes_md").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/** 操作员可写 Skills（叠加在内置 playbook 之上） */
export const assistantOperatorSkills = pgTable("petrichor_assistant_operator_skill", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    bodyMd: text("body_md").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("ux_petrichor_assistant_operator_skill_user_name").on(table.userId, table.name),
    index("petrichor_assistant_operator_skill_user_idx").on(table.userId, table.status),
])

export const assistantMessages = pgTable("petrichor_assistant_message", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    role: text("role").notNull(),
    contentJson: text("content_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("petrichor_assistant_message_thread_order_idx").on(table.threadId, table.createdAt, table.id),
])

export const assistantRuns = pgTable("petrichor_assistant_run", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    status: text("status").notNull().default("RUNNING"),
    modelConfigId: bigint("model_config_id", { mode: "number" }),
    intentDomainsJson: text("intent_domains_json"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [
    index("petrichor_assistant_run_thread_idx").on(table.threadId, table.startedAt),
])

export const assistantSteps = pgTable("petrichor_assistant_step", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    stepIndex: integer("step_index").notNull(),
    toolName: text("tool_name").notNull(),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms"),
}, (table) => [
    index("petrichor_assistant_step_run_idx").on(table.runId, table.stepIndex),
])

export const assistantArtifacts = pgTable("petrichor_assistant_artifact", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    runId: bigint("run_id", { mode: "number" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    contentJson: text("content_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("petrichor_assistant_artifact_thread_idx").on(table.threadId, table.createdAt),
])

// Plan 持久化（assistant-runtime-depth 契约 4.1）：upsert_plan 落库，供侧栏冷启动回放。
export const assistantPlans = pgTable("petrichor_assistant_plan", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    planKey: text("plan_key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    todosJson: text("todos_json").notNull(),
    status: text("status").notNull().default("active"),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_assistant_plan_thread_key").on(table.threadId, table.planKey),
    index("petrichor_assistant_plan_thread_updated_idx").on(table.threadId, table.updatedAt),
])

// 危险确认服务端票据：签发时落库，执行时原子消费，防止客户端伪造/重放。
export const assistantConfirmations = pgTable("petrichor_assistant_confirmation", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    confirmationKey: text("confirmation_key").notNull(),
    threadId: bigint("thread_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    toolName: text("tool_name").notNull(),
    inputJson: text("input_json").notNull(),
    status: text("status").notNull().default("pending"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
}, (table) => [
    uniqueIndex("ux_petrichor_assistant_confirmation_key").on(table.confirmationKey),
    index("petrichor_assistant_confirmation_thread_idx").on(table.threadId, table.userId, table.status),
])

// ---------------------------------------------------------------------------
// Agent Runtime v2 持久化（需求 §142~§146）
// agentRuns / agentTraceEvents / agentEvidence 三张表支撑：
// Run 查询、Trace 回放、Debug UI、Eval 聚合与刷新恢复。
// ---------------------------------------------------------------------------

export const agentRuns = pgTable("petrichor_agent_run", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Runtime 生成的字符串 runId，前端与事件流用它关联 */
    runKey: text("run_key").notNull(),
    conversationId: text("conversation_id").notNull(),
    threadId: bigint("thread_id", { mode: "number" }),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    /** 重试时指向被重试的 run，避免复用已失败状态 */
    retryOfRunKey: text("retry_of_run_key"),
    model: text("model").notNull(),
    goal: text("goal").notNull(),
    complexity: text("complexity").notNull().default("simple"),
    status: text("status").notNull().default("running"),
    stopReason: text("stop_reason"),
    answer: text("answer"),
    routingHintJson: text("routing_hint_json"),
    planJson: text("plan_json"),
    loadedSkillsJson: text("loaded_skills_json"),
    metricsJson: text("metrics_json"),
    evalJson: text("eval_json"),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    iterationCount: integer("iteration_count").notNull().default(0),
    delegationCount: integer("delegation_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
    uniqueIndex("ux_petrichor_agent_run_key").on(table.runKey),
    index("petrichor_agent_run_conversation_idx").on(table.conversationId, table.startedAt),
    index("petrichor_agent_run_user_idx").on(table.userId, table.startedAt),
    index("petrichor_agent_run_stop_reason_idx").on(table.stopReason, table.startedAt),
])

export const agentTraceEvents = pgTable("petrichor_agent_trace_event", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runKey: text("run_key").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    /** 已脱敏并截断的载荷（见 agent-runtime/trace.ts redact） */
    payloadJson: text("payload_json"),
    /** tool_call 类事件冗余出工具 id，便于按工具查询 */
    toolId: text("tool_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("ux_petrichor_agent_trace_event_seq").on(table.runKey, table.sequence),
    index("petrichor_agent_trace_event_type_idx").on(table.eventType, table.createdAt),
    index("petrichor_agent_trace_event_tool_idx").on(table.toolId, table.createdAt),
])

export const agentEvidence = pgTable("petrichor_agent_evidence", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runKey: text("run_key").notNull(),
    evidenceKey: text("evidence_key").notNull(),
    source: text("source").notNull(),
    title: text("title"),
    content: text("content").notNull(),
    sourceId: text("source_id"),
    url: text("url"),
    relevance: integer("relevance"),
    confidence: integer("confidence"),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("ux_petrichor_agent_evidence_key").on(table.runKey, table.evidenceKey),
    index("petrichor_agent_evidence_run_idx").on(table.runKey, table.createdAt),
])

export const agentSubtasks = pgTable("petrichor_agent_subtask", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runKey: text("run_key").notNull(),
    taskKey: text("task_key").notNull(),
    objective: text("objective").notNull(),
    status: text("status").notNull(),
    summary: text("summary"),
    depth: integer("depth").notNull().default(1),
    evidenceCount: integer("evidence_count").notNull().default(0),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("ux_petrichor_agent_subtask_key").on(table.runKey, table.taskKey),
    index("petrichor_agent_subtask_run_idx").on(table.runKey, table.createdAt),
])

export type UserRecord = typeof users.$inferSelect
export type BetterAuthUserRecord = typeof betterAuthUsers.$inferSelect
export type BetterAuthAccountRecord = typeof betterAuthAccounts.$inferSelect
export type BetterAuthTwoFactorRecord = typeof betterAuthTwoFactors.$inferSelect
export type NotificationRecord = typeof notifications.$inferSelect
export type KnowledgeBaseRecord = typeof knowledgeBases.$inferSelect
export type KnowledgeBaseNodeRecord = typeof knowledgeBaseNodes.$inferSelect
export type KnowledgeBaseArticleRecord = typeof knowledgeBaseArticles.$inferSelect
export type KnowledgeBaseArticleChunkRecord = typeof knowledgeBaseArticleChunks.$inferSelect
export type KnowledgeBaseWikiPageRecord = typeof knowledgeBaseWikiPages.$inferSelect
export type KnowledgeBaseWikiTreeNodeRecord = typeof knowledgeBaseWikiTreeNodes.$inferSelect
export type KnowledgeBaseWikiPatchRecord = typeof knowledgeBaseWikiPatches.$inferSelect
export type KnowledgeBaseAgentThreadRecord = typeof knowledgeBaseAgentThreads.$inferSelect
export type KnowledgeBaseAgentArtifactRecord = typeof knowledgeBaseAgentArtifacts.$inferSelect
export type KnowledgeBaseArticleShareRecord = typeof knowledgeBaseArticleShares.$inferSelect
export type KnowledgeBaseArticleBurnLinkRecord = typeof knowledgeBaseArticleBurnLinks.$inferSelect
export type AgentApiKeyRecord = typeof agentApiKeys.$inferSelect
export type AgentCallLogRecord = typeof agentCallLogs.$inferSelect
export type SiteAboutProfileRecord = typeof siteAboutProfiles.$inferSelect
export type SiteAppearanceRecord = typeof siteAppearance.$inferSelect
export type SiteProjectShowcaseRecord = typeof siteProjectShowcase.$inferSelect
export type SiteGraphNodeRecord = typeof siteGraphNodes.$inferSelect
export type SiteGraphEdgeRecord = typeof siteGraphEdges.$inferSelect
export type SiteGraphRunRecord = typeof siteGraphRuns.$inferSelect
export type SiteGraphMergeCandidateRecord = typeof siteGraphMergeCandidates.$inferSelect
export type PublicQaRateLimitRecord = typeof publicQaRateLimits.$inferSelect
export type AiCredentialRecord = typeof aiCredentials.$inferSelect
export type AiProviderRecord = typeof aiProviders.$inferSelect
export type AiModelRecord = typeof aiModels.$inferSelect
export type AiBindingRecord = typeof aiBindings.$inferSelect
export type AiReviewRecord = typeof aiReviews.$inferSelect
export type KnowledgeBaseImportJobRecord = typeof knowledgeBaseImportJobs.$inferSelect
export type KnowledgeBaseImportJobPageRecord = typeof knowledgeBaseImportJobPages.$inferSelect
export type AgentMemoryRecord = typeof agentMemories.$inferSelect
export type AgentMemoryStateRecord = typeof agentMemoryStates.$inferSelect
export type AssistantThreadRecord = typeof assistantThreads.$inferSelect
export type AssistantMessageRecord = typeof assistantMessages.$inferSelect
export type AssistantRunRecord = typeof assistantRuns.$inferSelect
export type AssistantStepRecord = typeof assistantSteps.$inferSelect
export type AssistantArtifactRecord = typeof assistantArtifacts.$inferSelect
export type AssistantPlanRecord = typeof assistantPlans.$inferSelect
export type AssistantConfirmationRecord = typeof assistantConfirmations.$inferSelect
export type AgentRunRecord = typeof agentRuns.$inferSelect
export type AgentTraceEventRecord = typeof agentTraceEvents.$inferSelect
export type AgentEvidenceRecord = typeof agentEvidence.$inferSelect
export type AgentSubtaskRecord = typeof agentSubtasks.$inferSelect
