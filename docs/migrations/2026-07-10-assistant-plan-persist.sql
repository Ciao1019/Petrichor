-- 2026-07-10 assistant Plan 持久化（assistant-runtime-depth 契约 4.1）
create table if not exists petrichor_assistant_plan (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    user_id bigint not null,
    plan_key text not null,
    title text not null,
    description text,
    todos_json text not null,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_assistant_plan_thread_key
    on petrichor_assistant_plan(thread_id, plan_key);

create index if not exists petrichor_assistant_plan_thread_updated_idx
    on petrichor_assistant_plan(thread_id, updated_at desc);
