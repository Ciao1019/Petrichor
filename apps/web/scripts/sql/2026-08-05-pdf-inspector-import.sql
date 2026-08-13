-- ============================================================
-- 文档导入改造：pdf-inspector 本地抽取 + 多模态仅兜底扫描页
-- 适用：已有数据的线上库（Supabase / Postgres）
--
-- 背景：导入不再把每一页都栅格化后丢给多模态模型。改为服务端用
--      PDF sidecar 本地逐页抽取 Markdown，只有 needsOcr
--      的页（扫描件 / 纯图片页）才栅格化 + 走 VISION 模型。
--      同时不再支持 Word 导入，也不再裁剪页内嵌入图。
--
-- 变更：
--   1) 任务表新增 source_key：原始 PDF 的对象存储 key。
--   2) 页表 image_key 放开 not null：本地抽取的文字页没有整页图。
--   3) 页表新增 extracted_by：区分 'pdf'（本地抽取）/ 'vision'（模型识别）。
-- 全部幂等，可安全重复执行。
-- ============================================================

-- 1) 原始 PDF 对象 key
alter table petrichor_kb_import_job
    add column if not exists source_key text;

-- 2) 文字页没有整页图，image_key 必须可空
alter table petrichor_kb_import_job_page
    alter column image_key drop not null;

-- 3) 页的抽取来源。存量行都是多模态识别产物，默认值 'vision' 即为正确回填。
alter table petrichor_kb_import_job_page
    add column if not exists extracted_by text not null default 'vision';
