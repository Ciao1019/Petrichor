-- 公开文章列表/详情性能缓存字段与索引。
-- 幂等执行：只新增缺失列/索引，并对尚未回填的旧文章做非破坏性回填。
-- toc_json 需要复用应用层 Markdown slug 逻辑，执行本 SQL 后可运行：
-- pnpm --filter "@petrichor/web" db:backfill-public-article-metadata

alter table petrichor_kb_article
    add column if not exists public_excerpt text;

alter table petrichor_kb_article
    add column if not exists reading_minutes integer;

alter table petrichor_kb_article
    add column if not exists toc_json text;

alter table petrichor_kb_article
    add column if not exists public_content_hash text;

create index if not exists petrichor_kb_article_public_updated_idx
    on petrichor_kb_article(updated_at desc, id desc);

create index if not exists petrichor_kb_article_share_public_idx
    on petrichor_kb_article_share(enabled, revoked_at, article_id);

with normalized as (
    select
        id,
        nullif(
            trim(
                regexp_replace(
                    regexp_replace(
                        regexp_replace(content_md, E'```[^`]*```', ' ', 'g'),
                        E'[#>*_~`\\[\\]()!-]+',
                        ' ',
                        'g'
                    ),
                    E'\\s+',
                    ' ',
                    'g'
                )
            ),
            ''
        ) as plain_text,
        md5(content_md) as content_hash
    from petrichor_kb_article
)
update petrichor_kb_article article
set
    public_excerpt = coalesce(
        nullif(article.public_excerpt, ''),
        case
            when normalized.plain_text is null then '暂无摘要'
            when char_length(normalized.plain_text) > 120 then concat(left(normalized.plain_text, 120), '...')
            else normalized.plain_text
        end
    ),
    reading_minutes = coalesce(
        nullif(article.reading_minutes, 0),
        greatest(1, ceil(greatest(char_length(coalesce(normalized.plain_text, '')), 1)::numeric / 420)::integer)
    ),
    public_content_hash = coalesce(nullif(article.public_content_hash, ''), normalized.content_hash)
from normalized
where article.id = normalized.id
  and (
      article.public_excerpt is null
      or nullif(article.public_excerpt, '') is null
      or article.reading_minutes is null
      or article.reading_minutes <= 0
      or article.public_content_hash is null
      or nullif(article.public_content_hash, '') is null
  );
