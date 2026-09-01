-- +goose Up

-- 知识构建任务：显式重试调度、租约心跳和死信元数据。
ALTER TABLE public.petrichor_kb_knowledge_build_job
    ADD COLUMN attempt_count integer DEFAULT 0 NOT NULL,
    ADD COLUMN max_attempts integer DEFAULT 5 NOT NULL,
    ADD COLUMN next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN last_error text,
    ADD COLUMN lease_owner text,
    ADD COLUMN lease_expires_at timestamp with time zone,
    ADD COLUMN heartbeat_at timestamp with time zone,
    ADD COLUMN dead_lettered_at timestamp with time zone,
    ADD COLUMN replay_count integer DEFAULT 0 NOT NULL;

ALTER TABLE public.petrichor_kb_knowledge_build_job
    ADD CONSTRAINT petrichor_kb_knowledge_build_job_attempts_check
        CHECK (attempt_count >= 0 AND max_attempts > 0 AND replay_count >= 0);

-- 升级时正在执行的旧任务没有租约，立即交还队列，由新 Worker 安全领取。
UPDATE public.petrichor_kb_knowledge_build_job
SET status = 'pending', next_attempt_at = now(), updated_at = now()
WHERE status = 'processing';

CREATE INDEX idx_petrichor_kb_knowledge_build_job_runnable
    ON public.petrichor_kb_knowledge_build_job (next_attempt_at, created_at)
    WHERE status = 'pending';

CREATE INDEX idx_petrichor_kb_knowledge_build_job_dead_letter
    ON public.petrichor_kb_knowledge_build_job (dead_lettered_at DESC)
    WHERE status = 'dead_letter';

-- 视觉导入以任务租约防止失联 Worker 长期占用，并以页为粒度指数退避。
ALTER TABLE public.petrichor_kb_import_job
    ADD COLUMN lease_owner text,
    ADD COLUMN lease_expires_at timestamp with time zone,
    ADD COLUMN heartbeat_at timestamp with time zone,
    ADD COLUMN dead_lettered_at timestamp with time zone,
    ADD COLUMN replay_count integer DEFAULT 0 NOT NULL;

ALTER TABLE public.petrichor_kb_import_job
    ADD CONSTRAINT petrichor_kb_import_job_replay_count_check CHECK (replay_count >= 0);

ALTER TABLE public.petrichor_kb_import_job_page
    ADD COLUMN attempt_count integer DEFAULT 0 NOT NULL,
    ADD COLUMN max_attempts integer DEFAULT 5 NOT NULL,
    ADD COLUMN next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN last_error text,
    ADD COLUMN dead_lettered_at timestamp with time zone;

ALTER TABLE public.petrichor_kb_import_job_page
    ADD CONSTRAINT petrichor_kb_import_job_page_attempts_check
        CHECK (attempt_count >= 0 AND max_attempts > 0);

CREATE INDEX idx_petrichor_kb_import_job_page_runnable
    ON public.petrichor_kb_import_job_page (next_attempt_at, job_id, page_no)
    WHERE status = 'pending' AND extracted_by = 'vision';

CREATE INDEX idx_petrichor_kb_import_job_dead_letter
    ON public.petrichor_kb_import_job (dead_lettered_at DESC)
    WHERE status = 'dead_letter';

-- +goose Down

DROP INDEX public.idx_petrichor_kb_import_job_dead_letter;
DROP INDEX public.idx_petrichor_kb_import_job_page_runnable;
ALTER TABLE public.petrichor_kb_import_job_page
    DROP CONSTRAINT petrichor_kb_import_job_page_attempts_check,
    DROP COLUMN dead_lettered_at,
    DROP COLUMN last_error,
    DROP COLUMN next_attempt_at,
    DROP COLUMN max_attempts,
    DROP COLUMN attempt_count;
ALTER TABLE public.petrichor_kb_import_job
    DROP CONSTRAINT petrichor_kb_import_job_replay_count_check,
    DROP COLUMN replay_count,
    DROP COLUMN dead_lettered_at,
    DROP COLUMN heartbeat_at,
    DROP COLUMN lease_expires_at,
    DROP COLUMN lease_owner;
DROP INDEX public.idx_petrichor_kb_knowledge_build_job_dead_letter;
DROP INDEX public.idx_petrichor_kb_knowledge_build_job_runnable;
ALTER TABLE public.petrichor_kb_knowledge_build_job
    DROP CONSTRAINT petrichor_kb_knowledge_build_job_attempts_check,
    DROP COLUMN replay_count,
    DROP COLUMN dead_lettered_at,
    DROP COLUMN heartbeat_at,
    DROP COLUMN lease_expires_at,
    DROP COLUMN lease_owner,
    DROP COLUMN last_error,
    DROP COLUMN next_attempt_at,
    DROP COLUMN max_attempts,
    DROP COLUMN attempt_count;
