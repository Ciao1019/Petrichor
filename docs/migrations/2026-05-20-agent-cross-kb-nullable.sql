-- 增量迁移：允许文档问答 Agent 相关表的 knowledge_base_id 为 NULL，以支持「全部知识库」跨 KB 对话。
-- 幂等：DROP NOT NULL 在已是 NULL 的列上执行不会报错。

ALTER TABLE IF EXISTS petrichor_kb_agent_thread
    ALTER COLUMN knowledge_base_id DROP NOT NULL;

ALTER TABLE IF EXISTS petrichor_kb_agent_message
    ALTER COLUMN knowledge_base_id DROP NOT NULL;

ALTER TABLE IF EXISTS petrichor_kb_agent_run
    ALTER COLUMN knowledge_base_id DROP NOT NULL;

ALTER TABLE IF EXISTS petrichor_kb_agent_step
    ALTER COLUMN knowledge_base_id DROP NOT NULL;

ALTER TABLE IF EXISTS petrichor_kb_agent_artifact
    ALTER COLUMN knowledge_base_id DROP NOT NULL;

-- 跨 KB 列表查询需要按用户单列查询，新增一个不依赖 knowledge_base_id 的索引。
CREATE INDEX IF NOT EXISTS petrichor_kb_agent_thread_user_idx
    ON petrichor_kb_agent_thread (user_id, updated_at DESC);
