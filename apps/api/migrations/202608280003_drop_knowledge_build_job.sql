-- +goose Up

-- 服务器常驻部署中，知识构建改由 Go API 的内存队列调度；最终切片、Wiki 页面、
-- 关系和向量索引仍由业务事务持久化。该表只保存过渡任务状态，因此删除。
DROP TABLE public.petrichor_kb_knowledge_build_job;

-- +goose Down

CREATE TABLE public.petrichor_kb_knowledge_build_job (
    id text NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    article_id bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    result_json text,
    error text,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    replay_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT petrichor_kb_knowledge_build_job_pkey PRIMARY KEY (id),
    CONSTRAINT petrichor_kb_knowledge_build_job_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE,
    CONSTRAINT petrichor_kb_knowledge_build_job_knowledge_base_id_fkey
        FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE,
    CONSTRAINT petrichor_kb_knowledge_build_job_article_id_fkey
        FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE,
    CONSTRAINT petrichor_kb_knowledge_build_job_attempts_check
        CHECK (attempt_count >= 0 AND max_attempts > 0 AND replay_count >= 0)
);

CREATE UNIQUE INDEX uq_petrichor_kb_knowledge_build_job_active
    ON public.petrichor_kb_knowledge_build_job (user_id, knowledge_base_id, article_id)
    WHERE status IN ('pending', 'processing');

CREATE INDEX idx_petrichor_kb_knowledge_build_job_user
    ON public.petrichor_kb_knowledge_build_job (user_id, created_at DESC);

CREATE INDEX idx_petrichor_kb_knowledge_build_job_runnable
    ON public.petrichor_kb_knowledge_build_job (next_attempt_at, created_at)
    WHERE status = 'pending';

CREATE INDEX idx_petrichor_kb_knowledge_build_job_dead_letter
    ON public.petrichor_kb_knowledge_build_job (dead_lettered_at DESC)
    WHERE status = 'dead_letter';
