-- 增量迁移：优化历史对话列表和详情查询索引。
-- 适用：已有数据的线上库（Supabase / Postgres）。
--
-- 注意：CREATE INDEX CONCURRENTLY 不能在事务块中执行。
-- Supabase SQL Editor 请逐条执行，或用 psql 单条发送。
-- 全部 IF NOT EXISTS，可安全重复执行。

-- 历史对话列表：全部范围 where user_id order by updated_at desc, id desc
CREATE INDEX CONCURRENTLY IF NOT EXISTS petrichor_kb_agent_thread_user_history_idx
    ON petrichor_kb_agent_thread (user_id, updated_at DESC, id DESC);

-- 历史对话列表：知识库/跨库范围 where user_id + knowledge_base_id order by updated_at desc, id desc
CREATE INDEX CONCURRENTLY IF NOT EXISTS petrichor_kb_agent_thread_scope_history_idx
    ON petrichor_kb_agent_thread (user_id, knowledge_base_id, updated_at DESC, id DESC);

-- 历史对话详情：where thread_id order by created_at asc, id asc
CREATE INDEX CONCURRENTLY IF NOT EXISTS petrichor_kb_agent_message_thread_order_idx
    ON petrichor_kb_agent_message (thread_id, created_at ASC, id ASC);

-- 建完可执行 ANALYZE 让规划器尽快更新统计信息：
-- ANALYZE petrichor_kb_agent_thread;
-- ANALYZE petrichor_kb_agent_message;
