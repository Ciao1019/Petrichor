-- +goose Up

-- 视觉导入任务、页进度、重试与死信已全部迁入 Asynq 共用 Redis。
-- 已生成文章仍保留在 petrichor_kb_article；这里仅删除旧任务历史与未完成进度。
DROP TABLE public.petrichor_kb_import_job_page;
DROP TABLE public.petrichor_kb_import_job;

-- +goose Down

CREATE TABLE public.petrichor_kb_import_job (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES public.petrichor_user(id) ON DELETE CASCADE,
    knowledge_base_id bigint NOT NULL REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE,
    parent_node_id bigint REFERENCES public.petrichor_kb_node(id) ON DELETE SET NULL,
    source_type text NOT NULL,
    file_name text NOT NULL,
    source_key text,
    title text NOT NULL,
    total_pages integer DEFAULT 0 NOT NULL,
    processed_pages integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    model_config_id bigint,
    article_id bigint REFERENCES public.petrichor_kb_article(id) ON DELETE SET NULL,
    error text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    replay_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT petrichor_kb_import_job_replay_count_check CHECK (replay_count >= 0)
);

CREATE TABLE public.petrichor_kb_import_job_page (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id bigint NOT NULL REFERENCES public.petrichor_kb_import_job(id) ON DELETE CASCADE,
    page_no integer NOT NULL,
    image_key text,
    extracted_by text DEFAULT 'vision'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    markdown text,
    error text,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    dead_lettered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT petrichor_kb_import_job_page_job_id_page_no_key UNIQUE (job_id, page_no),
    CONSTRAINT petrichor_kb_import_job_page_attempts_check
        CHECK (attempt_count >= 0 AND max_attempts > 0)
);

CREATE INDEX idx_petrichor_kb_import_job_user
    ON public.petrichor_kb_import_job (user_id, created_at DESC);
CREATE INDEX idx_petrichor_kb_import_job_user_kb
    ON public.petrichor_kb_import_job (user_id, knowledge_base_id);
CREATE INDEX idx_petrichor_kb_import_job_dead_letter
    ON public.petrichor_kb_import_job (dead_lettered_at DESC)
    WHERE status = 'dead_letter';
CREATE INDEX idx_petrichor_kb_import_job_page_job
    ON public.petrichor_kb_import_job_page (job_id);
CREATE INDEX idx_petrichor_kb_import_job_page_runnable
    ON public.petrichor_kb_import_job_page (next_attempt_at, job_id, page_no)
    WHERE status = 'pending' AND extracted_by = 'vision';
