-- 2026-07-17 操作员情景检索 / 可写 Skills / 手动进化
create table if not exists petrichor_assistant_operator_skill (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    name text not null,
    description text not null,
    body_md text not null,
    version integer not null default 1,
    status text not null default 'active',
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_assistant_operator_skill_user_name
    on petrichor_assistant_operator_skill(user_id, name);

create index if not exists petrichor_assistant_operator_skill_user_idx
    on petrichor_assistant_operator_skill(user_id, status);

create table if not exists petrichor_assistant_operator_skill_pending (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    skill_name text not null,
    action text not null,
    before_md text,
    after_md text,
    description text,
    gist text not null,
    status text not null default 'pending',
    created_at timestamptz not null default now(),
    resolved_at timestamptz
);

create index if not exists petrichor_assistant_operator_skill_pending_user_idx
    on petrichor_assistant_operator_skill_pending(user_id, status, created_at);

create table if not exists petrichor_assistant_operator_evolution_proposal (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    target_type text not null,
    target_name text,
    before_md text not null,
    after_md text not null,
    rationale_md text not null,
    status text not null default 'pending',
    created_at timestamptz not null default now(),
    resolved_at timestamptz
);

create index if not exists petrichor_assistant_operator_evolution_user_idx
    on petrichor_assistant_operator_evolution_proposal(user_id, status, created_at);

create index if not exists petrichor_assistant_message_embedding_fts_idx
    on petrichor_assistant_message_embedding
    using gin (to_tsvector('simple', coalesce(excerpt_md, '')));
