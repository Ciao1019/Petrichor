-- ============================================================
-- 阅后即焚链接（Burn After Reading）
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：新增与「永久分享」（petrichor_kb_article_share）完全独立的一次性 /
--      N 次访问通道。访问者需在确认页点击「确认阅读」才消耗一次次数，
--      达到 max_views 后链接自动焚毁（status='BURNED'）。
--      该表不参与公开首页 / 搜索 / RSS，也不会被公开问答索引
--      （问答只扫 petrichor_kb_article_share），无需改动既有逻辑。
-- 全部 IF NOT EXISTS，可安全重复执行，且不影响永久分享表的任何数据。
-- ============================================================

-- 阅后即焚链接表
--   max_views   = 允许访问次数上限（1 = 严格阅后即焚）
--   view_count  = 已成功阅读次数
--   status      = ACTIVE（可访问） | BURNED（达上限自动焚毁） | REVOKED（站长手动撤销）
create table if not exists petrichor_kb_article_burn_link (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    link_code text not null,
    max_views integer not null default 1,
    view_count integer not null default 0,
    password_hash text,
    expires_at timestamptz,
    status text not null default 'ACTIVE',
    burned_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (link_code)
);

-- 站长侧按文章列出其全部焚阅链接：where user_id + article_id order by created_at
create index if not exists petrichor_kb_burn_link_article_idx
    on petrichor_kb_article_burn_link(user_id, article_id, created_at);
