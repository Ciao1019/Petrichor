-- 全站索引点群（Site Graph）：前台 /graph 的 d3-force-3d 点群图谱数据源。
-- 不引入图数据库：
--   * 树形骨架用邻接表（petrichor_site_graph_node.parent_id 自引用）
--   * 跨树关系单独放 petrichor_site_graph_edge
--   * 子树 / N 跳邻域查询用 PostgreSQL 递归 CTE（当前实现见 apps/api/internal/sitegraph）
-- 执行顺序：可独立执行，仅依赖 petrichor_user 与 petrichor_kb_article。

create table if not exists petrichor_site_graph_node (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    node_key text not null,
    parent_id bigint references petrichor_site_graph_node(id) on delete set null,
    kind text not null,
    name text not null,
    summary text,
    route text,
    article_id bigint references petrichor_kb_article(id) on delete set null,
    attributes_json text,
    aliases_json text,
    weight integer not null default 1,
    sort_order integer not null default 0,
    status text not null default 'DRAFT',
    source text not null default 'AGENT',
    confidence integer not null default 80,
    locked boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_site_graph_node_key
    on petrichor_site_graph_node(user_id, node_key);

create index if not exists idx_petrichor_site_graph_node_parent
    on petrichor_site_graph_node(user_id, parent_id, sort_order);

create index if not exists idx_petrichor_site_graph_node_status
    on petrichor_site_graph_node(user_id, status, kind);

create index if not exists idx_petrichor_site_graph_node_article
    on petrichor_site_graph_node(article_id);

create table if not exists petrichor_site_graph_edge (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    from_node_id bigint not null references petrichor_site_graph_node(id) on delete cascade,
    to_node_id bigint not null references petrichor_site_graph_node(id) on delete cascade,
    relation text not null,
    kind text not null default 'reference',
    attributes_json text,
    weight integer not null default 1,
    directed boolean not null default true,
    status text not null default 'DRAFT',
    source text not null default 'AGENT',
    confidence integer not null default 80,
    locked boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_site_graph_edge_triple
    on petrichor_site_graph_edge(user_id, from_node_id, to_node_id, relation);

create index if not exists idx_petrichor_site_graph_edge_from
    on petrichor_site_graph_edge(user_id, from_node_id);

create index if not exists idx_petrichor_site_graph_edge_to
    on petrichor_site_graph_edge(user_id, to_node_id);

create index if not exists idx_petrichor_site_graph_edge_status
    on petrichor_site_graph_edge(user_id, status);

create table if not exists petrichor_site_graph_run (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    status text not null default 'RUNNING',
    mode text not null default 'FULL',
    model_name text,
    article_count integer not null default 0,
    node_count integer not null default 0,
    edge_count integer not null default 0,
    validation_json text,
    warnings_json text,
    error_message text,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_petrichor_site_graph_run_user
    on petrichor_site_graph_run(user_id, started_at desc);
