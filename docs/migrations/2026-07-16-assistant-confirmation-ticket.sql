-- 2026-07-16 assistant 危险确认服务端票据（防伪造/重放）
create table if not exists petrichor_assistant_confirmation (
    id bigint generated always as identity primary key,
    confirmation_key text not null,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    user_id bigint not null,
    tool_name text not null,
    input_json text not null,
    status text not null default 'pending',
    consumed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_assistant_confirmation_key
    on petrichor_assistant_confirmation(confirmation_key);

create index if not exists petrichor_assistant_confirmation_thread_idx
    on petrichor_assistant_confirmation(thread_id, user_id, status);
