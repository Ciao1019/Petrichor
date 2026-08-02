-- 站点图谱实体对齐：待确认的合并候选。
-- 精确对齐（名称/别名规范化后一致）在抽取阶段直接合并，不入本表；
-- 只有「名称相近但不确定同一实体」的对子才落库，等后台人工确认或忽略。
-- 执行顺序：在 2026-08-02-add-site-graph.sql 之后执行。

create table if not exists petrichor_site_graph_merge_candidate (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    source_key text not null,
    target_key text not null,
    reason text not null,
    score integer not null default 0,
    detail text,
    status text not null default 'PENDING',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_site_graph_merge_candidate_pair
    on petrichor_site_graph_merge_candidate(user_id, source_key, target_key);

create index if not exists idx_petrichor_site_graph_merge_candidate_status
    on petrichor_site_graph_merge_candidate(user_id, status, score desc);
