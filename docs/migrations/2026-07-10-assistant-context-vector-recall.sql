-- 2026-07-10 assistant 消息向量召回（assistant-runtime-depth 契约 4.3）
create table if not exists petrichor_assistant_message_embedding (
    message_id bigint primary key references petrichor_assistant_message(id) on delete cascade,
    thread_id bigint not null,
    user_id bigint not null,
    excerpt_md text not null,
    embedding vector(1024),
    created_at timestamptz not null default now()
);

create index if not exists petrichor_assistant_message_embedding_thread_idx
    on petrichor_assistant_message_embedding(thread_id, user_id);

create index if not exists idx_petrichor_assistant_message_embedding
    on petrichor_assistant_message_embedding using hnsw (embedding vector_cosine_ops);
