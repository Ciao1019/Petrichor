-- 2026-07-02 新增问答 Agent 跨 thread 长期记忆
-- 从历史对话蒸馏用户偏好/常关注主题，注入 system prompt
-- 安全可重入：使用 if not exists
create table if not exists petrichor_agent_memory (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    kind text not null,
    content text not null,
    evidence_count integer not null default 1,
    last_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_petrichor_agent_memory_user
    on petrichor_agent_memory (user_id, last_seen_at desc);

-- 向量列用于新旧记忆的语义去重合并；未配置向量模型时功能自动降级为精确去重
alter table petrichor_agent_memory add column if not exists embedding vector(1024);

create index if not exists idx_petrichor_agent_memory_embedding
    on petrichor_agent_memory using hnsw (embedding vector_cosine_ops);

create table if not exists petrichor_agent_memory_state (
    user_id bigint primary key,
    last_distilled_at timestamptz,
    last_message_id bigint not null default 0,
    distill_count integer not null default 0,
    updated_at timestamptz not null default now()
);
