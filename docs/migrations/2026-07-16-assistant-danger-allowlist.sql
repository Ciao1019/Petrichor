-- 2026-07-16 assistant 会话级危险操作 allowlist
alter table petrichor_assistant_thread
    add column if not exists danger_allowlist_json text;
