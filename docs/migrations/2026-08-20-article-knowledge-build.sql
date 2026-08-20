-- 文章“构建知识”平铺切片：每个 Markdown 切片持久化恰好 3 个推荐问题。
-- 幂等，可重复执行；不删除或改写旧 Wiki / 问答数据。

create table if not exists petrichor_kb_article_chunk (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    chunk_key text not null,
    position integer not null default 0,
    heading text not null,
    content_md text not null,
    content_hash text not null,
    recommended_questions_json text not null default '[]',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_kb_article_chunk_key
    on petrichor_kb_article_chunk(user_id, article_id, chunk_key);

create index if not exists idx_petrichor_kb_article_chunk_article
    on petrichor_kb_article_chunk(user_id, knowledge_base_id, article_id, position);

-- 回滚（确认不再需要新构建数据后再执行）：
-- drop table if exists petrichor_kb_article_chunk;
