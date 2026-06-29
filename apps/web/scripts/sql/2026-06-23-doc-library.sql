-- ============================================================
-- 文档库（Document Library）
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：新增「文档库」能力——与知识库（存放 Markdown 文章）不同，文档库存放
--      原始文件（双层 PDF / docx / xlsx / csv）。文件上传时在客户端解析为纯文本
--      + 分块入库，并针对文档库内容做 agentic 问答（关键词检索工具）。
-- 全部 IF NOT EXISTS，可安全重复执行。
-- 说明：问答模型沿用现有 petrichor_ai_model_config 表，config_type='DOC_QA'。
-- ============================================================

-- 1) 文档库
create table if not exists petrichor_doc_library (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    name text not null,
    description text,
    color text,
    icon text,
    document_count integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_library_user
    on petrichor_doc_library(user_id);
create index if not exists petrichor_doc_library_user_updated_idx
    on petrichor_doc_library(user_id, updated_at);

-- 2) 文件夹树（供 Finder 浏览）
create table if not exists petrichor_doc_folder (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    library_id bigint not null references petrichor_doc_library(id) on delete cascade,
    parent_id bigint references petrichor_doc_folder(id) on delete cascade,
    name text not null,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_folder_user_lib
    on petrichor_doc_folder(user_id, library_id);
create index if not exists petrichor_doc_folder_parent_idx
    on petrichor_doc_folder(library_id, parent_id, sort_order);

-- 3) 文档（文件）：仅支持 pdf / docx / xlsx / csv
create table if not exists petrichor_doc_document (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    library_id bigint not null references petrichor_doc_library(id) on delete cascade,
    folder_id bigint references petrichor_doc_folder(id) on delete set null,
    file_name text not null,
    title text not null,
    file_type text not null,
    content_type text,
    object_key text not null,
    size_bytes bigint,
    page_count integer,
    char_count integer,
    status text not null default 'pending',
    blocks_json text,
    summary text,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_document_user_lib
    on petrichor_doc_document(user_id, library_id);
create index if not exists petrichor_doc_document_folder_idx
    on petrichor_doc_document(library_id, folder_id);
create index if not exists petrichor_doc_document_status_idx
    on petrichor_doc_document(user_id, status);

-- 4) 文本分块：agentic 关键词检索的检索单元
create table if not exists petrichor_doc_chunk (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    library_id bigint not null references petrichor_doc_library(id) on delete cascade,
    document_id bigint not null references petrichor_doc_document(id) on delete cascade,
    chunk_index integer not null,
    locator text,
    page integer,
    text text not null,
    created_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_chunk_document
    on petrichor_doc_chunk(document_id, chunk_index);
create index if not exists idx_petrichor_doc_chunk_library
    on petrichor_doc_chunk(library_id);

-- 5) 问答对话线程（library_id 为空表示跨库）
create table if not exists petrichor_doc_qa_thread (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    library_id bigint references petrichor_doc_library(id) on delete set null,
    title text not null,
    status text not null default 'ACTIVE',
    last_message_at timestamptz,
    metadata_json text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_qa_thread_user
    on petrichor_doc_qa_thread(user_id, updated_at);
create index if not exists petrichor_doc_qa_thread_user_history_idx
    on petrichor_doc_qa_thread(user_id, updated_at, id);

-- 6) 问答消息
create table if not exists petrichor_doc_qa_message (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_doc_qa_thread(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    role text not null,
    content_text text not null default '',
    content_json text,
    metadata_json text,
    created_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_qa_message_thread
    on petrichor_doc_qa_message(thread_id, created_at);

-- 7) 问答 Agent 运行记录
create table if not exists petrichor_doc_qa_run (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_doc_qa_thread(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    status text not null default 'RUNNING',
    model_name text,
    error_message text,
    started_at timestamptz not null default now(),
    finished_at timestamptz
);
create index if not exists idx_petrichor_doc_qa_run_thread
    on petrichor_doc_qa_run(thread_id, started_at);

-- 8) 问答 Agent 步骤
create table if not exists petrichor_doc_qa_step (
    id bigint generated always as identity primary key,
    run_id bigint not null references petrichor_doc_qa_run(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    step_type text not null,
    title text not null,
    status text not null,
    payload_json text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_qa_step_run
    on petrichor_doc_qa_step(run_id, created_at);

-- 9) 问答产物
create table if not exists petrichor_doc_qa_artifact (
    id bigint generated always as identity primary key,
    thread_id bigint not null references petrichor_doc_qa_thread(id) on delete cascade,
    run_id bigint not null references petrichor_doc_qa_run(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    artifact_type text not null,
    title text not null,
    payload_json text,
    content_md text,
    created_at timestamptz not null default now()
);
create index if not exists idx_petrichor_doc_qa_artifact_thread
    on petrichor_doc_qa_artifact(thread_id, created_at);
