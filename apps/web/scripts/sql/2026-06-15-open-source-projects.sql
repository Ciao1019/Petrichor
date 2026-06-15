-- ============================================================
-- 开源项目展示页（Open Source Projects）—— 站长本人的项目数据
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：建表（若不存在）并以 UPSERT 写入站长的真实项目清单。
--      该表为站点单例（id=1），后台「系统管理 → 开源项目」可编辑。
--      ⚠️ 末尾用 ON CONFLICT DO UPDATE：会覆盖 id=1 现有内容。
--         首次安装请放心执行；若之后在后台改过项目，再次执行会被这份覆盖。
-- 建表部分全部 IF NOT EXISTS，可安全重复执行。
-- ============================================================

create table if not exists petrichor_site_project_showcase (
    id integer primary key,
    heading text not null default '开源项目',
    intro text not null default '',
    items_json text not null default '[]',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table petrichor_site_project_showcase
    add column if not exists heading text not null default '开源项目';
alter table petrichor_site_project_showcase
    add column if not exists intro text not null default '';
alter table petrichor_site_project_showcase
    add column if not exists items_json text not null default '[]';

-- 写入 / 覆盖站长的项目清单
insert into petrichor_site_project_showcase (id, heading, intro, items_json, updated_at)
values (
    1,
    'Open Source',
    'things I build, and a few I help keep alive.',
    $proj_items$[{"name":"Petrichor — 自托管知识库 / 博客","year":"2026","stack":["TypeScript"],"stamp":"this site","stampColor":"red","blurb":"自托管的知识库与博客平台：Markdown 写作、知识 Wiki、公开问答、阅后即焚分享 —— 也就是你正在看的这个站点。","repoUrl":"https://github.com/Ciao1019/Petrichor","siteUrl":"https://wl.do"},{"name":"forge — AI 编程助手的终端启动器","year":"2026","stack":["Rust"],"stamp":"new","stampColor":"blue","blurb":"面向 AI 编程助手（Claude Code、Codex 等）的终端启动器：在指定根目录下快速切换项目，并自动执行预设的启动命令。","repoUrl":"https://github.com/Ciao1019/forge","siteUrl":""},{"name":"AgentX — 自然语言打造你的 Agent","year":"2025","stack":["Java"],"stamp":"popular","stampColor":"green","blurb":"让小白也能无门槛用自然语言打造属于自己的 Agent：自研 MCP 网关 + 模型高可用组件，构建高可用的 Agent 平台。","repoUrl":"https://github.com/lucky-aeon/AgentX","siteUrl":""},{"name":"easy-es — Elasticsearch ORM 框架","year":"2021","stack":["Java","Elasticsearch"],"stamp":"popular","stampColor":"orange","blurb":"上手零门槛的 Elasticsearch ORM 框架：像 MyBatis-Plus 一样写 ES 查询，少写代码、易扩展。Dromara 开源社区出品。","repoUrl":"https://github.com/dromara/easy-es","siteUrl":""}]$proj_items$,
    now()
)
on conflict (id) do update set
    heading = excluded.heading,
    intro = excluded.intro,
    items_json = excluded.items_json,
    updated_at = now();
