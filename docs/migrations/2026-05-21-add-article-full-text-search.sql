-- 增量迁移：公开博客文章全文搜索（pg_trgm 中文友好）。
-- 背景：博客原仅按标签筛选，新增 /search 实时搜索（debounce 300ms），
-- 用 pg_trgm 的 similarity() 做相关度排序、gin_trgm_ops 索引加速 ILIKE。
-- 选 pg_trgm 而非 tsvector('simple') 的原因：内容以中文为主，simple 字典几乎不分词，
-- trigram 子串匹配对中文体验更好。
-- 幂等：CREATE EXTENSION IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_petrichor_kb_article_title_trgm
    ON petrichor_kb_article
    USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_petrichor_kb_article_public_excerpt_trgm
    ON petrichor_kb_article
    USING gin (public_excerpt gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_petrichor_kb_article_content_md_trgm
    ON petrichor_kb_article
    USING gin (content_md gin_trgm_ops);
