alter table petrichor_kb_article_share
    add column if not exists is_repost boolean not null default false,
    add column if not exists original_url text,
    add column if not exists original_author_name text;
