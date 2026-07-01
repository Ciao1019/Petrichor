-- ============================================================
-- 知识库 Wiki 目录树语义检索：pgvector 向量列
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：知识库问答走「LLM Wiki + PageIndex 推理式目录树导航」。本次为目录树章节节点
--      （petrichor_kb_wiki_tree_node，检索单元）加向量列 + HNSW 余弦索引，
--      新增 semantic_search_tree 语义检索工具，作为 search_document_tree 的补充（不替换）。
--      向量维度 1024，对应 embedding 模型 BAAI/bge-m3。
-- 依赖：vector 扩展（若未装过，先执行 `create extension if not exists vector;`）。
-- 全部 ADD COLUMN / CREATE INDEX IF NOT EXISTS，可安全重复执行。
--
-- ⚠️ 执行本 SQL 后语义检索还需：
--      A. 已配置并启用一条 config_type='EMBEDDING' 的 AI 模型配置（如 bge-m3）；
--      B. 先「编译 Wiki」生成目录树节点，再点「生成向量」（或运行 backfill 脚本）。
--         之后每次编译 Wiki 会自动为新章节补写向量（best-effort）。
-- ============================================================

create extension if not exists vector;

-- 章节节点向量列（1024 维，对应 bge-m3）
alter table petrichor_kb_wiki_tree_node add column if not exists embedding vector(1024);

-- HNSW 余弦距离索引（<=> 运算符）
create index if not exists idx_petrichor_kb_wiki_tree_node_embedding
    on petrichor_kb_wiki_tree_node using hnsw (embedding vector_cosine_ops);
