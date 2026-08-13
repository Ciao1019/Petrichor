-- 破坏性清理：仅在完成 2026-08-12-unify-knowledge-documents.sql、核对数据并备份后执行。
-- 本文件不会由应用自动执行。

begin;

do $guard$
begin
    if to_regclass('public.petrichor_doc_document') is not null and exists (
        select 1
        from petrichor_doc_document source
        where not exists (
            select 1
            from petrichor_kb_document target
            where target.user_id = source.user_id
              and target.object_key = source.object_key
              and target.file_name = source.file_name
        )
    ) then
        raise exception '仍有旧文档未搬迁，停止删除旧表';
    end if;
end
$guard$;

drop table if exists petrichor_doc_qa_artifact cascade;
drop table if exists petrichor_doc_qa_step cascade;
drop table if exists petrichor_doc_qa_run cascade;
drop table if exists petrichor_doc_qa_message cascade;
drop table if exists petrichor_doc_qa_thread cascade;
drop table if exists petrichor_doc_chunk cascade;
drop table if exists petrichor_doc_document cascade;
drop table if exists petrichor_doc_folder cascade;
drop table if exists petrichor_doc_library cascade;

drop table if exists petrichor_site_graph_merge_candidate cascade;
drop table if exists petrichor_site_graph_edge cascade;
drop table if exists petrichor_site_graph_node cascade;
drop table if exists petrichor_site_graph_run cascade;

-- 删除旧的“文章编译 Wiki”平行体系。保留 Wiki 页面、页面双链和文件分片引用，
-- 执行后应从知识库文件重新构建 Wiki，以清除旧文章来源页面。
drop table if exists petrichor_kb_wiki_event_log cascade;
drop table if exists petrichor_kb_wiki_patch cascade;
drop table if exists petrichor_kb_wiki_tree_node cascade;
drop table if exists petrichor_kb_wiki_source_ref cascade;

delete from petrichor_kb_wiki_link link
where exists (
    select 1
    from petrichor_kb_wiki_page legacy
    where (
        legacy.kind not in ('index', 'source', 'concept')
        or legacy.page_key ~ '^source-[0-9]+$'
    )
    and (
        legacy.id = link.from_page_id
        or (
            legacy.user_id = link.user_id
            and legacy.knowledge_base_id = link.knowledge_base_id
            and legacy.page_key = link.to_page_key
        )
    )
);

delete from petrichor_kb_wiki_page
where kind not in ('index', 'source', 'concept')
   or page_key ~ '^source-[0-9]+$';

alter table if exists petrichor_kb_article
    drop column if exists mindmap_kg_json,
    drop column if exists mindmap_kg_content_hash,
    drop column if exists mindmap_kg_generated_at;

commit;
