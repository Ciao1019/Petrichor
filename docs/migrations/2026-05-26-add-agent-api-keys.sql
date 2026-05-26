-- 增量迁移：为外部 Agent / Skills 接入增加 API Key 管理表。
-- 说明：只保存 API Key 的 sha256 哈希，明文仅在创建时返回一次。

CREATE TABLE IF NOT EXISTS petrichor_agent_api_key (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES petrichor_user(id) ON DELETE CASCADE,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    scopes_json text NOT NULL DEFAULT '[]',
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_petrichor_agent_api_key_hash
    ON petrichor_agent_api_key(key_hash);

CREATE INDEX IF NOT EXISTS idx_petrichor_agent_api_key_user
    ON petrichor_agent_api_key(user_id, revoked_at, created_at DESC);
