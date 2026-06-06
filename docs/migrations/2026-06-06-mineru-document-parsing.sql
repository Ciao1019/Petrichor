-- 2026-06-06 文档解析从「多模态逐页识别」切换为 MinerU 整文件解析
-- 安全可重入：使用 if exists / if not exists
-- 说明：旧的逐页导入任务依赖每页图片，MinerU 无法继续处理，统一清空。

-- 1) 删除逐页明细表与旧的逐页任务（无法迁移到整文件解析）
drop table if exists petrichor_kb_import_job_page;
delete from petrichor_kb_import_job;

-- 2) 导入任务表结构调整：新增原文件 key 与 MinerU 任务 ID，移除按任务锁定的模型配置
alter table petrichor_kb_import_job
    add column if not exists source_file_key text not null default '',
    add column if not exists mineru_task_id text;
alter table petrichor_kb_import_job alter column source_file_key drop default;
alter table petrichor_kb_import_job drop column if exists model_config_id;

-- 3) 模型配置：多模态（VISION）已弃用，改用文档解析（DOC_PARSE / MINERU）
--    清理历史 VISION 配置，避免「模型配置」页出现无效类型。
delete from petrichor_ai_model_config where config_type = 'VISION';
