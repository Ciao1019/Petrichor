-- 2026-05-25 新增站点外观配置（前台 Retypeset 主题日/夜方案与时段）
-- 安全可重入：使用 if not exists / on conflict do nothing
create table if not exists petrichor_site_appearance (
    id integer primary key
);

alter table petrichor_site_appearance
    add column if not exists day_theme text not null default 'paper';

alter table petrichor_site_appearance
    add column if not exists night_theme text not null default 'slate';

alter table petrichor_site_appearance
    add column if not exists day_start_hour integer not null default 6;

alter table petrichor_site_appearance
    add column if not exists day_end_hour integer not null default 18;

alter table petrichor_site_appearance
    add column if not exists allow_manual_override boolean not null default true;

alter table petrichor_site_appearance
    add column if not exists created_at timestamptz not null default now();

alter table petrichor_site_appearance
    add column if not exists updated_at timestamptz not null default now();

insert into petrichor_site_appearance (
    id,
    day_theme,
    night_theme,
    day_start_hour,
    day_end_hour,
    allow_manual_override
) values (
    1,
    'paper',
    'slate',
    6,
    18,
    true
) on conflict (id) do nothing;
