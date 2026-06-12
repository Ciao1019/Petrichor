-- 2026-06-12 移除前台 Retypeset 主题配置，保留前台公开问答开关。
-- 执行后主题由应用固定为 Sakura 樱粉，不再读取数据库日/夜主题、时段或手动覆盖配置。
-- 安全可重入：全部使用 if exists / if not exists。

create table if not exists petrichor_site_appearance (
    id integer primary key
);

alter table petrichor_site_appearance
    add column if not exists public_qa_enabled boolean not null default true;

alter table petrichor_site_appearance
    add column if not exists created_at timestamptz not null default now();

alter table petrichor_site_appearance
    add column if not exists updated_at timestamptz not null default now();

insert into petrichor_site_appearance (id, public_qa_enabled)
values (1, true)
on conflict (id) do nothing;

alter table petrichor_site_appearance
    drop column if exists day_theme,
    drop column if exists night_theme,
    drop column if exists day_start_hour,
    drop column if exists day_end_hour,
    drop column if exists allow_manual_override;
