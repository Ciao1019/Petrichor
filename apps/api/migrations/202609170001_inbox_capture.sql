-- +goose Up
-- 网页采集任务与不可变来源快照；原文不受随笔 20000 字限制。
CREATE TABLE public.petrichor_inbox_capture (
 id text PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES public.petrichor_user(id) ON DELETE CASCADE,
 client_id text NOT NULL,
 url text NOT NULL,
 options jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','scraping','processing','ready','partial','failed','cancelled')),
 title text NOT NULL DEFAULT '',
 result jsonb,
 error text NOT NULL DEFAULT '',
 previous_id text REFERENCES public.petrichor_inbox_capture(id) ON DELETE SET NULL,
 lease_until timestamptz,
 attempt integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,client_id),
 UNIQUE(user_id,id)
);
CREATE INDEX inbox_capture_user_feed ON public.petrichor_inbox_capture(user_id,created_at DESC);
CREATE INDEX inbox_capture_url ON public.petrichor_inbox_capture(user_id,url,created_at DESC);
CREATE INDEX inbox_capture_pending ON public.petrichor_inbox_capture(state,lease_until);
CREATE TABLE public.petrichor_inbox_capture_source (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES public.petrichor_user(id) ON DELETE CASCADE,
 capture_id text NOT NULL,
 note_id bigint REFERENCES public.petrichor_inbox_note(id) ON DELETE SET NULL,
 article_id bigint REFERENCES public.petrichor_kb_article(id) ON DELETE SET NULL,
 FOREIGN KEY(user_id,capture_id) REFERENCES public.petrichor_inbox_capture(user_id,id) ON DELETE CASCADE,
 UNIQUE(note_id,capture_id)
);
CREATE INDEX inbox_capture_source_article ON public.petrichor_inbox_capture_source(article_id);
