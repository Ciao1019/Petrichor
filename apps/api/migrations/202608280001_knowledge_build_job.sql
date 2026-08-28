-- +goose Up

CREATE TABLE public.petrichor_kb_knowledge_build_job (
    id text NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    article_id bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    result_json text,
    error text,
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
        FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_petrichor_kb_knowledge_build_job_active
    ON public.petrichor_kb_knowledge_build_job (user_id, knowledge_base_id, article_id)
    WHERE status IN ('pending', 'processing');

CREATE INDEX idx_petrichor_kb_knowledge_build_job_user
    ON public.petrichor_kb_knowledge_build_job (user_id, created_at DESC);

-- +goose Down

DROP TABLE public.petrichor_kb_knowledge_build_job;
