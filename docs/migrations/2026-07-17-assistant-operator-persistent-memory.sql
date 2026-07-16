-- 2026-07-17 操作员常驻短文记忆 + 线程冻结快照
alter table petrichor_assistant_thread
    add column if not exists operator_memory_snapshot_json text;

create table if not exists petrichor_assistant_operator_profile (
    user_id bigint primary key,
    user_profile_md text not null default '',
    agent_notes_md text not null default '',
    updated_at timestamptz not null default now()
);
