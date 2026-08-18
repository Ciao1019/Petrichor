-- Agent Runtime v2 持久化与 BM25 全文索引（需求 §91 / §142~§146）
-- 幂等：可重复执行；回滚脚本见文件末尾注释。

-- ---------------------------------------------------------------------------
-- 1. Agent Run / Trace / Evidence / SubTask
-- ---------------------------------------------------------------------------

create table if not exists petrichor_agent_run (
    id bigint generated always as identity primary key,
    run_key text not null,
    conversation_id text not null,
    thread_id bigint,
    user_id bigint not null,
    retry_of_run_key text,
    model text not null,
    goal text not null,
    complexity text not null default 'simple',
    status text not null default 'running',
    stop_reason text,
    answer text,
    routing_hint_json text,
    plan_json text,
    loaded_skills_json text,
    metrics_json text,
    eval_json text,
    tool_call_count integer not null default 0,
    iteration_count integer not null default 0,
    delegation_count integer not null default 0,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    total_tokens integer not null default 0,
    duration_ms integer,
    started_at timestamptz not null default now(),
    completed_at timestamptz
);

create unique index if not exists ux_petrichor_agent_run_key
    on petrichor_agent_run(run_key);
create index if not exists petrichor_agent_run_conversation_idx
    on petrichor_agent_run(conversation_id, started_at);
create index if not exists petrichor_agent_run_user_idx
    on petrichor_agent_run(user_id, started_at);
create index if not exists petrichor_agent_run_stop_reason_idx
    on petrichor_agent_run(stop_reason, started_at);

create table if not exists petrichor_agent_trace_event (
    id bigint generated always as identity primary key,
    run_key text not null,
    sequence integer not null,
    event_type text not null,
    payload_json text,
    tool_id text,
    created_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_agent_trace_event_seq
    on petrichor_agent_trace_event(run_key, sequence);
create index if not exists petrichor_agent_trace_event_type_idx
    on petrichor_agent_trace_event(event_type, created_at);
create index if not exists petrichor_agent_trace_event_tool_idx
    on petrichor_agent_trace_event(tool_id, created_at);

create table if not exists petrichor_agent_evidence (
    id bigint generated always as identity primary key,
    run_key text not null,
    evidence_key text not null,
    source text not null,
    title text,
    content text not null,
    source_id text,
    url text,
    relevance integer,
    confidence integer,
    metadata_json text,
    created_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_agent_evidence_key
    on petrichor_agent_evidence(run_key, evidence_key);
create index if not exists petrichor_agent_evidence_run_idx
    on petrichor_agent_evidence(run_key, created_at);

create table if not exists petrichor_agent_subtask (
    id bigint generated always as identity primary key,
    run_key text not null,
    task_key text not null,
    objective text not null,
    status text not null,
    summary text,
    depth integer not null default 1,
    evidence_count integer not null default 0,
    duration_ms integer,
    created_at timestamptz not null default now()
);

create unique index if not exists ux_petrichor_agent_subtask_key
    on petrichor_agent_subtask(run_key, task_key);
create index if not exists petrichor_agent_subtask_run_idx
    on petrichor_agent_subtask(run_key, created_at);

-- ---------------------------------------------------------------------------
-- 2. BM25 词法召回索引
--    中文无法用内置 parser 正确切词，因此由应用层把标题/摘要/正文展开成
--    2 字 n-gram 词元串写入 search_*_tokens，再用 simple 配置建 tsvector 生成列。
--    字段权重：title=A > summary=B > content=C。
-- ---------------------------------------------------------------------------

alter table petrichor_kb_wiki_tree_node
    add column if not exists search_title_tokens text,
    add column if not exists search_summary_tokens text,
    add column if not exists search_content_tokens text;

alter table petrichor_kb_wiki_tree_node
    add column if not exists search_vector tsvector
    generated always as (
        setweight(to_tsvector('simple', coalesce(search_title_tokens, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(search_summary_tokens, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(search_content_tokens, '')), 'C')
    ) stored;

create index if not exists petrichor_kb_wiki_tree_node_search_idx
    on petrichor_kb_wiki_tree_node using gin (search_vector);

-- 已有数据的词元列由应用层在下次重建目录树时回填；
-- 回填前 BM25 会自动退回整表扫描路径，功能不受影响。

-- ---------------------------------------------------------------------------
-- 回滚
-- ---------------------------------------------------------------------------
-- drop index if exists petrichor_kb_wiki_tree_node_search_idx;
-- alter table petrichor_kb_wiki_tree_node drop column if exists search_vector;
-- alter table petrichor_kb_wiki_tree_node
--     drop column if exists search_title_tokens,
--     drop column if exists search_summary_tokens,
--     drop column if exists search_content_tokens;
-- drop table if exists petrichor_agent_subtask;
-- drop table if exists petrichor_agent_evidence;
-- drop table if exists petrichor_agent_trace_event;
-- drop table if exists petrichor_agent_run;
