-- 2026-07-10 assistant step 韧性错误码（契约 4.7 tool_timeout / tool_retry_exhausted）
alter table petrichor_assistant_step
    add column if not exists error_code text;
