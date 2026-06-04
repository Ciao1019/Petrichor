-- ============================================================
-- 文档导入任务（PDF / Word → 多模态识别 → 文章）
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：新增「导入文档」能力，把 PDF（含扫描件）/ Word 每一页渲染成图片，
--      交给多模态模型识别为 Markdown，逐页落库以支持进度展示与失败重试，
--      全部成功后合并生成一篇文章。
-- 全部 IF NOT EXISTS，可安全重复执行。
-- 说明：多模态模型沿用现有 petrichor_ai_model_config 表，config_type='VISION'，
--      无需改表结构。
-- ============================================================

-- 1) 导入任务主表
create table if not exists petrichor_kb_import_job (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    knowledge_base_id bigint not null references petrichor_kb_knowledge_base(id) on delete cascade,
    parent_node_id bigint references petrichor_kb_node(id) on delete set null,
    source_type text not null,
    file_name text not null,
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

-- 任务列表：where user_id order by created_at desc
create index if not exists idx_petrichor_kb_import_job_user
    on petrichor_kb_import_job(user_id, created_at desc);

-- 任务列表（按知识库过滤）：where user_id + knowledge_base_id
create index if not exists idx_petrichor_kb_import_job_user_kb
    on petrichor_kb_import_job(user_id, knowledge_base_id);

-- 2) 导入任务的逐页明细表
create table if not exists petrichor_kb_import_job_page (
    id bigint generated always as identity primary key,
    job_id bigint not null references petrichor_kb_import_job(id) on delete cascade,
    page_no integer not null,
    image_key text not null,
    status text not null default 'pending',
    markdown text,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (job_id, page_no)
);

-- 加载任务详情 / 进度：where job_id order by page_no
create index if not exists idx_petrichor_kb_import_job_page_job
    on petrichor_kb_import_job_page(job_id);
