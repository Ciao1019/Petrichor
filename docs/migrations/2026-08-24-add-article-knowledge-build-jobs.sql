create table if not exists petrichor_kb_article_build_job (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    active_key text,
    status text not null default 'pending',
    force_rebuild boolean not null default false,
    result_json text,
    error text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_kb_article_build_job_active
    on petrichor_kb_article_build_job(active_key);

create index if not exists idx_petrichor_kb_article_build_job_user
    on petrichor_kb_article_build_job(user_id, created_at desc);

create index if not exists idx_petrichor_kb_article_build_job_article
    on petrichor_kb_article_build_job(user_id, article_id, created_at desc);
