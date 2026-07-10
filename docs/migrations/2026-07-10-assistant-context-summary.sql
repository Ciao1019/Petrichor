-- 2026-07-10 assistant thread 深度上下文压缩列（契约 4.9）
alter table petrichor_assistant_thread
    add column if not exists context_summary_md text;

alter table petrichor_assistant_thread
    add column if not exists context_summary_until_message_id bigint;

alter table petrichor_assistant_thread
    add column if not exists context_summary_updated_at timestamptz;
