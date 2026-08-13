-- 分块改为服务端执行，并支持父子两级分块。
-- 分片表区分 chunk_type：text 是可召回分片，parent_text 只在命中后回填上下文，不做向量化。
-- 知识库增加父子分块开关与父块/子块大小（0 表示使用 chunker 默认值：父块 4096 / 子块 384）。
-- 执行顺序：在 2026-08-12-add-kb-wiki-page-hierarchy.sql 之后执行。

alter table petrichor_kb_document_chunk
    add column if not exists chunk_type text not null default 'text',
    add column if not exists parent_chunk_index integer;

create index if not exists petrichor_kb_document_chunk_kb_type_idx
    on petrichor_kb_document_chunk(knowledge_base_id, chunk_type);

alter table petrichor_kb_knowledge_base
    add column if not exists enable_parent_child boolean not null default false,
    add column if not exists parent_chunk_size integer not null default 0,
    add column if not exists child_chunk_size integer not null default 0;

-- 正文分段边界（页 / 工作表）随文件保存，重新分块时无需客户端再传一遍。
alter table petrichor_kb_document
    add column if not exists segments_json text;

-- Wiki 任务区分类型：ingest 从文档构建，cleanup 在文档删除后重整。
-- 重整会逐页 Reduce（每页一次模型调用），必须走后台队列而不是同步执行。
alter table petrichor_kb_wiki_ingest_job
    add column if not exists kind text not null default 'ingest';
