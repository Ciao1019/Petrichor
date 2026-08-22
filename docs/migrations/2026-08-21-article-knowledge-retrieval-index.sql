-- 新版文章知识检索索引：原始分片与每个推荐问题分别向量化，但统一指回原分片。
-- Wiki 页面继续保存在 petrichor_kb_wiki_page，由独立的页面检索承担概念导航。
-- 幂等，可重复执行；不会删除旧 Wiki Tree 向量。

create table if not exists petrichor_kb_article_chunk_index (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    chunk_id bigint not null references petrichor_kb_article_chunk(id) on delete cascade,
    source_key text not null,
    source_type text not null check (source_type in ('chunk', 'question')),
    source_position integer not null default 0,
    content text not null,
    embedding_text text not null,
    content_hash text not null,
    search_tokens text not null default '',
    embedding_status text not null default 'pending',
    embedding_model text,
    embedding_dimensions integer,
    embedding_version integer not null default 1,
    embedding_error text,
    embedding_updated_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_kb_article_chunk_index_source
    on petrichor_kb_article_chunk_index(user_id, article_id, source_key);

create index if not exists idx_petrichor_kb_article_chunk_index_scope
    on petrichor_kb_article_chunk_index(user_id, knowledge_base_id, source_type, article_id);

create index if not exists idx_petrichor_kb_article_chunk_index_chunk
    on petrichor_kb_article_chunk_index(chunk_id, source_type, source_position);

alter table petrichor_kb_article_chunk_index
    add column if not exists embedding vector;

-- 中文按应用层 2 字 n-gram 写入 search_tokens，Postgres 只负责 GIN 候选池。
alter table petrichor_kb_article_chunk_index
    add column if not exists search_vector tsvector
    generated always as (to_tsvector('simple', coalesce(search_tokens, ''))) stored;

-- 把已经由“构建知识”生成的存量分片原地升级，不要求重新调用模型。
-- 该临时函数与应用侧 tokenize.ts 保持核心口径：中文 bigram、英文数字按词。
create or replace function petrichor_article_retrieval_tokens(input_text text)
returns text
language plpgsql
immutable
as $$
declare
    normalized text := lower(coalesce(input_text, ''));
    matched text;
    token_text text := '';
    token_index integer;
begin
    for matched in
        select (regexp_matches(normalized, '[㐀-䶿一-鿿豈-﫿]+', 'g'))[1]
    loop
        if char_length(matched) = 1 then
            token_text := token_text || ' ' || matched;
        elsif char_length(matched) > 1 then
            for token_index in 1..(char_length(matched) - 1) loop
                token_text := token_text || ' ' || substr(matched, token_index, 2);
            end loop;
        end if;
    end loop;

    for matched in
        select (regexp_matches(normalized, '[a-z0-9][a-z0-9._-]+', 'g'))[1]
    loop
        token_text := token_text || ' ' || matched;
    end loop;

    return left(trim(token_text), 64000);
end;
$$;

insert into petrichor_kb_article_chunk_index (
    user_id, knowledge_base_id, article_id, chunk_id,
    source_key, source_type, source_position, content,
    embedding_text, content_hash, search_tokens,
    embedding_status, embedding_version, updated_at
)
select
    c.user_id,
    c.knowledge_base_id,
    c.article_id,
    c.id,
    c.chunk_key || ':chunk',
    'chunk',
    0,
    c.content_md,
    concat_ws(E'\n', a.title, c.heading, c.content_md),
    md5(concat_ws(E'\n', a.title, c.heading, c.content_md)),
    petrichor_article_retrieval_tokens(concat_ws(E'\n', a.title, c.heading, c.content_md)),
    'pending',
    1,
    now()
from petrichor_kb_article_chunk c
join petrichor_kb_article a on a.id = c.article_id
on conflict (user_id, article_id, source_key) do nothing;

insert into petrichor_kb_article_chunk_index (
    user_id, knowledge_base_id, article_id, chunk_id,
    source_key, source_type, source_position, content,
    embedding_text, content_hash, search_tokens,
    embedding_status, embedding_version, updated_at
)
select
    c.user_id,
    c.knowledge_base_id,
    c.article_id,
    c.id,
    c.chunk_key || ':question:' || (question.ordinality - 1)::text,
    'question',
    (question.ordinality - 1)::integer,
    question.content,
    concat_ws(E'\n', a.title, c.heading, question.content),
    md5(concat_ws(E'\n', a.title, c.heading, question.content)),
    petrichor_article_retrieval_tokens(concat_ws(E'\n', a.title, c.heading, question.content)),
    'pending',
    1,
    now()
from petrichor_kb_article_chunk c
join petrichor_kb_article a on a.id = c.article_id
cross join lateral jsonb_array_elements_text(c.recommended_questions_json::jsonb)
    with ordinality as question(content, ordinality)
where trim(question.content) <> ''
on conflict (user_id, article_id, source_key) do nothing;

drop function petrichor_article_retrieval_tokens(text);

create index if not exists petrichor_kb_article_chunk_index_search_idx
    on petrichor_kb_article_chunk_index using gin (search_vector);

-- embedding 是无约束 vector；HNSW 按实际模型维度由 vector-space.ts 动态创建。
alter table petrichor_kb_article_chunk_index alter column embedding type vector;

-- 回滚（会删除新检索索引，原文章分片和 Wiki 页面不受影响）：
-- drop table if exists petrichor_kb_article_chunk_index;
