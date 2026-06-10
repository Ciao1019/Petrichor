-- ============================================================
-- 前台公开问答（Public Q&A）
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：让未登录访客也能在前台 /ask 页面问答，范围仅限公开（已分享）文章；
--      流式与 wiki 检索能力复用后台问答。新增两项：
--      1) 站点外观配置新增 public_qa_enabled 开关（默认开启，站长可关）；
--      2) 公开问答限流计数桶表（visitor-id 主键 10 次/小时 + IP 兜底 60 次/小时）。
-- 全部 IF NOT EXISTS，可安全重复执行。
-- ============================================================

-- 1) 后台开关：前台问答启用开关（默认开启）
alter table petrichor_site_appearance
    add column if not exists public_qa_enabled boolean not null default true;

-- 2) 公开问答限流计数桶（固定窗口，按小时）
--    bucket_key 形如 visitor:<id>:<yyyyMMddHH> 或 ip:<ip>:<yyyyMMddHH>
create table if not exists petrichor_public_qa_rate_limit (
    id bigint generated always as identity primary key,
    bucket_key text not null,
    count integer not null default 0,
    window_started_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_public_qa_rate_limit_bucket
    on petrichor_public_qa_rate_limit(bucket_key);
