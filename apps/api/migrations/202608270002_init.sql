-- +goose Up

-- Petrichor 当前版本的全新数据库基线。
-- 只描述最终结构，不包含历史迁移、兼容回填或废弃对象清理。
-- 数据库创建完成后，首次访问页面时由部署者设置管理员账号和密码。

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE public.petrichor_agent_api_key (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    scopes_json text DEFAULT '[]'::text NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_agent_api_key ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_agent_api_key_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_agent_call_log (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    api_key_id bigint NOT NULL,
    api_key_prefix text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    ip text,
    user_agent text,
    request_json text,
    response_json text,
    status_code integer NOT NULL,
    duration_ms integer NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_agent_call_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_agent_call_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_agent_evidence (
    id bigint NOT NULL,
    run_key text NOT NULL,
    evidence_key text NOT NULL,
    source text NOT NULL,
    title text,
    content text NOT NULL,
    source_id text,
    url text,
    relevance integer,
    confidence integer,
    metadata_json text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_agent_evidence ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_agent_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_agent_memory (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    evidence_count integer DEFAULT 1 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector
);

ALTER TABLE public.petrichor_agent_memory ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_agent_memory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_agent_run (
    id bigint NOT NULL,
    run_key text NOT NULL,
    conversation_id text NOT NULL,
    thread_id bigint,
    user_id bigint NOT NULL,
    retry_of_run_key text,
    model text NOT NULL,
    goal text NOT NULL,
    complexity text DEFAULT 'simple'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    stop_reason text,
    answer text,
    routing_hint_json text,
    plan_json text,
    loaded_skills_json text,
    metrics_json text,
    eval_json text,
    tool_call_count integer DEFAULT 0 NOT NULL,
    iteration_count integer DEFAULT 0 NOT NULL,
    delegation_count integer DEFAULT 0 NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    duration_ms integer,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

ALTER TABLE public.petrichor_agent_run ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_agent_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_agent_subtask (
    id bigint NOT NULL,
    run_key text NOT NULL,
    task_key text NOT NULL,
    objective text NOT NULL,
    status text NOT NULL,
    summary text,
    depth integer DEFAULT 1 NOT NULL,
    evidence_count integer DEFAULT 0 NOT NULL,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_agent_subtask ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_agent_subtask_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_agent_trace_event (
    id bigint NOT NULL,
    run_key text NOT NULL,
    sequence integer NOT NULL,
    event_type text NOT NULL,
    payload_json text,
    tool_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_agent_trace_event ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_agent_trace_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_ai_binding (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    purpose text NOT NULL,
    model_ref_id bigint NOT NULL,
    options_json text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_ai_binding ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_ai_binding_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_ai_credential (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    name text NOT NULL,
    provider_key text,
    api_key_enc text NOT NULL,
    extra_enc text,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_ai_credential ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_ai_credential_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_ai_model (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    provider_id bigint NOT NULL,
    model_id text NOT NULL,
    display_name text,
    kind text NOT NULL,
    context_window integer,
    dimensions integer,
    capabilities_json text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_ai_model ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_ai_model_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_ai_provider (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    provider_key text NOT NULL,
    name text NOT NULL,
    base_url text,
    credential_id bigint NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    headers_json text,
    options_json text,
    last_checked_at timestamp with time zone,
    last_check_status text,
    last_check_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_ai_provider ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_ai_provider_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_ai_review (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    period text NOT NULL,
    period_key text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    stats_json text NOT NULL,
    narrative text NOT NULL,
    model_config_id bigint,
    regenerate_count integer DEFAULT 0 NOT NULL,
    last_regenerated_at timestamp with time zone,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_ai_review ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_ai_review_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_assistant_artifact (
    id bigint NOT NULL,
    thread_id bigint NOT NULL,
    run_id bigint,
    kind text NOT NULL,
    title text NOT NULL,
    content_json text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_assistant_artifact ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_assistant_artifact_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_assistant_confirmation (
    id bigint NOT NULL,
    confirmation_key text NOT NULL,
    thread_id bigint NOT NULL,
    user_id bigint NOT NULL,
    tool_name text NOT NULL,
    input_json text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_assistant_confirmation ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_assistant_confirmation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_assistant_message (
    id bigint NOT NULL,
    thread_id bigint NOT NULL,
    role text NOT NULL,
    content_json text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.petrichor_assistant_message_embedding (
    message_id bigint NOT NULL,
    thread_id bigint NOT NULL,
    user_id bigint NOT NULL,
    excerpt_md text NOT NULL,
    embedding public.vector,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_assistant_message ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_assistant_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_assistant_operator_profile (
    user_id bigint NOT NULL,
    user_profile_md text DEFAULT ''::text NOT NULL,
    agent_notes_md text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.petrichor_assistant_plan (
    id bigint NOT NULL,
    thread_id bigint NOT NULL,
    user_id bigint NOT NULL,
    plan_key text NOT NULL,
    title text NOT NULL,
    description text,
    todos_json text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_assistant_plan ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_assistant_plan_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_assistant_run (
    id bigint NOT NULL,
    thread_id bigint NOT NULL,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    model_config_id bigint,
    intent_domains_json text,
    error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);

ALTER TABLE public.petrichor_assistant_run ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_assistant_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_assistant_step (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    step_index integer NOT NULL,
    tool_name text NOT NULL,
    input_json text,
    output_json text,
    status text NOT NULL,
    error_code text,
    duration_ms integer
);

ALTER TABLE public.petrichor_assistant_step ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_assistant_step_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_assistant_thread (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    title text NOT NULL,
    focus_json text,
    context_summary_md text,
    context_summary_until_message_id bigint,
    context_summary_updated_at timestamp with time zone,
    danger_allowlist_json text,
    operator_memory_snapshot_json text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE public.petrichor_assistant_thread ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_assistant_thread_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.sa_token_storage (
    key text NOT NULL,
    value bytea NOT NULL,
    value_type text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sa_token_storage_value_type_check CHECK (value_type IN ('string', 'bytes', 'json'))
);

CREATE TABLE public.petrichor_doc_chunk (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    library_id bigint NOT NULL,
    document_id bigint NOT NULL,
    chunk_index integer NOT NULL,
    locator text,
    page integer,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_doc_chunk ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_doc_chunk_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_doc_document (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    library_id bigint NOT NULL,
    folder_id bigint,
    file_name text NOT NULL,
    title text NOT NULL,
    file_type text NOT NULL,
    content_type text,
    object_key text NOT NULL,
    size_bytes bigint,
    page_count integer,
    char_count integer,
    status text DEFAULT 'pending'::text NOT NULL,
    blocks_json text,
    summary text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_doc_document ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_doc_document_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_doc_folder (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    library_id bigint NOT NULL,
    parent_id bigint,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_doc_folder ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_doc_folder_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_doc_library (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    name text NOT NULL,
    description text,
    color text,
    icon text,
    document_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_doc_library ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_doc_library_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_article (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    node_id bigint NOT NULL,
    title text NOT NULL,
    content_md text NOT NULL,
    content_json text,
    content_meta_json text,
    public_excerpt text,
    reading_minutes integer,
    toc_json text,
    public_content_hash text,
    ai_summary text,
    ai_summary_content_hash text,
    ai_summary_generated_at timestamp with time zone,
    mindmap_json text,
    mindmap_content_hash text,
    mindmap_generated_at timestamp with time zone,
    mindmap_kg_json text,
    mindmap_kg_content_hash text,
    mindmap_kg_generated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.petrichor_kb_article_burn_link (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    article_id bigint NOT NULL,
    link_code text NOT NULL,
    max_views integer DEFAULT 1 NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    password_hash text,
    expires_at timestamp with time zone,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    burned_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_article_burn_link ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_article_burn_link_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_article_chunk (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    article_id bigint NOT NULL,
    chunk_key text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    heading text NOT NULL,
    content_md text NOT NULL,
    content_hash text NOT NULL,
    heading_path_json text DEFAULT '[]'::text NOT NULL,
    recommended_questions_json text DEFAULT '[]'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_article_chunk ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_article_chunk_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_article_chunk_index (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    article_id bigint NOT NULL,
    chunk_id bigint NOT NULL,
    source_key text NOT NULL,
    source_type text NOT NULL,
    source_position integer DEFAULT 0 NOT NULL,
    content text NOT NULL,
    embedding_text text NOT NULL,
    content_hash text NOT NULL,
    search_tokens text DEFAULT ''::text NOT NULL,
    embedding_status text DEFAULT 'pending'::text NOT NULL,
    embedding_model text,
    embedding_dimensions integer,
    embedding_version integer DEFAULT 1 NOT NULL,
    embedding_error text,
    embedding_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(search_tokens, ''::text))) STORED,
    CONSTRAINT petrichor_kb_article_chunk_index_source_type_check CHECK ((source_type = ANY (ARRAY['chunk'::text, 'question'::text])))
);

ALTER TABLE public.petrichor_kb_article_chunk_index ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_article_chunk_index_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.petrichor_kb_article ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_article_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_article_share (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    article_id bigint NOT NULL,
    share_code text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    password_hash text,
    is_repost boolean DEFAULT false NOT NULL,
    original_url text,
    original_author_name text,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    internal_url text,
    pin_order integer
);

ALTER TABLE public.petrichor_kb_article_share ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_article_share_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_article_tag (
    id bigint NOT NULL,
    article_id bigint NOT NULL,
    tag text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_article_tag ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_article_tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_import_job (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    parent_node_id bigint,
    source_type text NOT NULL,
    file_name text NOT NULL,
    source_key text,
    title text NOT NULL,
    total_pages integer DEFAULT 0 NOT NULL,
    processed_pages integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    model_config_id bigint,
    article_id bigint,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_import_job ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_import_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_import_job_page (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    page_no integer NOT NULL,
    image_key text,
    extracted_by text DEFAULT 'vision'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    markdown text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_import_job_page ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_import_job_page_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_knowledge_base (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_knowledge_base ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_knowledge_base_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_node (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    parent_id bigint,
    type text NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_node ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_node_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_wiki_event_log (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    event_type text NOT NULL,
    page_id bigint,
    payload_json text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_wiki_event_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_wiki_event_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_wiki_link (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    from_page_id bigint NOT NULL,
    to_page_key text NOT NULL,
    link_type text DEFAULT 'related'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_wiki_link ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_wiki_link_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_wiki_page (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    page_key text NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    content_md text NOT NULL,
    frontmatter_json text,
    summary text,
    content_hash text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_wiki_page ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_wiki_page_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_wiki_patch (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    page_key text NOT NULL,
    title text NOT NULL,
    operation text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    before_content_md text,
    proposed_content_md text NOT NULL,
    diff_text text NOT NULL,
    reason text,
    applied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_wiki_patch ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_wiki_patch_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_wiki_source_ref (
    id bigint NOT NULL,
    page_id bigint NOT NULL,
    article_id bigint NOT NULL,
    anchor text,
    quote_hash text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_kb_wiki_source_ref ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_wiki_source_ref_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_kb_wiki_tree_node (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    knowledge_base_id bigint NOT NULL,
    page_id bigint NOT NULL,
    article_id bigint NOT NULL,
    node_key text NOT NULL,
    parent_key text,
    depth integer DEFAULT 0 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    title text NOT NULL,
    summary text,
    content_md text DEFAULT ''::text NOT NULL,
    start_line integer,
    end_line integer,
    token_estimate integer DEFAULT 0 NOT NULL,
    content_hash text NOT NULL,
    embedding_status text DEFAULT 'pending'::text NOT NULL,
    embedding_model text,
    embedding_dimensions integer,
    embedding_version integer DEFAULT 1 NOT NULL,
    embedding_error text,
    embedding_updated_at timestamp with time zone,
    search_title_tokens text,
    search_summary_tokens text,
    search_content_tokens text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector,
    search_vector tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('simple'::regconfig, COALESCE(search_title_tokens, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(search_summary_tokens, ''::text)), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, COALESCE(search_content_tokens, ''::text)), 'C'::"char"))) STORED
);

ALTER TABLE public.petrichor_kb_wiki_tree_node ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_kb_wiki_tree_node_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_notification (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    category text NOT NULL,
    biz_type text NOT NULL,
    biz_id bigint NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    payload_json text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_notification ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_public_qa_rate_limit (
    id bigint NOT NULL,
    bucket_key text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_public_qa_rate_limit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_public_qa_rate_limit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_site_about_profile (
    id integer NOT NULL,
    display_name text DEFAULT 'CiZai'::text NOT NULL,
    role_title text DEFAULT 'Creative Dev & Visual Artist'::text NOT NULL,
    intro text DEFAULT '我是 CiZai，是一个普普通通的程序员。

目前就职于金山办公

我的兴趣主要在 Coding / AI 方向。

我喜欢 Minecraft。'::text NOT NULL,
    expertise_json text DEFAULT '["Frontend Architecture","AI 应用开发","Knowledge Systems","Creative Coding"]'::text NOT NULL,
    toolkit_json text DEFAULT '["TypeScript","React","Next.js","AI","PostgreSQL","Minecraft"]'::text NOT NULL,
    quote text DEFAULT 'Code is just another medium for painting dreams.'::text NOT NULL,
    accents_json text DEFAULT '[{"phrase":"CiZai","style":"red","note":"yep, that''s me"},{"phrase":"程序员","style":"green","note":"just a dev"},{"phrase":"金山办公","style":"blue","note":"where I work"},{"phrase":"Coding / AI","style":"green","note":"my playground"},{"phrase":"Minecraft","style":"blue","note":"★ my comfort game"}]'::text NOT NULL,
    contact_text text DEFAULT '想聊点什么？随时'::text NOT NULL,
    contact_label text DEFAULT 'message me'::text NOT NULL,
    contact_href text DEFAULT 'mailto:zang@linux.do'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.petrichor_site_appearance (
    id integer NOT NULL,
    public_qa_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.petrichor_site_graph_edge (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    from_node_id bigint NOT NULL,
    to_node_id bigint NOT NULL,
    relation text NOT NULL,
    kind text DEFAULT 'reference'::text NOT NULL,
    attributes_json text,
    weight integer DEFAULT 1 NOT NULL,
    directed boolean DEFAULT true NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    source text DEFAULT 'AGENT'::text NOT NULL,
    confidence integer DEFAULT 80 NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_site_graph_edge ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_site_graph_edge_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_site_graph_merge_candidate (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    source_key text NOT NULL,
    target_key text NOT NULL,
    reason text NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    detail text,
    status text DEFAULT 'PENDING'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_site_graph_merge_candidate ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_site_graph_merge_candidate_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_site_graph_node (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    node_key text NOT NULL,
    parent_id bigint,
    kind text NOT NULL,
    name text NOT NULL,
    summary text,
    route text,
    article_id bigint,
    attributes_json text,
    aliases_json text,
    weight integer DEFAULT 1 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    source text DEFAULT 'AGENT'::text NOT NULL,
    confidence integer DEFAULT 80 NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_site_graph_node ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_site_graph_node_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_site_graph_run (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    mode text DEFAULT 'FULL'::text NOT NULL,
    model_name text,
    article_count integer DEFAULT 0 NOT NULL,
    node_count integer DEFAULT 0 NOT NULL,
    edge_count integer DEFAULT 0 NOT NULL,
    validation_json text,
    warnings_json text,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_site_graph_run ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_site_graph_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.petrichor_site_project_showcase (
    id integer NOT NULL,
    heading text DEFAULT '开源项目'::text NOT NULL,
    intro text DEFAULT ''::text NOT NULL,
    items_json text DEFAULT '[{"name":"Ech0 — self-hosted microblog","year":"2025","stack":["Go","Vue"],"stamp":"popular","stampColor":"red","blurb":"An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.","repoUrl":"https://github.com/lin-snow/Ech0","siteUrl":"https://ech0.app"},{"name":"Dox — todos in terminal","year":"2026","stack":["Go","TypeScript"],"stamp":"new","stampColor":"blue","blurb":"More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.","repoUrl":"https://github.com/lin-snow/dox"},{"name":"Kemate — a Vercel-like PaaS","year":"2026","stack":["Go"],"stamp":"WIP","stampColor":"green","blurb":"A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture."}]'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.petrichor_user (
    id bigint NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    system_role text DEFAULT 'USER'::text NOT NULL,
    user_type text DEFAULT 'LOCAL'::text NOT NULL,
    linuxdo_account_id text,
    linuxdo_username text,
    linuxdo_email text,
    username text,
    nickname text,
    avatar text,
    signature text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.petrichor_user ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.petrichor_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY public.petrichor_agent_api_key
    ADD CONSTRAINT petrichor_agent_api_key_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_agent_call_log
    ADD CONSTRAINT petrichor_agent_call_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_agent_evidence
    ADD CONSTRAINT petrichor_agent_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_agent_memory
    ADD CONSTRAINT petrichor_agent_memory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_agent_run
    ADD CONSTRAINT petrichor_agent_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_agent_subtask
    ADD CONSTRAINT petrichor_agent_subtask_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_agent_trace_event
    ADD CONSTRAINT petrichor_agent_trace_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_ai_binding
    ADD CONSTRAINT petrichor_ai_binding_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_ai_binding
    ADD CONSTRAINT petrichor_ai_binding_user_id_purpose_key UNIQUE (user_id, purpose);

ALTER TABLE ONLY public.petrichor_ai_credential
    ADD CONSTRAINT petrichor_ai_credential_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_ai_credential
    ADD CONSTRAINT petrichor_ai_credential_user_id_name_key UNIQUE (user_id, name);

ALTER TABLE ONLY public.petrichor_ai_model
    ADD CONSTRAINT petrichor_ai_model_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_ai_model
    ADD CONSTRAINT petrichor_ai_model_provider_id_model_id_key UNIQUE (provider_id, model_id);

ALTER TABLE ONLY public.petrichor_ai_provider
    ADD CONSTRAINT petrichor_ai_provider_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_ai_provider
    ADD CONSTRAINT petrichor_ai_provider_user_id_name_key UNIQUE (user_id, name);

ALTER TABLE ONLY public.petrichor_ai_review
    ADD CONSTRAINT petrichor_ai_review_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_assistant_artifact
    ADD CONSTRAINT petrichor_assistant_artifact_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_assistant_confirmation
    ADD CONSTRAINT petrichor_assistant_confirmation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_assistant_message_embedding
    ADD CONSTRAINT petrichor_assistant_message_embedding_pkey PRIMARY KEY (message_id);

ALTER TABLE ONLY public.petrichor_assistant_message
    ADD CONSTRAINT petrichor_assistant_message_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_assistant_operator_profile
    ADD CONSTRAINT petrichor_assistant_operator_profile_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.petrichor_assistant_plan
    ADD CONSTRAINT petrichor_assistant_plan_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_assistant_run
    ADD CONSTRAINT petrichor_assistant_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_assistant_step
    ADD CONSTRAINT petrichor_assistant_step_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_assistant_thread
    ADD CONSTRAINT petrichor_assistant_thread_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sa_token_storage
    ADD CONSTRAINT sa_token_storage_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.petrichor_doc_chunk
    ADD CONSTRAINT petrichor_doc_chunk_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_doc_document
    ADD CONSTRAINT petrichor_doc_document_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_doc_folder
    ADD CONSTRAINT petrichor_doc_folder_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_doc_library
    ADD CONSTRAINT petrichor_doc_library_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_article_burn_link
    ADD CONSTRAINT petrichor_kb_article_burn_link_link_code_key UNIQUE (link_code);

ALTER TABLE ONLY public.petrichor_kb_article_burn_link
    ADD CONSTRAINT petrichor_kb_article_burn_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_article_chunk_index
    ADD CONSTRAINT petrichor_kb_article_chunk_index_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_article_chunk
    ADD CONSTRAINT petrichor_kb_article_chunk_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_article
    ADD CONSTRAINT petrichor_kb_article_node_id_key UNIQUE (node_id);

ALTER TABLE ONLY public.petrichor_kb_article
    ADD CONSTRAINT petrichor_kb_article_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_article_share
    ADD CONSTRAINT petrichor_kb_article_share_article_id_key UNIQUE (article_id);

ALTER TABLE ONLY public.petrichor_kb_article_share
    ADD CONSTRAINT petrichor_kb_article_share_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_article_share
    ADD CONSTRAINT petrichor_kb_article_share_share_code_key UNIQUE (share_code);

ALTER TABLE ONLY public.petrichor_kb_article_tag
    ADD CONSTRAINT petrichor_kb_article_tag_article_id_tag_key UNIQUE (article_id, tag);

ALTER TABLE ONLY public.petrichor_kb_article_tag
    ADD CONSTRAINT petrichor_kb_article_tag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_import_job_page
    ADD CONSTRAINT petrichor_kb_import_job_page_job_id_page_no_key UNIQUE (job_id, page_no);

ALTER TABLE ONLY public.petrichor_kb_import_job_page
    ADD CONSTRAINT petrichor_kb_import_job_page_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_import_job
    ADD CONSTRAINT petrichor_kb_import_job_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_knowledge_base
    ADD CONSTRAINT petrichor_kb_knowledge_base_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_node
    ADD CONSTRAINT petrichor_kb_node_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_wiki_event_log
    ADD CONSTRAINT petrichor_kb_wiki_event_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_wiki_link
    ADD CONSTRAINT petrichor_kb_wiki_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_wiki_page
    ADD CONSTRAINT petrichor_kb_wiki_page_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_wiki_page
    ADD CONSTRAINT petrichor_kb_wiki_page_user_id_knowledge_base_id_page_key_key UNIQUE (user_id, knowledge_base_id, page_key);

ALTER TABLE ONLY public.petrichor_kb_wiki_patch
    ADD CONSTRAINT petrichor_kb_wiki_patch_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_wiki_source_ref
    ADD CONSTRAINT petrichor_kb_wiki_source_ref_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_wiki_tree_node
    ADD CONSTRAINT petrichor_kb_wiki_tree_node_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_kb_wiki_tree_node
    ADD CONSTRAINT petrichor_kb_wiki_tree_node_user_id_knowledge_base_id_node__key UNIQUE (user_id, knowledge_base_id, node_key);

ALTER TABLE ONLY public.petrichor_notification
    ADD CONSTRAINT petrichor_notification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_public_qa_rate_limit
    ADD CONSTRAINT petrichor_public_qa_rate_limit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_site_about_profile
    ADD CONSTRAINT petrichor_site_about_profile_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_site_appearance
    ADD CONSTRAINT petrichor_site_appearance_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_site_graph_edge
    ADD CONSTRAINT petrichor_site_graph_edge_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_site_graph_merge_candidate
    ADD CONSTRAINT petrichor_site_graph_merge_candidate_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_site_graph_node
    ADD CONSTRAINT petrichor_site_graph_node_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_site_graph_run
    ADD CONSTRAINT petrichor_site_graph_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_site_project_showcase
    ADD CONSTRAINT petrichor_site_project_showcase_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.petrichor_user
    ADD CONSTRAINT petrichor_user_email_key UNIQUE (email);

ALTER TABLE ONLY public.petrichor_user
    ADD CONSTRAINT petrichor_user_pkey PRIMARY KEY (id);

CREATE INDEX idx_petrichor_agent_api_key_user ON public.petrichor_agent_api_key USING btree (user_id, revoked_at, created_at DESC);

CREATE INDEX idx_petrichor_agent_call_log_key_created ON public.petrichor_agent_call_log USING btree (api_key_id, created_at DESC);

CREATE INDEX idx_petrichor_agent_call_log_user_created ON public.petrichor_agent_call_log USING btree (user_id, created_at DESC);

CREATE INDEX idx_petrichor_agent_memory_user ON public.petrichor_agent_memory USING btree (user_id, last_seen_at DESC);

CREATE INDEX idx_petrichor_ai_binding_model ON public.petrichor_ai_binding USING btree (model_ref_id);

CREATE INDEX idx_petrichor_ai_credential_user ON public.petrichor_ai_credential USING btree (user_id);

CREATE INDEX idx_petrichor_ai_model_provider ON public.petrichor_ai_model USING btree (provider_id);

CREATE INDEX idx_petrichor_ai_model_user_kind ON public.petrichor_ai_model USING btree (user_id, kind);

CREATE INDEX idx_petrichor_ai_provider_credential ON public.petrichor_ai_provider USING btree (credential_id);

CREATE INDEX idx_petrichor_ai_provider_user ON public.petrichor_ai_provider USING btree (user_id);

CREATE INDEX idx_petrichor_ai_review_user_generated ON public.petrichor_ai_review USING btree (user_id, generated_at);

CREATE INDEX idx_petrichor_doc_chunk_document ON public.petrichor_doc_chunk USING btree (document_id, chunk_index);

CREATE INDEX idx_petrichor_doc_chunk_library ON public.petrichor_doc_chunk USING btree (library_id);

CREATE INDEX idx_petrichor_doc_chunk_text_trgm ON public.petrichor_doc_chunk USING gin (text public.gin_trgm_ops);

CREATE INDEX idx_petrichor_doc_document_user_lib ON public.petrichor_doc_document USING btree (user_id, library_id);

CREATE INDEX idx_petrichor_doc_folder_user_lib ON public.petrichor_doc_folder USING btree (user_id, library_id);

CREATE INDEX idx_petrichor_doc_library_user ON public.petrichor_doc_library USING btree (user_id);

CREATE INDEX idx_petrichor_kb_article_chunk_article ON public.petrichor_kb_article_chunk USING btree (user_id, knowledge_base_id, article_id, "position");

CREATE INDEX idx_petrichor_kb_article_chunk_index_chunk ON public.petrichor_kb_article_chunk_index USING btree (chunk_id, source_type, source_position);

CREATE INDEX idx_petrichor_kb_article_chunk_index_scope ON public.petrichor_kb_article_chunk_index USING btree (user_id, knowledge_base_id, source_type, article_id);

CREATE INDEX idx_petrichor_kb_article_content_md_trgm ON public.petrichor_kb_article USING gin (content_md public.gin_trgm_ops);

CREATE INDEX idx_petrichor_kb_article_public_excerpt_trgm ON public.petrichor_kb_article USING gin (public_excerpt public.gin_trgm_ops);

CREATE INDEX idx_petrichor_kb_article_title_trgm ON public.petrichor_kb_article USING gin (title public.gin_trgm_ops);

CREATE INDEX idx_petrichor_kb_import_job_page_job ON public.petrichor_kb_import_job_page USING btree (job_id);

CREATE INDEX idx_petrichor_kb_import_job_user ON public.petrichor_kb_import_job USING btree (user_id, created_at DESC);

CREATE INDEX idx_petrichor_kb_import_job_user_kb ON public.petrichor_kb_import_job USING btree (user_id, knowledge_base_id);

CREATE INDEX idx_petrichor_site_graph_edge_from ON public.petrichor_site_graph_edge USING btree (user_id, from_node_id);

CREATE INDEX idx_petrichor_site_graph_edge_status ON public.petrichor_site_graph_edge USING btree (user_id, status);

CREATE INDEX idx_petrichor_site_graph_edge_to ON public.petrichor_site_graph_edge USING btree (user_id, to_node_id);

CREATE INDEX idx_petrichor_site_graph_merge_candidate_status ON public.petrichor_site_graph_merge_candidate USING btree (user_id, status, score DESC);

CREATE INDEX idx_petrichor_site_graph_node_article ON public.petrichor_site_graph_node USING btree (article_id);

CREATE INDEX idx_petrichor_site_graph_node_parent ON public.petrichor_site_graph_node USING btree (user_id, parent_id, sort_order);

CREATE INDEX idx_petrichor_site_graph_node_status ON public.petrichor_site_graph_node USING btree (user_id, status, kind);

CREATE INDEX idx_petrichor_site_graph_run_user ON public.petrichor_site_graph_run USING btree (user_id, started_at DESC);

CREATE INDEX petrichor_agent_evidence_run_idx ON public.petrichor_agent_evidence USING btree (run_key, created_at);

CREATE INDEX petrichor_agent_run_conversation_idx ON public.petrichor_agent_run USING btree (conversation_id, started_at);

CREATE INDEX petrichor_agent_run_stop_reason_idx ON public.petrichor_agent_run USING btree (stop_reason, started_at);

CREATE INDEX petrichor_agent_run_user_idx ON public.petrichor_agent_run USING btree (user_id, started_at);

CREATE INDEX petrichor_agent_subtask_run_idx ON public.petrichor_agent_subtask USING btree (run_key, created_at);

CREATE INDEX petrichor_agent_trace_event_tool_idx ON public.petrichor_agent_trace_event USING btree (tool_id, created_at);

CREATE INDEX petrichor_agent_trace_event_type_idx ON public.petrichor_agent_trace_event USING btree (event_type, created_at);

CREATE INDEX petrichor_assistant_artifact_thread_idx ON public.petrichor_assistant_artifact USING btree (thread_id, created_at DESC);

CREATE INDEX petrichor_assistant_confirmation_thread_idx ON public.petrichor_assistant_confirmation USING btree (thread_id, user_id, status);

CREATE INDEX petrichor_assistant_message_embedding_fts_idx ON public.petrichor_assistant_message_embedding USING gin (to_tsvector('simple'::regconfig, COALESCE(excerpt_md, ''::text)));

CREATE INDEX petrichor_assistant_message_embedding_thread_idx ON public.petrichor_assistant_message_embedding USING btree (thread_id, user_id);

CREATE INDEX petrichor_assistant_message_thread_order_idx ON public.petrichor_assistant_message USING btree (thread_id, created_at, id);

CREATE INDEX petrichor_assistant_plan_thread_updated_idx ON public.petrichor_assistant_plan USING btree (thread_id, updated_at DESC);

CREATE INDEX petrichor_assistant_run_thread_idx ON public.petrichor_assistant_run USING btree (thread_id, started_at DESC);

CREATE INDEX petrichor_assistant_step_run_idx ON public.petrichor_assistant_step USING btree (run_id, step_index);

CREATE INDEX petrichor_assistant_thread_user_history_idx ON public.petrichor_assistant_thread USING btree (user_id, updated_at DESC, id DESC);

CREATE INDEX sa_token_storage_expires_at_idx ON public.sa_token_storage USING btree (expires_at) WHERE (expires_at IS NOT NULL);

CREATE INDEX petrichor_doc_document_folder_idx ON public.petrichor_doc_document USING btree (library_id, folder_id);

CREATE INDEX petrichor_doc_document_status_idx ON public.petrichor_doc_document USING btree (user_id, status);

CREATE INDEX petrichor_doc_folder_parent_idx ON public.petrichor_doc_folder USING btree (library_id, parent_id, sort_order);

CREATE INDEX petrichor_doc_library_user_updated_idx ON public.petrichor_doc_library USING btree (user_id, updated_at);

CREATE INDEX petrichor_kb_article_chunk_index_search_idx ON public.petrichor_kb_article_chunk_index USING gin (search_vector);

CREATE INDEX petrichor_kb_article_kb_updated_idx ON public.petrichor_kb_article USING btree (knowledge_base_id, updated_at DESC);

CREATE INDEX petrichor_kb_article_public_updated_idx ON public.petrichor_kb_article USING btree (updated_at DESC, id DESC);

CREATE INDEX petrichor_kb_article_share_pin_idx ON public.petrichor_kb_article_share USING btree (pin_order);

CREATE INDEX petrichor_kb_article_share_public_idx ON public.petrichor_kb_article_share USING btree (enabled, revoked_at, article_id);

CREATE INDEX petrichor_kb_article_share_user_id_idx ON public.petrichor_kb_article_share USING btree (user_id);

CREATE INDEX petrichor_kb_article_tag_article_idx ON public.petrichor_kb_article_tag USING btree (article_id);

CREATE INDEX petrichor_kb_article_user_created_idx ON public.petrichor_kb_article USING btree (user_id, created_at DESC);

CREATE INDEX petrichor_kb_article_user_kb_idx ON public.petrichor_kb_article USING btree (user_id, knowledge_base_id);

CREATE INDEX petrichor_kb_burn_link_article_idx ON public.petrichor_kb_article_burn_link USING btree (user_id, article_id, created_at);

CREATE INDEX petrichor_kb_knowledge_base_user_id_idx ON public.petrichor_kb_knowledge_base USING btree (user_id);

CREATE INDEX petrichor_kb_knowledge_base_user_updated_idx ON public.petrichor_kb_knowledge_base USING btree (user_id, updated_at DESC);

CREATE INDEX petrichor_kb_node_kb_parent_order_idx ON public.petrichor_kb_node USING btree (knowledge_base_id, parent_id, sort_order);

CREATE INDEX petrichor_kb_node_user_kb_order_idx ON public.petrichor_kb_node USING btree (user_id, knowledge_base_id, sort_order, id);

CREATE INDEX petrichor_kb_wiki_event_log_kb_idx ON public.petrichor_kb_wiki_event_log USING btree (user_id, knowledge_base_id, created_at DESC);

CREATE INDEX petrichor_kb_wiki_link_from_idx ON public.petrichor_kb_wiki_link USING btree (from_page_id);

CREATE INDEX petrichor_kb_wiki_link_to_idx ON public.petrichor_kb_wiki_link USING btree (user_id, knowledge_base_id, to_page_key);

CREATE INDEX petrichor_kb_wiki_page_kb_kind_idx ON public.petrichor_kb_wiki_page USING btree (user_id, knowledge_base_id, kind);

CREATE INDEX petrichor_kb_wiki_page_updated_idx ON public.petrichor_kb_wiki_page USING btree (user_id, knowledge_base_id, updated_at DESC);

CREATE INDEX petrichor_kb_wiki_patch_status_idx ON public.petrichor_kb_wiki_patch USING btree (user_id, knowledge_base_id, status);

CREATE INDEX petrichor_kb_wiki_source_ref_article_idx ON public.petrichor_kb_wiki_source_ref USING btree (article_id);

CREATE INDEX petrichor_kb_wiki_source_ref_page_idx ON public.petrichor_kb_wiki_source_ref USING btree (page_id);

CREATE INDEX petrichor_kb_wiki_tree_node_article_idx ON public.petrichor_kb_wiki_tree_node USING btree (article_id);

CREATE INDEX petrichor_kb_wiki_tree_node_kb_idx ON public.petrichor_kb_wiki_tree_node USING btree (user_id, knowledge_base_id, "position");

CREATE INDEX petrichor_kb_wiki_tree_node_page_idx ON public.petrichor_kb_wiki_tree_node USING btree (page_id);

CREATE INDEX petrichor_kb_wiki_tree_node_search_idx ON public.petrichor_kb_wiki_tree_node USING gin (search_vector);

CREATE INDEX petrichor_notification_biz_idx ON public.petrichor_notification USING btree (user_id, biz_type, biz_id);

CREATE INDEX petrichor_notification_user_category_idx ON public.petrichor_notification USING btree (user_id, category);

CREATE INDEX petrichor_notification_user_created_idx ON public.petrichor_notification USING btree (user_id, created_at DESC, id DESC);

CREATE INDEX petrichor_notification_user_read_idx ON public.petrichor_notification USING btree (user_id, read_at);

CREATE UNIQUE INDEX ux_petrichor_agent_api_key_hash ON public.petrichor_agent_api_key USING btree (key_hash);

CREATE UNIQUE INDEX ux_petrichor_agent_evidence_key ON public.petrichor_agent_evidence USING btree (run_key, evidence_key);

CREATE UNIQUE INDEX ux_petrichor_agent_run_key ON public.petrichor_agent_run USING btree (run_key);

CREATE UNIQUE INDEX ux_petrichor_agent_subtask_key ON public.petrichor_agent_subtask USING btree (run_key, task_key);

CREATE UNIQUE INDEX ux_petrichor_agent_trace_event_seq ON public.petrichor_agent_trace_event USING btree (run_key, sequence);

CREATE UNIQUE INDEX ux_petrichor_ai_review_user_period ON public.petrichor_ai_review USING btree (user_id, period, period_key);

CREATE UNIQUE INDEX ux_petrichor_assistant_confirmation_key ON public.petrichor_assistant_confirmation USING btree (confirmation_key);

CREATE UNIQUE INDEX ux_petrichor_assistant_plan_thread_key ON public.petrichor_assistant_plan USING btree (thread_id, plan_key);

CREATE UNIQUE INDEX ux_petrichor_kb_article_chunk_index_source ON public.petrichor_kb_article_chunk_index USING btree (user_id, article_id, source_key);

CREATE UNIQUE INDEX ux_petrichor_kb_article_chunk_key ON public.petrichor_kb_article_chunk USING btree (user_id, article_id, chunk_key);

CREATE UNIQUE INDEX ux_petrichor_public_qa_rate_limit_bucket ON public.petrichor_public_qa_rate_limit USING btree (bucket_key);

CREATE UNIQUE INDEX ux_petrichor_site_graph_edge_triple ON public.petrichor_site_graph_edge USING btree (user_id, from_node_id, to_node_id, relation);

CREATE UNIQUE INDEX ux_petrichor_site_graph_merge_candidate_pair ON public.petrichor_site_graph_merge_candidate USING btree (user_id, source_key, target_key);

CREATE UNIQUE INDEX ux_petrichor_site_graph_node_key ON public.petrichor_site_graph_node USING btree (user_id, node_key);

CREATE UNIQUE INDEX ux_petrichor_user_linuxdo_account_id ON public.petrichor_user USING btree (linuxdo_account_id) WHERE (linuxdo_account_id IS NOT NULL);

ALTER TABLE ONLY public.petrichor_agent_api_key
    ADD CONSTRAINT petrichor_agent_api_key_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_agent_call_log
    ADD CONSTRAINT petrichor_agent_call_log_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.petrichor_agent_api_key(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_agent_call_log
    ADD CONSTRAINT petrichor_agent_call_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_ai_binding
    ADD CONSTRAINT petrichor_ai_binding_model_ref_id_fkey FOREIGN KEY (model_ref_id) REFERENCES public.petrichor_ai_model(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_ai_binding
    ADD CONSTRAINT petrichor_ai_binding_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_ai_credential
    ADD CONSTRAINT petrichor_ai_credential_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_ai_model
    ADD CONSTRAINT petrichor_ai_model_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.petrichor_ai_provider(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_ai_model
    ADD CONSTRAINT petrichor_ai_model_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_ai_provider
    ADD CONSTRAINT petrichor_ai_provider_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.petrichor_ai_credential(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.petrichor_ai_provider
    ADD CONSTRAINT petrichor_ai_provider_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_assistant_artifact
    ADD CONSTRAINT petrichor_assistant_artifact_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.petrichor_assistant_run(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.petrichor_assistant_artifact
    ADD CONSTRAINT petrichor_assistant_artifact_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.petrichor_assistant_thread(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_assistant_confirmation
    ADD CONSTRAINT petrichor_assistant_confirmation_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.petrichor_assistant_thread(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_assistant_message_embedding
    ADD CONSTRAINT petrichor_assistant_message_embedding_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.petrichor_assistant_message(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_assistant_message
    ADD CONSTRAINT petrichor_assistant_message_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.petrichor_assistant_thread(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_assistant_plan
    ADD CONSTRAINT petrichor_assistant_plan_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.petrichor_assistant_thread(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_assistant_run
    ADD CONSTRAINT petrichor_assistant_run_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.petrichor_assistant_thread(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_assistant_step
    ADD CONSTRAINT petrichor_assistant_step_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.petrichor_assistant_run(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_chunk
    ADD CONSTRAINT petrichor_doc_chunk_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.petrichor_doc_document(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_chunk
    ADD CONSTRAINT petrichor_doc_chunk_library_id_fkey FOREIGN KEY (library_id) REFERENCES public.petrichor_doc_library(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_chunk
    ADD CONSTRAINT petrichor_doc_chunk_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_document
    ADD CONSTRAINT petrichor_doc_document_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.petrichor_doc_folder(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.petrichor_doc_document
    ADD CONSTRAINT petrichor_doc_document_library_id_fkey FOREIGN KEY (library_id) REFERENCES public.petrichor_doc_library(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_document
    ADD CONSTRAINT petrichor_doc_document_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_folder
    ADD CONSTRAINT petrichor_doc_folder_library_id_fkey FOREIGN KEY (library_id) REFERENCES public.petrichor_doc_library(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_folder
    ADD CONSTRAINT petrichor_doc_folder_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.petrichor_doc_folder(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_folder
    ADD CONSTRAINT petrichor_doc_folder_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_doc_library
    ADD CONSTRAINT petrichor_doc_library_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_burn_link
    ADD CONSTRAINT petrichor_kb_article_burn_link_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_burn_link
    ADD CONSTRAINT petrichor_kb_article_burn_link_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_chunk
    ADD CONSTRAINT petrichor_kb_article_chunk_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_chunk_index
    ADD CONSTRAINT petrichor_kb_article_chunk_index_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_chunk_index
    ADD CONSTRAINT petrichor_kb_article_chunk_index_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES public.petrichor_kb_article_chunk(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_chunk_index
    ADD CONSTRAINT petrichor_kb_article_chunk_index_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_chunk_index
    ADD CONSTRAINT petrichor_kb_article_chunk_index_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_chunk
    ADD CONSTRAINT petrichor_kb_article_chunk_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_chunk
    ADD CONSTRAINT petrichor_kb_article_chunk_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article
    ADD CONSTRAINT petrichor_kb_article_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article
    ADD CONSTRAINT petrichor_kb_article_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.petrichor_kb_node(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_share
    ADD CONSTRAINT petrichor_kb_article_share_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_share
    ADD CONSTRAINT petrichor_kb_article_share_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article_tag
    ADD CONSTRAINT petrichor_kb_article_tag_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_article
    ADD CONSTRAINT petrichor_kb_article_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_import_job
    ADD CONSTRAINT petrichor_kb_import_job_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.petrichor_kb_import_job
    ADD CONSTRAINT petrichor_kb_import_job_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_import_job_page
    ADD CONSTRAINT petrichor_kb_import_job_page_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.petrichor_kb_import_job(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_import_job
    ADD CONSTRAINT petrichor_kb_import_job_parent_node_id_fkey FOREIGN KEY (parent_node_id) REFERENCES public.petrichor_kb_node(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.petrichor_kb_import_job
    ADD CONSTRAINT petrichor_kb_import_job_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_knowledge_base
    ADD CONSTRAINT petrichor_kb_knowledge_base_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_node
    ADD CONSTRAINT petrichor_kb_node_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_node
    ADD CONSTRAINT petrichor_kb_node_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.petrichor_kb_node(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_node
    ADD CONSTRAINT petrichor_kb_node_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_event_log
    ADD CONSTRAINT petrichor_kb_wiki_event_log_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_event_log
    ADD CONSTRAINT petrichor_kb_wiki_event_log_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.petrichor_kb_wiki_page(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.petrichor_kb_wiki_event_log
    ADD CONSTRAINT petrichor_kb_wiki_event_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_link
    ADD CONSTRAINT petrichor_kb_wiki_link_from_page_id_fkey FOREIGN KEY (from_page_id) REFERENCES public.petrichor_kb_wiki_page(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_link
    ADD CONSTRAINT petrichor_kb_wiki_link_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_link
    ADD CONSTRAINT petrichor_kb_wiki_link_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_page
    ADD CONSTRAINT petrichor_kb_wiki_page_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_page
    ADD CONSTRAINT petrichor_kb_wiki_page_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_patch
    ADD CONSTRAINT petrichor_kb_wiki_patch_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_patch
    ADD CONSTRAINT petrichor_kb_wiki_patch_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_source_ref
    ADD CONSTRAINT petrichor_kb_wiki_source_ref_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_source_ref
    ADD CONSTRAINT petrichor_kb_wiki_source_ref_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.petrichor_kb_wiki_page(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_tree_node
    ADD CONSTRAINT petrichor_kb_wiki_tree_node_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_tree_node
    ADD CONSTRAINT petrichor_kb_wiki_tree_node_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.petrichor_kb_knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_tree_node
    ADD CONSTRAINT petrichor_kb_wiki_tree_node_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.petrichor_kb_wiki_page(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_kb_wiki_tree_node
    ADD CONSTRAINT petrichor_kb_wiki_tree_node_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_notification
    ADD CONSTRAINT petrichor_notification_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_site_graph_edge
    ADD CONSTRAINT petrichor_site_graph_edge_from_node_id_fkey FOREIGN KEY (from_node_id) REFERENCES public.petrichor_site_graph_node(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_site_graph_edge
    ADD CONSTRAINT petrichor_site_graph_edge_to_node_id_fkey FOREIGN KEY (to_node_id) REFERENCES public.petrichor_site_graph_node(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_site_graph_edge
    ADD CONSTRAINT petrichor_site_graph_edge_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_site_graph_merge_candidate
    ADD CONSTRAINT petrichor_site_graph_merge_candidate_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_site_graph_node
    ADD CONSTRAINT petrichor_site_graph_node_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.petrichor_kb_article(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.petrichor_site_graph_node
    ADD CONSTRAINT petrichor_site_graph_node_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.petrichor_site_graph_node(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.petrichor_site_graph_node
    ADD CONSTRAINT petrichor_site_graph_node_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.petrichor_site_graph_run
    ADD CONSTRAINT petrichor_site_graph_run_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.petrichor_user(id) ON DELETE CASCADE;


-- 不写入默认账号。首次启动后由 /api/auth/setup 创建唯一的初始超级管理员。
