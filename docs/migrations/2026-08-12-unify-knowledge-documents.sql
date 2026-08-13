-- 将文件语料能力并入知识库，并搬迁旧文档库的目录、文件与分片。
-- 本文件不删除旧表；核对数据后再单独执行 remove-document-library-and-site-graph 迁移。

alter table petrichor_kb_knowledge_base
    add column if not exists chunk_strategy text not null default 'auto',
    add column if not exists chunk_size integer not null default 512,
    add column if not exists chunk_overlap integer not null default 80,
    add column if not exists chunk_separators_json text,
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
    summary text,
    error text,
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
    text text not null,
    char_count integer not null default 0,
    token_estimate integer not null default 0,
    embedding vector(1024),
    created_at timestamptz not null default now(),
    unique (document_id, chunk_index)
);

create index if not exists petrichor_kb_document_chunk_kb_idx
    on petrichor_kb_document_chunk(knowledge_base_id);
create index if not exists petrichor_kb_document_chunk_text_trgm_idx
    on petrichor_kb_document_chunk using gin (text gin_trgm_ops);
create index if not exists petrichor_kb_document_chunk_embedding_idx
    on petrichor_kb_document_chunk using hnsw (embedding vector_cosine_ops);

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

-- 旧文档库数据搬迁。整个事务失败会完整回滚，不留下半迁移数据。
-- 该段只应执行一次；旧表清理前可用文末核对 SQL 验证数量。
do $migration$
declare
    source_library record;
    source_folder record;
    source_document record;
    target_id bigint;
begin
    if to_regclass('public.petrichor_doc_library') is null then
        return;
    end if;

    create temporary table migration_doc_library_map (
        source_id bigint primary key,
        target_id bigint not null unique
    ) on commit drop;
    create temporary table migration_doc_folder_map (
        source_id bigint primary key,
        target_id bigint not null unique
    ) on commit drop;
    create temporary table migration_doc_document_map (
        source_id bigint primary key,
        target_id bigint not null unique
    ) on commit drop;

    for source_library in
        select * from petrichor_doc_library order by id
    loop
        insert into petrichor_kb_knowledge_base (
            user_id, name, description, chunk_strategy, chunk_size, chunk_overlap,
            wiki_enabled, created_at, updated_at
        ) values (
            source_library.user_id,
            source_library.name,
            source_library.description,
            'recursive', 700, 100,
            false,
            source_library.created_at,
            source_library.updated_at
        ) returning id into target_id;
        insert into migration_doc_library_map values (source_library.id, target_id);
    end loop;

    for source_folder in
        select * from petrichor_doc_folder order by id
    loop
        insert into petrichor_kb_document_folder (
            user_id, knowledge_base_id, parent_id, name, sort_order, created_at, updated_at
        ) values (
            source_folder.user_id,
            (select library_map.target_id
             from migration_doc_library_map library_map
             where library_map.source_id = source_folder.library_id),
            null,
            source_folder.name,
            source_folder.sort_order,
            source_folder.created_at,
            source_folder.updated_at
        ) returning id into target_id;
        insert into migration_doc_folder_map values (source_folder.id, target_id);
    end loop;

    update petrichor_kb_document_folder target
    set parent_id = parent_map.target_id
    from petrichor_doc_folder source
    join migration_doc_folder_map self_map on self_map.source_id = source.id
    join migration_doc_folder_map parent_map on parent_map.source_id = source.parent_id
    where target.id = self_map.target_id;

    for source_document in
        select * from petrichor_doc_document order by id
    loop
        insert into petrichor_kb_document (
            user_id, knowledge_base_id, folder_id, file_name, title, file_type,
            content_type, object_key, size_bytes, page_count, char_count, chunk_count,
            status, blocks_json, summary, error, created_at, updated_at
        ) values (
            source_document.user_id,
            (select library_map.target_id
             from migration_doc_library_map library_map
             where library_map.source_id = source_document.library_id),
            (select folder_map.target_id
             from migration_doc_folder_map folder_map
             where folder_map.source_id = source_document.folder_id),
            source_document.file_name,
            source_document.title,
            source_document.file_type,
            source_document.content_type,
            source_document.object_key,
            source_document.size_bytes,
            source_document.page_count,
            source_document.char_count,
            0,
            source_document.status,
            source_document.blocks_json,
            source_document.summary,
            source_document.error,
            source_document.created_at,
            source_document.updated_at
        ) returning id into target_id;
        insert into migration_doc_document_map values (source_document.id, target_id);
    end loop;

    insert into petrichor_kb_document_chunk (
        user_id, knowledge_base_id, document_id, chunk_index, locator, page,
        text, char_count, token_estimate, created_at
    )
    select
        source.user_id,
        library_map.target_id,
        document_map.target_id,
        source.chunk_index,
        source.locator,
        source.page,
        source.text,
        char_length(source.text),
        greatest(1, ceil(char_length(source.text)::numeric / 4)::integer),
        source.created_at
    from petrichor_doc_chunk source
    join migration_doc_library_map library_map on library_map.source_id = source.library_id
    join migration_doc_document_map document_map on document_map.source_id = source.document_id
    order by source.document_id, source.chunk_index;

    update petrichor_kb_document target
    set chunk_count = counts.chunk_count
    from (
        select document_id, count(*)::integer as chunk_count
        from petrichor_kb_document_chunk
        where document_id in (
            select document_map.target_id
            from migration_doc_document_map document_map
        )
        group by document_id
    ) counts
    where target.id = counts.document_id;

    if (select count(*) from migration_doc_library_map) <> (select count(*) from petrichor_doc_library) then
        raise exception '旧文档库搬迁数量不一致';
    end if;
    if (select count(*) from migration_doc_folder_map) <> (select count(*) from petrichor_doc_folder) then
        raise exception '旧目录搬迁数量不一致';
    end if;
    if (select count(*) from migration_doc_document_map) <> (select count(*) from petrichor_doc_document) then
        raise exception '旧文件搬迁数量不一致';
    end if;
    if (
        select count(*)
        from petrichor_kb_document_chunk
        where document_id in (
            select document_map.target_id
            from migration_doc_document_map document_map
        )
    ) <> (select count(*) from petrichor_doc_chunk) then
        raise exception '旧分片搬迁数量不一致';
    end if;
end
$migration$;

-- 清理前人工核对：matched_count 应等于 source_count；target_total_count 可更大。
select 'library' as kind,
       (select count(*) from petrichor_doc_library) as source_count,
       (select count(*) from petrichor_kb_knowledge_base) as target_total_count;
select 'document' as kind,
       (select count(*) from petrichor_doc_document) as source_count,
       (select count(*) from petrichor_kb_document) as target_total_count,
       (select count(*) from petrichor_doc_document source where exists (
           select 1 from petrichor_kb_document target
           where target.user_id = source.user_id
             and target.object_key = source.object_key
             and target.file_name = source.file_name
       )) as matched_count;
select 'chunk' as kind,
       (select count(*) from petrichor_doc_chunk) as source_count,
       (select count(*) from petrichor_kb_document_chunk) as target_total_count,
       (select count(*) from petrichor_doc_chunk source where exists (
           select 1
           from petrichor_doc_document source_document
           join petrichor_kb_document target_document
             on target_document.user_id = source_document.user_id
            and target_document.object_key = source_document.object_key
            and target_document.file_name = source_document.file_name
           join petrichor_kb_document_chunk target_chunk
             on target_chunk.document_id = target_document.id
            and target_chunk.chunk_index = source.chunk_index
           where source_document.id = source.document_id
       )) as matched_count;
