import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildInitialMigrationSql } from "./full-migration"

describe("buildInitialMigrationSql", () => {
    it("与仓库中可直接执行的初始化 SQL 保持一致", () => {
        const checkedInSql = fs.readFileSync(
            path.resolve(process.cwd(), "../../docs/petrichor-init.sql"),
            "utf8",
        )

        expect(checkedInSql).toBe(`${buildInitialMigrationSql()}\n`)
    })

    it("包含当前业务基础表，且不再创建 Todo、普通聊天、便签和向量表", () => {
        const sql = buildInitialMigrationSql()

        expect(sql).toContain("create table if not exists petrichor_user")
        expect(sql).toContain("email text not null")
        expect(sql).toContain("user_type text not null default 'LOCAL'")
        expect(sql).toContain("auth_user_id text")
        expect(sql).toContain("linuxdo_account_id text")
        expect(sql).toContain("ux_petrichor_user_linuxdo_account_id")
        expect(sql).toContain("create table if not exists better_auth_user")
        expect(sql).toContain("create table if not exists better_auth_session")
        expect(sql).toContain("create table if not exists better_auth_account")
        expect(sql).toContain("create table if not exists better_auth_verification")
        expect(sql).toContain("create table if not exists better_auth_two_factor")
        expect(sql).toContain("two_factor_enabled boolean not null default false")
        expect(sql).toContain("add column if not exists two_factor_enabled boolean")
        expect(sql).toContain("insert into better_auth_user")
        expect(sql).toContain("provider_id, user_id, password")
        expect(sql).toContain("create table if not exists petrichor_auth_session")
        expect(sql).toContain("create table if not exists petrichor_notification")
        expect(sql).toContain("payload_json text")
        expect(sql).toContain("create table if not exists petrichor_kb_article_share")
        expect(sql).toContain("is_repost boolean not null default false")
        expect(sql).toContain("original_url text")
        expect(sql).toContain("original_author_name text")
        expect(sql).toContain("add column if not exists is_repost boolean not null default false")
        expect(sql).toContain("add column if not exists original_url text")
        expect(sql).toContain("add column if not exists original_author_name text")
        expect(sql).toContain("create table if not exists petrichor_kb_article_burn_link")
        expect(sql).toContain("create table if not exists petrichor_kb_article_chunk")
        expect(sql).toContain("recommended_questions_json text not null default '[]'")
        expect(sql).toContain("max_views integer not null default 1")
        expect(sql).toContain("status text not null default 'ACTIVE'")
        expect(sql).toContain("petrichor_kb_burn_link_article_idx")
        expect(sql).toContain("public_excerpt text")
        expect(sql).toContain("reading_minutes integer")
        expect(sql).toContain("toc_json text")
        expect(sql).toContain("public_content_hash text")
        expect(sql).toContain("ai_summary text")
        expect(sql).toContain("add column if not exists ai_summary text")
        expect(sql).toContain("create extension if not exists pg_trgm")
        expect(sql).toContain("idx_petrichor_kb_article_title_trgm")
        expect(sql).toContain("idx_petrichor_kb_article_public_excerpt_trgm")
        expect(sql).toContain("idx_petrichor_kb_article_content_md_trgm")
        expect(sql).toContain("create index if not exists petrichor_kb_article_public_updated_idx")
        expect(sql).toContain("create index if not exists petrichor_kb_article_share_public_idx")
        expect(sql).toContain("create table if not exists petrichor_site_about_profile")
        expect(sql).toContain("insert into petrichor_site_about_profile")
        expect(sql).toContain("Code is just another medium for painting dreams.")
        expect(sql).toContain("create table if not exists petrichor_site_appearance")
        expect(sql).toContain("insert into petrichor_site_appearance")
        expect(sql).toContain("create table if not exists petrichor_ai_credential")
        expect(sql).toContain("create table if not exists petrichor_ai_provider")
        expect(sql).toContain("create table if not exists petrichor_ai_model")
        expect(sql).toContain("create table if not exists petrichor_ai_binding")
        expect(sql).toContain("drop table if exists petrichor_ai_model_config")
        expect(sql).not.toContain("create table if not exists petrichor_list")
        expect(sql).not.toContain("create table if not exists petrichor_task")
        expect(sql).not.toContain("create table if not exists petrichor_tag")
        expect(sql).not.toContain("create table if not exists petrichor_task_tag")
        expect(sql).not.toContain("create table if not exists petrichor_ai_chat_session")
        expect(sql).not.toContain("create table if not exists petrichor_ai_chat_run")
        expect(sql).not.toContain("create table if not exists petrichor_ai_chat_message")
        expect(sql).not.toContain("create table if not exists petrichor_kb_embedding_chunk")
        expect(sql).not.toContain("extensions.vector")
        expect(sql).not.toContain("create table if not exists petrichor_kb_article_share_invite")
        expect(sql).not.toContain("create table if not exists petrichor_kb_resource_grant")
        expect(sql).not.toContain("create table if not exists petrichor_ai_model_config_share_code")
        expect(sql).not.toContain("create table if not exists petrichor_ai_model_config_binding_application")
        expect(sql).not.toContain("create table if not exists petrichor_ai_model_config_binding")
        expect(sql).not.toContain("create table if not exists petrichor_sticky_note")
    })

    it("包含站内 Assistant 运行时五张表（chat-first roadmap 契约 4.5）", () => {
        const sql = buildInitialMigrationSql()

        expect(sql).toContain("create table if not exists petrichor_assistant_thread")
        expect(sql).toContain("focus_json text")
        expect(sql).toContain("context_summary_md text")
        expect(sql).toContain("context_summary_until_message_id bigint")
        expect(sql).toContain("deleted_at timestamptz")
        expect(sql).toContain("create table if not exists petrichor_assistant_message")
        expect(sql).toContain("create table if not exists petrichor_assistant_run")
        expect(sql).toContain("intent_domains_json text")
        expect(sql).toContain("error_code text")
        expect(sql).toContain("create table if not exists petrichor_assistant_step")
        expect(sql).toContain("step_index integer not null")
        expect(sql).toContain("duration_ms integer")
        expect(sql).toContain("create table if not exists petrichor_assistant_artifact")
        expect(sql).toContain("petrichor_assistant_thread_user_history_idx")
        expect(sql).toContain("create table if not exists petrichor_assistant_plan")
        expect(sql).toContain("ux_petrichor_assistant_plan_thread_key")
        expect(sql).toContain("create table if not exists petrichor_assistant_confirmation")
        expect(sql).toContain("ux_petrichor_assistant_confirmation_key")
        expect(sql).toContain("create table if not exists petrichor_assistant_message_embedding")
    })

    /**
     * 向量列必须是无约束 `vector`，且不能有钉死维度的 HNSW 索引——
     * 那样会把维度锁回 1024，换向量模型就得清库。索引按维度动态建，
     * 见 server/retrieval/vector-space.ts。
     */
    it("向量列无维度约束，且不建固定维度索引", () => {
        const sql = buildInitialMigrationSql()

        // 只看 DDL，注释里提到 vector(1024) 是允许的
        const ddl = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n")
        expect(ddl).not.toMatch(/embedding\s+vector\(\d+\)/)
        expect(ddl).not.toContain("using hnsw (embedding vector_cosine_ops)")

        for (const table of [
            "petrichor_kb_wiki_tree_node",
            "petrichor_agent_memory",
            "petrichor_assistant_message_embedding",
        ]) {
            expect(sql).toContain(`alter table ${table} alter column embedding type vector;`)
        }
        // 放宽列类型前必须先拆掉旧索引，否则维度仍被锁死
        expect(sql.indexOf("drop index if exists idx_petrichor_kb_wiki_tree_node_embedding;"))
            .toBeLessThan(sql.indexOf("alter table petrichor_kb_wiki_tree_node alter column embedding type vector;"))
    })

    it("目录树节点带向量生命周期元数据，用于换模型后判定重算", () => {
        const sql = buildInitialMigrationSql()

        for (const column of [
            "embedding_status",
            "embedding_model",
            "embedding_dimensions",
            "embedding_version",
            "embedding_error",
            "embedding_updated_at",
        ]) {
            expect(sql).toContain(`add column if not exists ${column}`)
        }
    })
})
