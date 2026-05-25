-- 移除独立 Todo、普通 AI 聊天和基于 pgvector 的 RAG/向量入库对象。
-- 执行前请确认这些功能已从应用层下线，且相关历史数据不再需要保留。

do $$
declare
    fn record;
begin
    for fn in
        select
            n.nspname as schema_name,
            p.proname as function_name,
            pg_get_function_identity_arguments(p.oid) as arguments
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'match_kb_embedding_chunks'
    loop
        execute format(
            'drop function if exists %I.%I(%s)',
            fn.schema_name,
            fn.function_name,
            fn.arguments
        );
    end loop;
end $$;

drop table if exists petrichor_kb_embedding_chunk cascade;
drop table if exists petrichor_kb_article_embedding cascade;
drop table if exists petrichor_kb_embedding_task cascade;

drop table if exists petrichor_ai_chat_feedback cascade;
drop table if exists petrichor_ai_chat_run_event cascade;
drop table if exists petrichor_ai_chat_run cascade;
drop table if exists petrichor_ai_chat_message cascade;
drop table if exists petrichor_ai_chat_session cascade;

drop table if exists petrichor_task_tag cascade;
drop table if exists petrichor_tag cascade;
drop table if exists petrichor_task cascade;
drop table if exists petrichor_list cascade;

delete from petrichor_ai_model_config
where config_type <> 'CHAT';

alter table if exists petrichor_ai_model_config
    drop column if exists embedding_dimensions;
