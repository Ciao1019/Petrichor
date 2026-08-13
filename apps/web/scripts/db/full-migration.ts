const BUSINESS_SCHEMA_SQL = `
create extension if not exists pg_trgm;
create extension if not exists vector;

create table if not exists petrichor_user (
    id bigint generated always as identity primary key,
    email text not null,
    password_hash text not null default '',
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
    add column if not exists linuxdo_account_id text,
    add column if not exists linuxdo_username text,
    add column if not exists linuxdo_email text;

create unique index if not exists ux_petrichor_user_linuxdo_account_id
    on petrichor_user(linuxdo_account_id)
    where linuxdo_account_id is not null;

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
    chunk_strategy text not null default 'auto',
    chunk_size integer not null default 512,
    chunk_overlap integer not null default 80,
    chunk_separators_json text,
    enable_parent_child boolean not null default false,
    parent_chunk_size integer not null default 0,
    child_chunk_size integer not null default 0,
    chat_model_id bigint,
    embedding_model_id bigint,
    rerank_model_id bigint,
    wiki_enabled boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_kb_knowledge_base_user_id_idx
    on petrichor_kb_knowledge_base(user_id);

-- 知识库列表按 user_id 过滤、updated_at 排序
create index if not exists petrichor_kb_knowledge_base_user_updated_idx
    on petrichor_kb_knowledge_base(user_id, updated_at desc);

alter table petrichor_kb_knowledge_base
    add column if not exists chunk_strategy text not null default 'auto',
    add column if not exists chunk_size integer not null default 512,
    add column if not exists chunk_overlap integer not null default 80,
    add column if not exists chunk_separators_json text,
    add column if not exists enable_parent_child boolean not null default false,
    add column if not exists parent_chunk_size integer not null default 0,
    add column if not exists child_chunk_size integer not null default 0,
    add column if not exists chat_model_id bigint,
    add column if not exists embedding_model_id bigint,
    add column if not exists rerank_model_id bigint,
    add column if not exists wiki_enabled boolean not null default false;

create table if not exists petrichor_kb_document_folder (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    parent_id bigint references petrichor_kb_document_folder(id) on delete set null,
    name text not null,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_kb_document_folder_user_kb_idx
    on petrichor_kb_document_folder(user_id, knowledge_base_id);

create index if not exists petrichor_kb_document_folder_parent_idx
    on petrichor_kb_document_folder(knowledge_base_id, parent_id, sort_order);

create table if not exists petrichor_kb_document (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    folder_id bigint references petrichor_kb_document_folder(id) on delete set null,
    file_name text not null,
    title text not null,
    file_type text not null,
    content_type text,
    object_key text not null,
    size_bytes bigint,
    page_count integer,
    char_count integer,
    chunk_count integer not null default 0,
    status text not null default 'pending',
    blocks_json text,
    extracted_text text,
    segments_json text,
    summary text,
    error text,
    parse_config_json text,
    parse_attempt integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists petrichor_kb_document_user_kb_idx
    on petrichor_kb_document(user_id, knowledge_base_id);

create index if not exists petrichor_kb_document_folder_idx
    on petrichor_kb_document(knowledge_base_id, folder_id);

create index if not exists petrichor_kb_document_status_idx
    on petrichor_kb_document(user_id, status);

create table if not exists petrichor_kb_document_chunk (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    chunk_index integer not null,
    locator text,
    page integer,
    context_header text,
    start_offset integer,
    end_offset integer,
    chunk_type text not null default 'text',
    parent_chunk_index integer,
    text text not null,
    char_count integer not null default 0,
    token_estimate integer not null default 0,
    created_at timestamptz not null default now(),
    unique (document_id, chunk_index)
);

alter table petrichor_kb_document_chunk add column if not exists embedding vector(1024);

create index if not exists petrichor_kb_document_chunk_kb_idx
    on petrichor_kb_document_chunk(knowledge_base_id);

create index if not exists petrichor_kb_document_chunk_kb_type_idx
    on petrichor_kb_document_chunk(knowledge_base_id, chunk_type);

create index if not exists petrichor_kb_document_chunk_text_trgm_idx
    on petrichor_kb_document_chunk using gin (text gin_trgm_ops);

create index if not exists petrichor_kb_document_chunk_embedding_idx
    on petrichor_kb_document_chunk using hnsw (embedding vector_cosine_ops);

-- 解析流水线 span。同一 (document_id, attempt, span_id) 唯一，重试覆盖同一行而不是无限膨胀。
create table if not exists petrichor_kb_document_span (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    attempt integer not null default 1,
    span_id text not null,
    parent_span_id text,
    name text not null,
    kind text not null,
    status text not null,
    input jsonb,
    output jsonb,
    error_code text,
    error_message text,
    started_at timestamptz,
    finished_at timestamptz,
    duration_ms bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (document_id, attempt, span_id)
);

create index if not exists petrichor_kb_document_span_doc_attempt_idx
    on petrichor_kb_document_span(document_id, attempt);

-- 分片衍生问题：每条问题一行、单独 embedding，检索时并行召回后映射回 chunk_id。
create table if not exists petrichor_kb_document_chunk_question (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    chunk_id bigint not null references petrichor_kb_document_chunk(id) on delete cascade,
    question text not null,
    created_at timestamptz not null default now()
);

alter table petrichor_kb_document_chunk_question
    add column if not exists embedding vector(1024);

create index if not exists petrichor_kb_document_chunk_question_chunk_idx
    on petrichor_kb_document_chunk_question(chunk_id);

create index if not exists petrichor_kb_document_chunk_question_doc_idx
    on petrichor_kb_document_chunk_question(document_id);

create index if not exists petrichor_kb_document_chunk_question_embedding_idx
    on petrichor_kb_document_chunk_question using hnsw (embedding vector_cosine_ops);

-- 文档标签：上传时批量打，文档列表按标签筛选。
create table if not exists petrichor_kb_document_tag (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    tag text not null,
    created_at timestamptz not null default now(),
    unique (document_id, tag)
);

create index if not exists petrichor_kb_document_tag_kb_idx
    on petrichor_kb_document_tag(knowledge_base_id, tag);

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

-- 公开文章搜索：中文内容使用 pg_trgm 子串匹配提升检索体验
create index if not exists idx_petrichor_kb_article_title_trgm
    on petrichor_kb_article
    using gin (title gin_trgm_ops);

create index if not exists idx_petrichor_kb_article_public_excerpt_trgm
    on petrichor_kb_article
    using gin (public_excerpt gin_trgm_ops);

create index if not exists idx_petrichor_kb_article_content_md_trgm
    on petrichor_kb_article
    using gin (content_md gin_trgm_ops);

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
    internal_url text,
    pin_order integer,
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
    add column if not exists internal_url text,
    add column if not exists pin_order integer;

create index if not exists petrichor_kb_article_share_user_id_idx
    on petrichor_kb_article_share(user_id);

create index if not exists petrichor_kb_article_share_public_idx
    on petrichor_kb_article_share(enabled, revoked_at, article_id);

create index if not exists petrichor_kb_article_share_pin_idx
    on petrichor_kb_article_share(pin_order);

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

create index if not exists petrichor_kb_burn_link_article_idx
    on petrichor_kb_article_burn_link(user_id, article_id, created_at);

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
    category_path_json text,
    sort_order integer not null default 0,
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

create index if not exists petrichor_kb_wiki_page_tree_idx
    on petrichor_kb_wiki_page(user_id, knowledge_base_id, sort_order, title);

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

create table if not exists petrichor_kb_wiki_document_ref (
    id bigint generated always as identity primary key,
    page_id bigint not null references petrichor_kb_wiki_page(id) on delete cascade,
    document_id bigint not null references petrichor_kb_document(id) on delete cascade,
    chunk_indexes_json text,
    note text,
    created_at timestamptz not null default now(),
    unique (page_id, document_id)
);

create index if not exists petrichor_kb_wiki_document_ref_page_idx
    on petrichor_kb_wiki_document_ref(page_id);

create index if not exists petrichor_kb_wiki_document_ref_document_idx
    on petrichor_kb_wiki_document_ref(document_id);

create table if not exists petrichor_kb_wiki_ingest_job (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    kind text not null default 'ingest',
    document_ids_json text not null default '[]',
    force_rebuild boolean not null default false,
    status text not null default 'pending',
    total_documents integer not null default 0,
    processed_documents integer not null default 0,
    phase text not null default 'queued',
    current_document text,
    total_pages integer not null default 0,
    processed_pages integer not null default 0,
    warnings_json text not null default '[]',
    error text,
    available_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table petrichor_kb_wiki_ingest_job
    add column if not exists phase text not null default 'queued',
    add column if not exists current_document text,
    add column if not exists total_pages integer not null default 0,
    add column if not exists processed_pages integer not null default 0;

create index if not exists petrichor_kb_wiki_ingest_job_status_available_idx
    on petrichor_kb_wiki_ingest_job(status, available_at);

create index if not exists petrichor_kb_wiki_ingest_job_user_kb_created_idx
    on petrichor_kb_wiki_ingest_job(user_id, knowledge_base_id, created_at);

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
    accents_json text not null default $about_accents$[{"phrase":"CiZai","style":"red","note":"yep, that's me"},{"phrase":"程序员","style":"green","note":"just a dev"},{"phrase":"金山办公","style":"blue","note":"where I work"},{"phrase":"Coding / AI","style":"green","note":"my playground"},{"phrase":"Minecraft","style":"blue","note":"★ my comfort game"}]$about_accents$,
    contact_text text not null default '想聊点什么？随时',
    contact_label text not null default 'message me',
    contact_href text not null default 'mailto:zang@linux.do',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 为已存在的旧表幂等补列（首次发布注记/联系方式功能时升级用）。
alter table petrichor_site_about_profile
    add column if not exists accents_json text not null default $about_accents$[{"phrase":"CiZai","style":"red","note":"yep, that's me"},{"phrase":"程序员","style":"green","note":"just a dev"},{"phrase":"金山办公","style":"blue","note":"where I work"},{"phrase":"Coding / AI","style":"green","note":"my playground"},{"phrase":"Minecraft","style":"blue","note":"★ my comfort game"}]$about_accents$;
alter table petrichor_site_about_profile
    add column if not exists contact_text text not null default '想聊点什么？随时';
alter table petrichor_site_about_profile
    add column if not exists contact_label text not null default 'message me';
alter table petrichor_site_about_profile
    add column if not exists contact_href text not null default 'mailto:zang@linux.do';

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
    public_qa_enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table petrichor_site_appearance
    add column if not exists public_qa_enabled boolean not null default true;

insert into petrichor_site_appearance (id, public_qa_enabled)
values (1, true)
on conflict (id) do nothing;

create table if not exists petrichor_site_project_showcase (
    id integer primary key,
    heading text not null default '开源项目',
    intro text not null default '',
    items_json text not null default $proj_items$[{"name":"Ech0 — self-hosted microblog","year":"2025","stack":["Go","Vue"],"stamp":"popular","stampColor":"red","blurb":"An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.","repoUrl":"https://github.com/lin-snow/Ech0","siteUrl":"https://ech0.app"},{"name":"Dox — todos in terminal","year":"2026","stack":["Go","TypeScript"],"stamp":"new","stampColor":"blue","blurb":"More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.","repoUrl":"https://github.com/lin-snow/dox"},{"name":"Kemate — a Vercel-like PaaS","year":"2026","stack":["Go"],"stamp":"WIP","stampColor":"green","blurb":"A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture."}]$proj_items$,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

insert into petrichor_site_project_showcase (id)
values (1)
on conflict (id) do nothing;

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

create table if not exists petrichor_kb_import_job (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    parent_node_id bigint references petrichor_kb_node(id) on delete set null,
    source_type text not null,
    file_name text not null,
    source_key text,
    title text not null,
    total_pages integer not null default 0,
    processed_pages integer not null default 0,
    status text not null default 'pending',
    model_config_id bigint,
    article_id bigint references petrichor_kb_article(id) on delete set null,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_petrichor_kb_import_job_user
    on petrichor_kb_import_job(user_id, created_at desc);

create index if not exists idx_petrichor_kb_import_job_user_kb
    on petrichor_kb_import_job(user_id, knowledge_base_id);

create table if not exists petrichor_kb_import_job_page (
    id bigint generated always as identity primary key,
    job_id bigint not null references petrichor_kb_import_job(id) on delete cascade,
    page_no integer not null,
    image_key text,
    extracted_by text not null default 'vision',
    status text not null default 'pending',
    markdown text,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (job_id, page_no)
);

create index if not exists idx_petrichor_kb_import_job_page_job
    on petrichor_kb_import_job_page(job_id);

create table if not exists petrichor_agent_memory (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    kind text not null,
    content text not null,
    evidence_count integer not null default 1,
    last_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_petrichor_agent_memory_user
    on petrichor_agent_memory(user_id, last_seen_at desc);

alter table petrichor_agent_memory add column if not exists embedding vector(1024);

create index if not exists idx_petrichor_agent_memory_embedding
    on petrichor_agent_memory using hnsw (embedding vector_cosine_ops);

create table if not exists petrichor_agent_memory_state (
    user_id bigint primary key,
    last_distilled_at timestamptz,
    last_message_id bigint not null default 0,
    last_assistant_message_id bigint not null default 0,
    distill_count integer not null default 0,
    updated_at timestamptz not null default now()
);

alter table petrichor_agent_memory_state
    add column if not exists last_assistant_message_id bigint not null default 0;

create table if not exists petrichor_assistant_thread (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    title text not null,
    focus_json text,
    context_summary_md text,
    context_summary_until_message_id bigint,
    context_summary_updated_at timestamptz,
    danger_allowlist_json text,
    operator_memory_snapshot_json text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);

alter table petrichor_assistant_thread
    add column if not exists danger_allowlist_json text;

alter table petrichor_assistant_thread
    add column if not exists operator_memory_snapshot_json text;

create table if not exists petrichor_assistant_operator_profile (
    user_id bigint primary key,
    user_profile_md text not null default '',
    agent_notes_md text not null default '',
    updated_at timestamptz not null default now()
);

create table if not exists petrichor_assistant_operator_skill (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    name text not null,
    description text not null,
    body_md text not null,
    version integer not null default 1,
    status text not null default 'active',
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_assistant_operator_skill_user_name
    on petrichor_assistant_operator_skill(user_id, name);

create index if not exists petrichor_assistant_operator_skill_user_idx
    on petrichor_assistant_operator_skill(user_id, status);

create index if not exists petrichor_assistant_thread_user_history_idx
    on petrichor_assistant_thread(user_id, updated_at desc, id desc);

create table if not exists petrichor_assistant_message (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    role text not null,
    content_json text,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_assistant_message_thread_order_idx
    on petrichor_assistant_message(thread_id, created_at, id);

create table if not exists petrichor_assistant_run (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    status text not null default 'RUNNING',
    model_config_id bigint,
    intent_domains_json text,
    error_code text,
    started_at timestamptz not null default now(),
    finished_at timestamptz
);

create index if not exists petrichor_assistant_run_thread_idx
    on petrichor_assistant_run(thread_id, started_at desc);

create table if not exists petrichor_assistant_step (
    id bigint generated always as identity primary key,
    run_id bigint not null references petrichor_assistant_run(id) on delete cascade,
    step_index integer not null,
    tool_name text not null,
    input_json text,
    output_json text,
    status text not null,
    error_code text,
    duration_ms integer
);

alter table petrichor_assistant_step
    add column if not exists error_code text;

create index if not exists petrichor_assistant_step_run_idx
    on petrichor_assistant_step(run_id, step_index);

create table if not exists petrichor_assistant_artifact (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    run_id bigint references petrichor_assistant_run(id) on delete set null,
    kind text not null,
    title text not null,
    content_json text,
    created_at timestamptz not null default now()
);

create index if not exists petrichor_assistant_artifact_thread_idx
    on petrichor_assistant_artifact(thread_id, created_at desc);

create table if not exists petrichor_assistant_plan (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    user_id bigint not null,
    plan_key text not null,
    title text not null,
    description text,
    todos_json text not null,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_assistant_plan_thread_key
    on petrichor_assistant_plan(thread_id, plan_key);

create index if not exists petrichor_assistant_plan_thread_updated_idx
    on petrichor_assistant_plan(thread_id, updated_at desc);

create table if not exists petrichor_assistant_confirmation (
    id bigint generated always as identity primary key,
    confirmation_key text not null,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    user_id bigint not null,
    tool_name text not null,
    input_json text not null,
    status text not null default 'pending',
    consumed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_assistant_confirmation_key
    on petrichor_assistant_confirmation(confirmation_key);

create index if not exists petrichor_assistant_confirmation_thread_idx
    on petrichor_assistant_confirmation(thread_id, user_id, status);

create table if not exists petrichor_assistant_message_embedding (
    message_id bigint primary key references petrichor_assistant_message(id) on delete cascade,
    thread_id bigint not null,
    user_id bigint not null,
    excerpt_md text not null,
    embedding vector(1024),
    created_at timestamptz not null default now()
);

create index if not exists petrichor_assistant_message_embedding_thread_idx
    on petrichor_assistant_message_embedding(thread_id, user_id);

create index if not exists idx_petrichor_assistant_message_embedding
    on petrichor_assistant_message_embedding using hnsw (embedding vector_cosine_ops);

create index if not exists petrichor_assistant_message_embedding_fts_idx
    on petrichor_assistant_message_embedding
    using gin (to_tsvector('simple', coalesce(excerpt_md, '')));
`;

export function buildInitialMigrationSql(): string {
    return BUSINESS_SCHEMA_SQL.trim();
}
