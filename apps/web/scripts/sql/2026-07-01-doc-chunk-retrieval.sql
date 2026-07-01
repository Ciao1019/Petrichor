-- ============================================================
-- 文档库分块关键词检索增强：pg_trgm 全文检索
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：文档库问答（petrichor_doc_chunk）此前只用 LIKE 关键词检索，中文效果一般。
--      本次为分块表加 pg_trgm 三元组索引 —— search_documents 改为 ILIKE 召回 + word_similarity 排序，
--      对中文更友好。（文档库不做向量语义检索；向量语义检索只在知识库启用。）
-- 全部 IF NOT EXISTS，可安全重复执行。
-- ============================================================

create extension if not exists pg_trgm;

-- 关键词全文检索：doc_chunk.text 的三元组 GIN 索引（支撑 ILIKE / similarity / word_similarity）
create index if not exists idx_petrichor_doc_chunk_text_trgm
    on petrichor_doc_chunk using gin (text gin_trgm_ops);
