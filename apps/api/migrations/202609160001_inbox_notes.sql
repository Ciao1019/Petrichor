-- +goose Up
-- 闪记独立于知识库保存，只有用户归档时才创建正式文章。
CREATE TABLE public.petrichor_inbox_note (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES public.petrichor_user(id) ON DELETE CASCADE,
    client_id text NOT NULL,
    content_md text NOT NULL CHECK (char_length(content_md) BETWEEN 1 AND 20000),
    tags text[] NOT NULL DEFAULT '{}',
    is_pinned boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1,
    archived_at timestamptz,
    archived_article_id bigint REFERENCES public.petrichor_kb_article(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, client_id)
);

CREATE INDEX petrichor_inbox_note_feed_idx
    ON public.petrichor_inbox_note (user_id, is_pinned DESC, created_at DESC, id DESC);
CREATE INDEX petrichor_inbox_note_tags_idx ON public.petrichor_inbox_note USING gin (tags);
CREATE INDEX petrichor_inbox_note_content_idx ON public.petrichor_inbox_note USING gin (content_md gin_trgm_ops);
