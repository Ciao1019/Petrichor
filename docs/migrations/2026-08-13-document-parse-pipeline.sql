-- 文档解析改为异步流水线，并补齐三块能力：
--   1. 每次解析记录 span 树（root / stage / subspan / generation），前端渲染处理流水线；
--   2. 上传时可覆盖解析配置（解析引擎 / 分块 / 图像处理 / AI 问题生成 / 文档标签）；
--   3. AI 为每个分片生成的问题独立向量化，命中后回指源分片，提高召回率。
-- 执行顺序：在 2026-08-13-server-side-chunking-parent-child.sql 之后执行。

-- 本次解析用的配置与尝试号：重新解析时 attempt +1，span 按 attempt 分支存放。
alter table petrichor_kb_document
    add column if not exists parse_config_json text,
    add column if not exists parse_attempt integer not null default 0;

-- 解析流水线 span。同一 (document_id, attempt, span_id) 唯一，重试覆盖同一行而不是无限膨胀。
create table if not exists petrichor_kb_document_span (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    attempt integer not null default 1,
    span_id text not null,
    parent_span_id text,
    name text not null,
    kind text not null,
    status text not null,
    input jsonb,
    output jsonb,
    error_code text,
    error_message text,
    started_at timestamptz,
    finished_at timestamptz,
    duration_ms bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (document_id, attempt, span_id)
);

create index if not exists petrichor_kb_document_span_doc_attempt_idx
    on petrichor_kb_document_span(document_id, attempt);

-- 分片衍生问题：每条问题一行、单独 embedding，检索时并行召回后映射回 chunk_id。
create table if not exists petrichor_kb_document_chunk_question (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    chunk_id bigint not null references petrichor_kb_document_chunk(id) on delete cascade,
    question text not null,
    created_at timestamptz not null default now()
);

alter table petrichor_kb_document_chunk_question
    add column if not exists embedding vector(1024);

create index if not exists petrichor_kb_document_chunk_question_chunk_idx
    on petrichor_kb_document_chunk_question(chunk_id);

create index if not exists petrichor_kb_document_chunk_question_doc_idx
    on petrichor_kb_document_chunk_question(document_id);

create index if not exists petrichor_kb_document_chunk_question_embedding_idx
    on petrichor_kb_document_chunk_question using hnsw (embedding vector_cosine_ops);

-- 文档标签：上传时批量打，文档列表按标签筛选。
create table if not exists petrichor_kb_document_tag (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    tag text not null,
    created_at timestamptz not null default now(),
    unique (document_id, tag)
);

create index if not exists petrichor_kb_document_tag_kb_idx
    on petrichor_kb_document_tag(knowledge_base_id, tag);
