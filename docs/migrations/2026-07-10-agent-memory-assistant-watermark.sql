-- 站内 Assistant 记忆蒸馏水位：与旧 KB agent 消息水位分离
alter table petrichor_agent_memory_state
    add column if not exists last_assistant_message_id bigint not null default 0;
