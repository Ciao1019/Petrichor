-- AI 模型配置重建：单表 petrichor_ai_model_config 拆成四层结构
--
--   petrichor_ai_credential  API Key 凭证库（单独管理，可被多个供应商复用）
--   petrichor_ai_provider    供应商实例（目录 key + 凭证 + 可覆盖 BaseUrl）
--   petrichor_ai_model       该供应商下已启用的模型（由「获取模型列表」写入）
--   petrichor_ai_binding     用途绑定（CHAT / VISION / DOC_QA / EMBEDDING 各绑一个模型）
--
-- 存量数据不迁移：旧表的 protocol 枚举只有 5 个值，无法可靠映射到新目录的 30 个供应商，
-- 且旧表把 Key 和模型耦合在一条记录里。执行后需要在「模型配置」页重新接入。
-- 执行前请确认已备份，并确认连接的是目标库。

begin;

drop table if exists petrichor_ai_model_config;

create table if not exists petrichor_ai_credential (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    name text not null,
    provider_key text,
    api_key_enc text not null,
    extra_enc text,
    last_used_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, name)
);

create index if not exists idx_petrichor_ai_credential_user
    on petrichor_ai_credential(user_id);

create table if not exists petrichor_ai_provider (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    provider_key text not null,
    name text not null,
    base_url text,
    credential_id bigint not null references petrichor_ai_credential(id) on delete restrict,
    enabled boolean not null default true,
    headers_json text,
    options_json text,
    last_checked_at timestamptz,
    last_check_status text,
    last_check_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, name)
);

create index if not exists idx_petrichor_ai_provider_user
    on petrichor_ai_provider(user_id);

create index if not exists idx_petrichor_ai_provider_credential
    on petrichor_ai_provider(credential_id);

create table if not exists petrichor_ai_model (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    provider_id bigint not null references petrichor_ai_provider(id) on delete cascade,
    model_id text not null,
    display_name text,
    kind text not null,
    context_window integer,
    -- 向量模型的输出维度：由一次真实 embed 调用探测得到，探测前为 null
    dimensions integer,
    capabilities_json text,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (provider_id, model_id)
);

create index if not exists idx_petrichor_ai_model_user_kind
    on petrichor_ai_model(user_id, kind);

create index if not exists idx_petrichor_ai_model_provider
    on petrichor_ai_model(provider_id);

create table if not exists petrichor_ai_binding (
    id bigint generated always as identity primary key,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    purpose text not null,
    model_ref_id bigint not null references petrichor_ai_model(id) on delete cascade,
    options_json text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, purpose)
);

create index if not exists idx_petrichor_ai_binding_model
    on petrichor_ai_binding(model_ref_id);

-- assistant_run / kb_import_job / ai_review 上的 model_config_id 语义改为指向
-- petrichor_ai_model.id（这三处都没有外键约束，无需改结构）。旧值会成为悬空引用，
-- 解析时找不到就回落到用途绑定，因此这里直接清空，避免误命中新表的同号记录。
update petrichor_assistant_run set model_config_id = null where model_config_id is not null;
update petrichor_kb_import_job set model_config_id = null where model_config_id is not null;
update petrichor_ai_review set model_config_id = null where model_config_id is not null;

commit;
