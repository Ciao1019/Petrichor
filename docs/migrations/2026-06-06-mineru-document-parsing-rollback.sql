-- 回滚：MinerU 文档解析 → 多模态逐页识别（撤销 2026-06-06-mineru-document-parsing.sql）
-- ⚠️ 注意：正向迁移删除的数据无法通过本脚本恢复：
--   1) 已删除的 VISION 模型配置（需要重新手动添加）
--   2) 已删除的旧逐页导入任务
-- 本脚本只负责把表结构还原回旧版本。安全可重入。

-- 1) 清空 MinerU 期间创建的导入任务：它们没有逐页记录，回到旧代码后无法处理
delete from petrichor_kb_import_job;

-- 2) 还原 petrichor_kb_import_job 旧结构
alter table petrichor_kb_import_job add column if not exists model_config_id bigint;
alter table petrichor_kb_import_job drop column if exists source_file_key;
alter table petrichor_kb_import_job drop column if exists mineru_task_id;

-- 3) 重建逐页明细表 petrichor_kb_import_job_page
create table if not exists petrichor_kb_import_job_page (
    id bigint generated always as identity primary key,
    job_id bigint not null references petrichor_kb_import_job(id) on delete cascade,
    page_no integer not null,
    image_key text not null,
    status text not null default 'pending',
    markdown text,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (job_id, page_no)
);

create index if not exists idx_petrichor_kb_import_job_page_job
    on petrichor_kb_import_job_page(job_id);
