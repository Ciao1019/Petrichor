-- +goose Up
CREATE TABLE petrichor_agent_continuation (
    thread_id bigint PRIMARY KEY REFERENCES petrichor_assistant_thread(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES petrichor_user(id) ON DELETE CASCADE,
    run_key text NOT NULL,
    payload_json jsonb NOT NULL,
    controls_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL CHECK (status IN ('running', 'interrupted', 'completed')),
    lease_token text NOT NULL,
    lease_until timestamptz NOT NULL,
    cancel_requested boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE petrichor_agent_continuation;
