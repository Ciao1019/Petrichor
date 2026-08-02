-- 移除「操作员记忆与进化」面板对应的两张表。
--
-- 背景：该面板包含「待审批 Skills」「手动进化」「待处理进化提案」三节，
-- 上线以来未产生任何数据（三张表均 0 行），整体移除。
--
-- 保留：
--   petrichor_assistant_operator_profile —— 操作员长期记忆本体，chat-handler 在用
--   petrichor_assistant_operator_skill   —— skill 目录，chat-handler / load_skill 读取
--
-- 说明：随面板一并移除的还有助手的 skill_manage 工具——它的写入路径全部指向
-- 待审批队列，而唯一的审批入口就是这个面板，留着会变成「永远待审批」的黑洞。
-- 因此 petrichor_assistant_operator_skill 现在只读不写，行为等价于「只有内置 skill」。

drop table if exists petrichor_assistant_operator_evolution_proposal;
drop table if exists petrichor_assistant_operator_skill_pending;
