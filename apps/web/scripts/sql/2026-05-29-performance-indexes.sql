-- ============================================================
-- 性能索引补充（针对 知识库列表 / 知识库树 / 文章列表 / 文章详情 / 首页可视化 / 历史对话）
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 使用 CREATE INDEX CONCURRENTLY，建索引期间不阻塞表的读写。
-- 注意：CONCURRENTLY 不能在事务块中执行，需要【逐条】运行
--      （Supabase SQL Editor 请一条条执行，或用 psql 单条发送）。
-- 全部 IF NOT EXISTS，可安全重复执行。
-- ============================================================

-- 1) 知识库列表：where user_id order by updated_at desc
create index concurrently if not exists petrichor_kb_knowledge_base_user_updated_idx
    on petrichor_kb_knowledge_base (user_id, updated_at desc);

-- 2) 知识库树加载：where user_id + knowledge_base_id order by sort_order, id
create index concurrently if not exists petrichor_kb_node_user_kb_order_idx
    on petrichor_kb_node (user_id, knowledge_base_id, sort_order, id);

-- 3) 文章按库过滤：列表 / 按库删除 / 内容分布统计 where user_id + knowledge_base_id
create index concurrently if not exists petrichor_kb_article_user_kb_idx
    on petrichor_kb_article (user_id, knowledge_base_id);

-- 4) 首页文章热力图/趋势 + 文章计数：where user_id + created_at 时间范围
create index concurrently if not exists petrichor_kb_article_user_created_idx
    on petrichor_kb_article (user_id, created_at desc);

-- 5) 首页问答趋势：where user_id + created_at 时间范围
create index concurrently if not exists petrichor_kb_agent_thread_user_created_idx
    on petrichor_kb_agent_thread (user_id, created_at desc);

-- 6) 历史对话列表：where user_id order by updated_at desc, id desc
create index concurrently if not exists petrichor_kb_agent_thread_user_history_idx
    on petrichor_kb_agent_thread (user_id, updated_at desc, id desc);

-- 7) 历史对话列表：where user_id + knowledge_base_id order by updated_at desc, id desc
create index concurrently if not exists petrichor_kb_agent_thread_scope_history_idx
    on petrichor_kb_agent_thread (user_id, knowledge_base_id, updated_at desc, id desc);

-- 8) 历史对话详情：where thread_id order by created_at asc, id asc
create index concurrently if not exists petrichor_kb_agent_message_thread_order_idx
    on petrichor_kb_agent_message (thread_id, created_at asc, id asc);

-- 建完可执行 ANALYZE 让规划器尽快更新统计信息：
-- analyze petrichor_kb_knowledge_base;
-- analyze petrichor_kb_node;
-- analyze petrichor_kb_article;
-- analyze petrichor_kb_agent_thread;
-- analyze petrichor_kb_agent_message;
