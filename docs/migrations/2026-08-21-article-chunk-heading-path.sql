-- 「构建知识」分片增加完整标题路径。
-- 存量分片解析为空数组，重建后自动补全。幂等，可重复执行。
alter table petrichor_kb_article_chunk
    add column if not exists heading_path_json text not null default '[]';
