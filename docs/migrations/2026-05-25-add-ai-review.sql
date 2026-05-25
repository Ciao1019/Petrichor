-- 2026-05-25 新增 AI 回顾（周报/月报）功能
-- 安全可重入：使用 if not exists / on conflict do nothing
create table if not exists petrichor_ai_review (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    period text not null,
    period_key text not null,
    period_start timestamptz not null,
    period_end timestamptz not null,
    stats_json text not null,
    narrative text not null,
    model_config_id bigint,
    regenerate_count integer not null default 0,
    last_regenerated_at timestamptz,
    generated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_ai_review_user_period
    on petrichor_ai_review (user_id, period, period_key);

create index if not exists idx_petrichor_ai_review_user_generated
    on petrichor_ai_review (user_id, generated_at);
