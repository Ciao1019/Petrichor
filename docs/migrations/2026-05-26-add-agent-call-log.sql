-- 增量迁移：记录外部 Agent API 调用审计日志。
-- 用途：追踪来源 Agent、来源 IP、请求入参、响应出参、状态码和耗时。

CREATE TABLE IF NOT EXISTS petrichor_agent_call_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES petrichor_user(id) ON DELETE CASCADE,
    api_key_id bigint NOT NULL REFERENCES petrichor_agent_api_key(id) ON DELETE CASCADE,
    api_key_prefix text NOT NULL,
    agent_source text NOT NULL,
    agent_tool text,
    method text NOT NULL,
    path text NOT NULL,
    ip text,
    user_agent text,
    request_json text,
    response_json text,
    status_code integer NOT NULL,
    duration_ms integer NOT NULL,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_petrichor_agent_call_log_user_created
    ON petrichor_agent_call_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_petrichor_agent_call_log_key_created
    ON petrichor_agent_call_log(api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_petrichor_agent_call_log_source_created
    ON petrichor_agent_call_log(user_id, agent_source, created_at DESC);
