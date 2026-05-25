-- 新增文档问答 Agent 的 Wiki 编译层、运行轨迹、补丁审批和产物持久化对象。
-- 执行顺序：在 2026-05-19-rename-dosphere-to-petrichor.sql 之后执行。

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
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    title text not null,
    status text not null default 'ACTIVE',
    last_message_at timestamptz,
    metadata_json text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_kb_agent_thread_kb_idx
    on petrichor_kb_agent_thread(user_id, knowledge_base_id, updated_at desc);

create table if not exists petrichor_kb_agent_message (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_kb_agent_thread(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    role text not null,
    content_text text not null default '',
    content_json text,
    metadata_json text,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_kb_agent_message_thread_idx
    on petrichor_kb_agent_message(thread_id, created_at);

create table if not exists petrichor_kb_agent_run (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_kb_agent_thread(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    status text not null default 'RUNNING',
    model_name text,
    error_message text,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_kb_agent_run_thread_idx
    on petrichor_kb_agent_run(thread_id, created_at);

create table if not exists petrichor_kb_agent_step (
    id bigint generated always as identity primary key,
    run_id bigint not null references petrichor_kb_agent_run(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    step_type text not null,
    title text not null,
    status text not null,
    payload_json text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_kb_agent_step_run_idx
    on petrichor_kb_agent_step(run_id, created_at);

create table if not exists petrichor_kb_agent_artifact (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_kb_agent_thread(id) on delete cascade,
    run_id bigint references petrichor_kb_agent_run(id) on delete set null,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    artifact_type text not null,
    title text not null,
    payload_json text,
    content_md text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

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
