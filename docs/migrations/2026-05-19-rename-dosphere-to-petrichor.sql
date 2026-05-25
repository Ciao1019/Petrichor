-- 增量迁移：将所有 dosphere_* 表和索引重命名为 petrichor_*
-- 在已有数据库上执行此脚本，无需重建数据。
-- 幂等：若表/索引已是新名称，PostgreSQL 会报 "relation does not exist"，可忽略。

-- ============================================================
-- 1. 重命名表
-- ============================================================
ALTER TABLE IF EXISTS dosphere_user                RENAME TO petrichor_user;
ALTER TABLE IF EXISTS dosphere_auth_session        RENAME TO petrichor_auth_session;
ALTER TABLE IF EXISTS dosphere_sticky_note         RENAME TO petrichor_sticky_note;
ALTER TABLE IF EXISTS dosphere_notification        RENAME TO petrichor_notification;
ALTER TABLE IF EXISTS dosphere_kb_knowledge_base   RENAME TO petrichor_kb_knowledge_base;
ALTER TABLE IF EXISTS dosphere_kb_node             RENAME TO petrichor_kb_node;
ALTER TABLE IF EXISTS dosphere_kb_article          RENAME TO petrichor_kb_article;
ALTER TABLE IF EXISTS dosphere_kb_article_tag      RENAME TO petrichor_kb_article_tag;
ALTER TABLE IF EXISTS dosphere_kb_article_share    RENAME TO petrichor_kb_article_share;
ALTER TABLE IF EXISTS dosphere_site_about_profile  RENAME TO petrichor_site_about_profile;
ALTER TABLE IF EXISTS dosphere_ai_model_config     RENAME TO petrichor_ai_model_config;

-- ============================================================
-- 2. 重命名索引
-- ============================================================
ALTER INDEX IF EXISTS ux_dosphere_user_auth_user_id              RENAME TO ux_petrichor_user_auth_user_id;
ALTER INDEX IF EXISTS ux_dosphere_user_linuxdo_account_id        RENAME TO ux_petrichor_user_linuxdo_account_id;
ALTER INDEX IF EXISTS dosphere_auth_session_user_id_idx          RENAME TO petrichor_auth_session_user_id_idx;
ALTER INDEX IF EXISTS dosphere_auth_session_expires_at_idx       RENAME TO petrichor_auth_session_expires_at_idx;
ALTER INDEX IF EXISTS dosphere_sticky_note_user_order_idx        RENAME TO petrichor_sticky_note_user_order_idx;
ALTER INDEX IF EXISTS dosphere_notification_user_read_idx        RENAME TO petrichor_notification_user_read_idx;
ALTER INDEX IF EXISTS dosphere_notification_user_created_idx     RENAME TO petrichor_notification_user_created_idx;
ALTER INDEX IF EXISTS dosphere_notification_user_category_idx    RENAME TO petrichor_notification_user_category_idx;
ALTER INDEX IF EXISTS dosphere_notification_biz_idx              RENAME TO petrichor_notification_biz_idx;
ALTER INDEX IF EXISTS dosphere_kb_knowledge_base_user_id_idx     RENAME TO petrichor_kb_knowledge_base_user_id_idx;
ALTER INDEX IF EXISTS dosphere_kb_node_kb_parent_order_idx       RENAME TO petrichor_kb_node_kb_parent_order_idx;
ALTER INDEX IF EXISTS dosphere_kb_article_kb_updated_idx         RENAME TO petrichor_kb_article_kb_updated_idx;
ALTER INDEX IF EXISTS dosphere_kb_article_public_updated_idx     RENAME TO petrichor_kb_article_public_updated_idx;
ALTER INDEX IF EXISTS dosphere_kb_article_tag_article_idx        RENAME TO petrichor_kb_article_tag_article_idx;
ALTER INDEX IF EXISTS dosphere_kb_article_share_user_id_idx      RENAME TO petrichor_kb_article_share_user_id_idx;
ALTER INDEX IF EXISTS dosphere_kb_article_share_public_idx       RENAME TO petrichor_kb_article_share_public_idx;
ALTER INDEX IF EXISTS dosphere_ai_model_config_user_type_idx     RENAME TO petrichor_ai_model_config_user_type_idx;
ALTER INDEX IF EXISTS dosphere_ai_model_config_default_idx       RENAME TO petrichor_ai_model_config_default_idx;
