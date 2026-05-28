const BUSINESS_SCHEMA_SQL = `
create table if not exists petrichor_user (
    id bigint generated always as identity primary key,
    auth_user_id text,
    email text not null,
    password_hash text not null,
    system_role text not null default 'USER',
    user_type text not null default 'LOCAL',
    linuxdo_account_id text,
    linuxdo_username text,
    linuxdo_email text,
    username text,
    nickname text,
    avatar text,
    signature text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (email)
);

alter table petrichor_user
    add column if not exists auth_user_id text;

alter table petrichor_user
    add column if not exists linuxdo_account_id text,
    add column if not exists linuxdo_username text,
    add column if not exists linuxdo_email text;

create unique index if not exists ux_petrichor_user_auth_user_id
    on petrichor_user(auth_user_id)
    where auth_user_id is not null;

create unique index if not exists ux_petrichor_user_linuxdo_account_id
    on petrichor_user(linuxdo_account_id)
    where linuxdo_account_id is not null;

create table if not exists better_auth_user (
    id text primary key,
    name text not null,
    email text not null unique,
    email_verified boolean not null default false,
    image text,
    two_factor_enabled boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table better_auth_user
    add column if not exists two_factor_enabled boolean not null default false;

create table if not exists better_auth_two_factor (
    id text primary key,
    secret text not null,
    backup_codes text not null,
    verified boolean not null default true,
    user_id text not null references better_auth_user(id) on delete cascade
);

create index if not exists idx_better_auth_two_factor_user_id
    on better_auth_two_factor(user_id);

create index if not exists idx_better_auth_two_factor_secret
    on better_auth_two_factor(secret);

create table if not exists better_auth_session (
    id text primary key,
    expires_at timestamptz not null,
    token text not null unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    ip_address text,
    user_agent text,
    user_id text not null references better_auth_user(id) on delete cascade
);

create index if not exists idx_better_auth_session_user_id
    on better_auth_session(user_id);

create index if not exists idx_better_auth_session_expires_at
    on better_auth_session(expires_at);

create table if not exists better_auth_account (
    id text primary key,
    account_id text not null,
    provider_id text not null,
    user_id text not null references better_auth_user(id) on delete cascade,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    password text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_better_auth_account_provider_account
    on better_auth_account(provider_id, account_id);

create index if not exists idx_better_auth_account_user_id
    on better_auth_account(user_id);

create table if not exists better_auth_verification (
    id text primary key,
    identifier text not null,
    value text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_better_auth_verification_identifier
    on better_auth_verification(identifier);

insert into better_auth_user (id, name, email, email_verified, image, created_at, updated_at)
select
    'petrichor_' || u.id::text,
    coalesce(nullif(u.nickname, ''), nullif(u.username, ''), u.email),
    lower(u.email),
    true,
    u.avatar,
    u.created_at,
    u.updated_at
from petrichor_user u
where nullif(u.auth_user_id, '') is null
on conflict (email) do nothing;

update petrichor_user u
set auth_user_id = au.id
from better_auth_user au
where lower(au.email) = lower(u.email)
  and nullif(u.auth_user_id, '') is null;

insert into better_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
select
    'credential_' || u.id::text,
    u.auth_user_id,
    'credential',
    u.auth_user_id,
    nullif(u.password_hash, ''),
    u.created_at,
    u.updated_at
from petrichor_user u
where u.auth_user_id is not null
  and nullif(u.password_hash, '') is not null
on conflict (provider_id, account_id) do update
set password = excluded.password,
    updated_at = now();

create table if not exists petrichor_auth_session (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    token_hash text not null unique,
    device_info text,
    ip text,
    user_agent text,
    expires_at timestamptz not null,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_auth_session_user_id_idx
    on petrichor_auth_session(user_id);

create index if not exists petrichor_auth_session_expires_at_idx
    on petrichor_auth_session(expires_at);

create table if not exists petrichor_notification (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    category text not null,
    biz_type text not null,
    biz_id bigint not null,
    title text not null,
    content text not null,
    payload_json text,
    read_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_notification_user_read_idx
    on petrichor_notification(user_id, read_at);

create index if not exists petrichor_notification_user_created_idx
    on petrichor_notification(user_id, created_at desc, id desc);

create index if not exists petrichor_notification_user_category_idx
    on petrichor_notification(user_id, category);

create index if not exists petrichor_notification_biz_idx
    on petrichor_notification(user_id, biz_type, biz_id);

create table if not exists petrichor_kb_knowledge_base (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    name text not null,
    description text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_kb_knowledge_base_user_id_idx
    on petrichor_kb_knowledge_base(user_id);

-- 知识库列表按 user_id 过滤、updated_at 排序
create index if not exists petrichor_kb_knowledge_base_user_updated_idx
    on petrichor_kb_knowledge_base(user_id, updated_at desc);

create table if not exists petrichor_kb_node (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    parent_id bigint references petrichor_kb_node(id) on delete cascade,
    type text not null,
    name text not null,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_kb_node_kb_parent_order_idx
    on petrichor_kb_node(knowledge_base_id, parent_id, sort_order);

-- 知识库树加载：按 user_id + knowledge_base_id 过滤并按 sort_order/id 排序
create index if not exists petrichor_kb_node_user_kb_order_idx
    on petrichor_kb_node(user_id, knowledge_base_id, sort_order, id);

create table if not exists petrichor_kb_article (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    node_id bigint not null references petrichor_kb_node(id) on delete cascade,
    title text not null,
    content_md text not null,
    content_json text,
    content_meta_json text,
    public_excerpt text,
    reading_minutes integer,
    toc_json text,
    public_content_hash text,
    ai_summary text,
    ai_summary_content_hash text,
    ai_summary_generated_at timestamptz,
    mindmap_json text,
    mindmap_content_hash text,
    mindmap_generated_at timestamptz,
    mindmap_kg_json text,
    mindmap_kg_content_hash text,
    mindmap_kg_generated_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (node_id)
);

create index if not exists petrichor_kb_article_kb_updated_idx
    on petrichor_kb_article(knowledge_base_id, updated_at desc);

create index if not exists petrichor_kb_article_public_updated_idx
    on petrichor_kb_article(updated_at desc, id desc);

-- 文章按 user_id + knowledge_base_id 过滤（列表、按库删除、内容分布统计）
create index if not exists petrichor_kb_article_user_kb_idx
    on petrichor_kb_article(user_id, knowledge_base_id);

-- 首页文章热力图/趋势：按 user_id 过滤、created_at 时间范围聚合
create index if not exists petrichor_kb_article_user_created_idx
    on petrichor_kb_article(user_id, created_at desc);

alter table petrichor_kb_article
    add column if not exists ai_summary text,
    add column if not exists ai_summary_content_hash text,
    add column if not exists ai_summary_generated_at timestamptz;

create table if not exists petrichor_kb_article_tag (
    id bigint generated always as identity primary key,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    tag text not null,
    created_at timestamptz not null default now(),
    unique (article_id, tag)
);

create index if not exists petrichor_kb_article_tag_article_idx
    on petrichor_kb_article_tag(article_id);

create table if not exists petrichor_kb_article_share (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    share_code text not null,
    enabled boolean not null default true,
    expires_at timestamptz,
    password_hash text,
    is_repost boolean not null default false,
    original_url text,
    original_author_name text,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (article_id),
    unique (share_code)
);

alter table petrichor_kb_article_share
    add column if not exists is_repost boolean not null default false,
    add column if not exists original_url text,
    add column if not exists original_author_name text,
    add column if not exists pin_order integer;

create index if not exists petrichor_kb_article_share_user_id_idx
    on petrichor_kb_article_share(user_id);

create index if not exists petrichor_kb_article_share_public_idx
    on petrichor_kb_article_share(enabled, revoked_at, article_id);

create index if not exists petrichor_kb_article_share_pin_idx
    on petrichor_kb_article_share(pin_order);

create table if not exists petrichor_kb_wiki_page (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    page_key text not null,
    title text not null,
    kind text not null,
    content_md text not null,
    frontmatter_json text,
    summary text,
    content_hash text not null,
    version integer not null default 1,
    archived_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, knowledge_base_id, page_key)
);

create index if not exists petrichor_kb_wiki_page_kb_kind_idx
    on petrichor_kb_wiki_page(user_id, knowledge_base_id, kind);

create index if not exists petrichor_kb_wiki_page_updated_idx
    on petrichor_kb_wiki_page(user_id, knowledge_base_id, updated_at desc);

create table if not exists petrichor_kb_wiki_link (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    from_page_id bigint not null references petrichor_kb_wiki_page(id) on delete cascade,
    to_page_key text not null,
    link_type text not null default 'related',
    created_at timestamptz not null default now()
);

create index if not exists petrichor_kb_wiki_link_from_idx
    on petrichor_kb_wiki_link(from_page_id);

create index if not exists petrichor_kb_wiki_link_to_idx
    on petrichor_kb_wiki_link(user_id, knowledge_base_id, to_page_key);

create table if not exists petrichor_kb_wiki_source_ref (
    id bigint generated always as identity primary key,
    page_id bigint not null references petrichor_kb_wiki_page(id) on delete cascade,
    article_id bigint not null references petrichor_kb_article(id) on delete cascade,
    anchor text,
    quote_hash text,
    note text,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_kb_wiki_source_ref_page_idx
    on petrichor_kb_wiki_source_ref(page_id);

create index if not exists petrichor_kb_wiki_source_ref_article_idx
    on petrichor_kb_wiki_source_ref(article_id);

create table if not exists petrichor_kb_wiki_patch (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    thread_id bigint,
    run_id bigint,
    page_key text not null,
    title text not null,
    operation text not null,
    status text not null default 'PENDING',
    before_content_md text,
    proposed_content_md text not null,
    diff_text text not null,
    reason text,
    applied_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_kb_wiki_patch_status_idx
    on petrichor_kb_wiki_patch(user_id, knowledge_base_id, status);

create index if not exists petrichor_kb_wiki_patch_thread_idx
    on petrichor_kb_wiki_patch(thread_id);

create table if not exists petrichor_kb_agent_thread (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint references petrichor_kb_knowledge_base(id) on delete cascade,
    title text not null,
    status text not null default 'ACTIVE',
    last_message_at timestamptz,
    metadata_json text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table petrichor_kb_agent_thread
    alter column knowledge_base_id drop not null;

create index if not exists petrichor_kb_agent_thread_kb_idx
    on petrichor_kb_agent_thread(user_id, knowledge_base_id, updated_at desc);

create index if not exists petrichor_kb_agent_thread_user_idx
    on petrichor_kb_agent_thread(user_id, updated_at desc);

-- 历史对话列表：全部范围按 user_id 过滤并按 updated_at/id 倒序分页
create index if not exists petrichor_kb_agent_thread_user_history_idx
    on petrichor_kb_agent_thread(user_id, updated_at desc, id desc);

-- 历史对话列表：知识库/跨库范围按 user_id + knowledge_base_id 过滤并稳定分页
create index if not exists petrichor_kb_agent_thread_scope_history_idx
    on petrichor_kb_agent_thread(user_id, knowledge_base_id, updated_at desc, id desc);

-- 首页问答趋势：按 user_id 过滤、created_at 时间范围聚合
create index if not exists petrichor_kb_agent_thread_user_created_idx
    on petrichor_kb_agent_thread(user_id, created_at desc);

create table if not exists petrichor_kb_agent_message (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_kb_agent_thread(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint references petrichor_kb_knowledge_base(id) on delete cascade,
    role text not null,
    content_text text not null default '',
    content_json text,
    metadata_json text,
    created_at timestamptz not null default now()
);

alter table petrichor_kb_agent_message
    alter column knowledge_base_id drop not null;

create index if not exists petrichor_kb_agent_message_thread_idx
    on petrichor_kb_agent_message(thread_id, created_at);

-- 历史对话详情：按 thread_id 拉取消息，并用 id 稳定同时间戳下的顺序
create index if not exists petrichor_kb_agent_message_thread_order_idx
    on petrichor_kb_agent_message(thread_id, created_at, id);

create table if not exists petrichor_kb_agent_run (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_kb_agent_thread(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint references petrichor_kb_knowledge_base(id) on delete cascade,
    status text not null default 'RUNNING',
    model_name text,
    error_message text,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    created_at timestamptz not null default now()
);

alter table petrichor_kb_agent_run
    alter column knowledge_base_id drop not null;

create index if not exists petrichor_kb_agent_run_thread_idx
    on petrichor_kb_agent_run(thread_id, created_at);

create table if not exists petrichor_kb_agent_step (
    id bigint generated always as identity primary key,
    run_id bigint not null references petrichor_kb_agent_run(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint references petrichor_kb_knowledge_base(id) on delete cascade,
    step_type text not null,
    title text not null,
    status text not null,
    payload_json text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now()
);

alter table petrichor_kb_agent_step
    alter column knowledge_base_id drop not null;

create index if not exists petrichor_kb_agent_step_run_idx
    on petrichor_kb_agent_step(run_id, created_at);

create table if not exists petrichor_kb_agent_artifact (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_kb_agent_thread(id) on delete cascade,
    run_id bigint references petrichor_kb_agent_run(id) on delete set null,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint references petrichor_kb_knowledge_base(id) on delete cascade,
    artifact_type text not null,
    title text not null,
    payload_json text,
    content_md text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table petrichor_kb_agent_artifact
    alter column knowledge_base_id drop not null;

create index if not exists petrichor_kb_agent_artifact_thread_idx
    on petrichor_kb_agent_artifact(thread_id, updated_at desc);

create index if not exists petrichor_kb_agent_artifact_kb_idx
    on petrichor_kb_agent_artifact(user_id, knowledge_base_id, artifact_type);

create table if not exists petrichor_kb_wiki_event_log (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    event_type text not null,
    page_id bigint references petrichor_kb_wiki_page(id) on delete set null,
    thread_id bigint references petrichor_kb_agent_thread(id) on delete set null,
    payload_json text,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_kb_wiki_event_log_kb_idx
    on petrichor_kb_wiki_event_log(user_id, knowledge_base_id, created_at desc);

create table if not exists petrichor_agent_api_key (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    name text not null,
    key_hash text not null,
    key_prefix text not null,
    scopes_json text not null default '[]',
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_agent_api_key_hash
    on petrichor_agent_api_key(key_hash);

create index if not exists idx_petrichor_agent_api_key_user
    on petrichor_agent_api_key(user_id, revoked_at, created_at desc);

create table if not exists petrichor_agent_call_log (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    api_key_id bigint not null references petrichor_agent_api_key(id) on delete cascade,
    api_key_prefix text not null,
    agent_source text not null,
    agent_tool text,
    method text not null,
    path text not null,
    ip text,
    user_agent text,
    request_json text,
    response_json text,
    status_code integer not null,
    duration_ms integer not null,
    error_message text,
    created_at timestamptz not null default now()
);

create index if not exists idx_petrichor_agent_call_log_user_created
    on petrichor_agent_call_log(user_id, created_at desc);

create index if not exists idx_petrichor_agent_call_log_key_created
    on petrichor_agent_call_log(api_key_id, created_at desc);

create index if not exists idx_petrichor_agent_call_log_source_created
    on petrichor_agent_call_log(user_id, agent_source, created_at desc);

create table if not exists petrichor_site_about_profile (
    id integer primary key,
    display_name text not null default 'CiZai',
    role_title text not null default 'Creative Dev & Visual Artist',
    intro text not null default $about_intro$我是 CiZai，是一个普普通通的程序员。

目前就职于金山办公

我的兴趣主要在 Coding / AI 方向。

我喜欢 Minecraft。$about_intro$,
    expertise_json text not null default '["Frontend Architecture","AI 应用开发","Knowledge Systems","Creative Coding"]',
    toolkit_json text not null default '["TypeScript","React","Next.js","AI","PostgreSQL","Minecraft"]',
    quote text not null default 'Code is just another medium for painting dreams.',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

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

create table if not exists petrichor_site_appearance (
    id integer primary key,
    day_theme text not null default 'paper',
    night_theme text not null default 'slate',
    day_start_hour integer not null default 6,
    day_end_hour integer not null default 18,
    allow_manual_override boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

insert into petrichor_site_appearance (id, day_theme, night_theme, day_start_hour, day_end_hour, allow_manual_override)
values (1, 'paper', 'slate', 6, 18, true)
on conflict (id) do nothing;

create table if not exists petrichor_ai_model_config (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    config_type text not null,
    protocol text not null,
    name text not null,
    base_url text,
    api_key_enc text,
    model text not null,
    enabled boolean not null default true,
    is_default boolean not null default false,
    extra_json text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, config_type, name)
);

create index if not exists petrichor_ai_model_config_user_type_idx
    on petrichor_ai_model_config(user_id, config_type);

create unique index if not exists petrichor_ai_model_config_default_idx
    on petrichor_ai_model_config(user_id, config_type)
    where is_default = true;

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
    on petrichor_ai_review(user_id, period, period_key);

create index if not exists idx_petrichor_ai_review_user_generated
    on petrichor_ai_review(user_id, generated_at);
`;

export function buildInitialMigrationSql(): string {
    return BUSINESS_SCHEMA_SQL.trim();
}
