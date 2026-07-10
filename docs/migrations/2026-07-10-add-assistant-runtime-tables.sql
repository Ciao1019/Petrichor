-- 2026-07-10 站内 Assistant 运行时表（thread / message / run / step / artifact）
-- 以及记忆蒸馏水位列 last_assistant_message_id
-- 安全可重入：create if not exists / add column if not exists

alter table petrichor_agent_memory_state
    add column if not exists last_assistant_message_id bigint not null default 0;

create table if not exists petrichor_assistant_thread (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    title text not null,
    focus_json text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);

create index if not exists petrichor_assistant_thread_user_history_idx
    on petrichor_assistant_thread(user_id, updated_at desc, id desc);

create table if not exists petrichor_assistant_message (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    role text not null,
    content_json text,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_assistant_message_thread_order_idx
    on petrichor_assistant_message(thread_id, created_at, id);

create table if not exists petrichor_assistant_run (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    status text not null default 'RUNNING',
    model_config_id bigint,
    intent_domains_json text,
    error_code text,
    started_at timestamptz not null default now(),
    finished_at timestamptz
);

create index if not exists petrichor_assistant_run_thread_idx
    on petrichor_assistant_run(thread_id, started_at desc);

create table if not exists petrichor_assistant_step (
    id bigint generated always as identity primary key,
    run_id bigint not null references petrichor_assistant_run(id) on delete cascade,
    step_index integer not null,
    tool_name text not null,
    input_json text,
    output_json text,
    status text not null,
    duration_ms integer
);

create index if not exists petrichor_assistant_step_run_idx
    on petrichor_assistant_step(run_id, step_index);

create table if not exists petrichor_assistant_artifact (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    run_id bigint references petrichor_assistant_run(id) on delete set null,
    kind text not null,
    title text not null,
    content_json text,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_assistant_artifact_thread_idx
    on petrichor_assistant_artifact(thread_id, created_at desc);
