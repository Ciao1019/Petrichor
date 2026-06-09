-- PageIndex 式文档层级树：把每篇源文档按 Markdown 标题编译成 TOC 节点，
-- 节点保存 LLM 摘要 + 原文片段 + 锚点，供「推理式检索」（LLM 在目录上导航选节点）。
-- 执行顺序：在 2026-05-19-add-kb-wiki-agent.sql 之后执行。

create table if not exists petrichor_kb_wiki_tree_node (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    page_id bigint not null references petrichor_kb_wiki_page(id) on delete cascade,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    node_key text not null,
    parent_key text,
    depth integer not null default 0,
    position integer not null default 0,
    title text not null,
    summary text,
    content_md text not null default '',
    start_line integer,
    end_line integer,
    token_estimate integer not null default 0,
    content_hash text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, knowledge_base_id, node_key)
);

create index if not exists petrichor_kb_wiki_tree_node_page_idx
    on petrichor_kb_wiki_tree_node(page_id);

create index if not exists petrichor_kb_wiki_tree_node_article_idx
    on petrichor_kb_wiki_tree_node(article_id);

create index if not exists petrichor_kb_wiki_tree_node_kb_idx
    on petrichor_kb_wiki_tree_node(user_id, knowledge_base_id, position);
