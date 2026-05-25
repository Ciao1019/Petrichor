create table if not exists petrichor_site_about_profile (
    id integer primary key
);

alter table petrichor_site_about_profile
    add column if not exists display_name text not null default 'CiZai';

alter table petrichor_site_about_profile
    add column if not exists role_title text not null default 'Creative Dev & Visual Artist';

alter table petrichor_site_about_profile
    add column if not exists intro text not null default $about_intro$我是 CiZai，是一个普普通通的程序员。

目前就职于金山办公

我的兴趣主要在 Coding / AI 方向。

我喜欢 Minecraft。$about_intro$;

alter table petrichor_site_about_profile
    add column if not exists expertise_json text not null default '["Frontend Architecture","AI 应用开发","Knowledge Systems","Creative Coding"]';

alter table petrichor_site_about_profile
    add column if not exists toolkit_json text not null default '["TypeScript","React","Next.js","AI","PostgreSQL","Minecraft"]';

alter table petrichor_site_about_profile
    add column if not exists quote text not null default 'Code is just another medium for painting dreams.';

alter table petrichor_site_about_profile
    add column if not exists created_at timestamptz not null default now();

alter table petrichor_site_about_profile
    add column if not exists updated_at timestamptz not null default now();

insert into petrichor_site_about_profile (
    id,
    display_name,
    role_title,
    intro,
    expertise_json,
    toolkit_json,
    quote
) values (
    1,
    'CiZai',
    'Creative Dev & Visual Artist',
    $about_intro$我是 CiZai，是一个普普通通的程序员。

目前就职于金山办公

我的兴趣主要在 Coding / AI 方向。

我喜欢 Minecraft。$about_intro$,
    '["Frontend Architecture","AI 应用开发","Knowledge Systems","Creative Coding"]',
    '["TypeScript","React","Next.js","AI","PostgreSQL","Minecraft"]',
    'Code is just another medium for painting dreams.'
) on conflict (id) do nothing;
