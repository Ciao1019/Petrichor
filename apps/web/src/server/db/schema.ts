import {
    bigint,
    boolean,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core"

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
    agentSource: text("agent_source").notNull(),
    agentTool: text("agent_tool"),
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
    index("idx_petrichor_agent_call_log_source_created").on(table.userId, table.agentSource, table.createdAt),
])

export const siteAboutProfiles = pgTable("petrichor_site_about_profile", {
    id: integer("id").primaryKey(),
    displayName: text("display_name").notNull().default("CiZai"),
    roleTitle: text("role_title").notNull().default("Creative Dev & Visual Artist"),
    intro: text("intro").notNull().default("我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。"),
    expertiseJson: text("expertise_json").notNull().default("[\"Frontend Architecture\",\"AI 应用开发\",\"Knowledge Systems\",\"Creative Coding\"]"),
    toolkitJson: text("toolkit_json").notNull().default("[\"TypeScript\",\"React\",\"Next.js\",\"AI\",\"PostgreSQL\",\"Minecraft\"]"),
    quote: text("quote").notNull().default("Code is just another medium for painting dreams."),
    ...timestamps,
})

export const siteAppearance = pgTable("petrichor_site_appearance", {
    id: integer("id").primaryKey(),
    dayTheme: text("day_theme").notNull().default("paper"),
    nightTheme: text("night_theme").notNull().default("slate"),
    dayStartHour: integer("day_start_hour").notNull().default(6),
    dayEndHour: integer("day_end_hour").notNull().default(18),
    allowManualOverride: boolean("allow_manual_override").notNull().default(true),
    ...timestamps,
})

export const aiModelConfigs = pgTable("petrichor_ai_model_config", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    configType: text("config_type").notNull(),
    protocol: text("protocol").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    apiKeyEnc: text("api_key_enc"),
    model: text("model").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    extraJson: text("extra_json"),
    ...timestamps,
}, (table) => [
    index("idx_petrichor_ai_model_config_user_type").on(table.userId, table.configType),
    uniqueIndex("ux_petrichor_ai_model_config_user_type_name").on(table.userId, table.configType, table.name),
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

export type UserRecord = typeof users.$inferSelect
export type BetterAuthUserRecord = typeof betterAuthUsers.$inferSelect
export type BetterAuthAccountRecord = typeof betterAuthAccounts.$inferSelect
export type BetterAuthTwoFactorRecord = typeof betterAuthTwoFactors.$inferSelect
export type NotificationRecord = typeof notifications.$inferSelect
export type KnowledgeBaseRecord = typeof knowledgeBases.$inferSelect
export type KnowledgeBaseNodeRecord = typeof knowledgeBaseNodes.$inferSelect
export type KnowledgeBaseArticleRecord = typeof knowledgeBaseArticles.$inferSelect
export type KnowledgeBaseWikiPageRecord = typeof knowledgeBaseWikiPages.$inferSelect
export type KnowledgeBaseWikiPatchRecord = typeof knowledgeBaseWikiPatches.$inferSelect
export type KnowledgeBaseAgentThreadRecord = typeof knowledgeBaseAgentThreads.$inferSelect
export type KnowledgeBaseAgentArtifactRecord = typeof knowledgeBaseAgentArtifacts.$inferSelect
export type KnowledgeBaseArticleShareRecord = typeof knowledgeBaseArticleShares.$inferSelect
export type AgentApiKeyRecord = typeof agentApiKeys.$inferSelect
export type AgentCallLogRecord = typeof agentCallLogs.$inferSelect
export type SiteAboutProfileRecord = typeof siteAboutProfiles.$inferSelect
export type SiteAppearanceRecord = typeof siteAppearance.$inferSelect
export type AiModelConfigRecord = typeof aiModelConfigs.$inferSelect
export type AiReviewRecord = typeof aiReviews.$inferSelect
