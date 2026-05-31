-- ============================================================
-- 移除 Agent 调用日志的「调用来源」字段（agent_source / agent_tool）
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：外部 Agent 调用不再要求 X-Petrichor-Agent-Source / X-Petrichor-Agent-Tool
--      请求头，调用日志也不再记录来源，故删除对应列与索引。
-- 全部 IF EXISTS，可安全重复执行；删除列会丢弃历史来源数据。
-- ============================================================

-- 1) 先删依赖 agent_source 的复合索引（user_id, agent_source, created_at）
drop index if exists idx_petrichor_agent_call_log_source_created;

-- 2) 删除来源相关列
alter table petrichor_agent_call_log
    drop column if exists agent_source,
    drop column if exists agent_tool;
