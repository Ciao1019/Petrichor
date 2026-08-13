-- Wiki 页面目录层级：把扁平的 Wiki 页面列表变成可展开折叠的文件夹树。
-- category_path_json 保存页面所属的目录链（JSON 字符串数组，例如 ["软件","命令行工具"]），
-- 空数组或 NULL 表示挂在 Wiki 根目录下；sort_order 控制同级页面排序。
-- 执行顺序：在 2026-08-12-weknora-wiki-pipeline.sql 之后执行。

alter table petrichor_kb_wiki_page
    add column if not exists category_path_json text,
    add column if not exists sort_order integer not null default 0;

create index if not exists petrichor_kb_wiki_page_tree_idx
    on petrichor_kb_wiki_page(user_id, knowledge_base_id, sort_order, title);
