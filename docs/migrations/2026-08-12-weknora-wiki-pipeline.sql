-- 对齐 WeKnora 的文档重建、分片元数据与异步 Wiki 构建任务。

alter table petrichor_kb_document
    add column if not exists extracted_text text;

alter table petrichor_kb_document_chunk
    add column if not exists context_header text,
    add column if not exists start_offset integer,
    add column if not exists end_offset integer;

create table if not exists petrichor_kb_wiki_ingest_job (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    document_ids_json text not null default '[]',
    force_rebuild boolean not null default false,
    status text not null default 'pending',
    total_documents integer not null default 0,
    processed_documents integer not null default 0,
    phase text not null default 'queued',
    current_document text,
    total_pages integer not null default 0,
    processed_pages integer not null default 0,
    warnings_json text not null default '[]',
    error text,
    available_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table petrichor_kb_wiki_ingest_job
    add column if not exists phase text not null default 'queued',
    add column if not exists current_document text,
    add column if not exists total_pages integer not null default 0,
    add column if not exists processed_pages integer not null default 0;

create index if not exists petrichor_kb_wiki_ingest_job_status_available_idx
    on petrichor_kb_wiki_ingest_job(status, available_at);

create index if not exists petrichor_kb_wiki_ingest_job_user_kb_created_idx
    on petrichor_kb_wiki_ingest_job(user_id, knowledge_base_id, created_at);

-- 只修改仍使用旧默认值的知识库；用户自定义值保持不变。
update petrichor_kb_knowledge_base
set chunk_strategy = 'auto',
    chunk_size = 512,
    chunk_overlap = 80,
    chunk_separators_json = '["\n\n","\n","。"]'
where chunk_strategy = 'recursive'
  and chunk_size = 700
  and chunk_overlap = 100;

alter table petrichor_kb_knowledge_base
    alter column chunk_strategy set default 'auto',
    alter column chunk_size set default 512,
    alter column chunk_overlap set default 80;
