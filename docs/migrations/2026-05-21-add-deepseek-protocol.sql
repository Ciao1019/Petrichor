-- 增量迁移：模型配置新增 DEEPSEEK 协议白名单。
-- 背景：原 protocol 列为纯 text，应用层用 parseProtocol 校验。
-- 本次落地后端协议适配器，把 DeepSeek 专属逻辑（thinking 注入、reasoning_content 解析）
-- 与 OpenAI 标准路径拆开，新增 DEEPSEEK 协议作为显式入口。
-- 幂等：先 DROP 旧约束（若存在）再 ADD 新约束。

ALTER TABLE IF EXISTS petrichor_ai_model_config
    DROP CONSTRAINT IF EXISTS petrichor_ai_model_config_protocol_chk;

ALTER TABLE IF EXISTS petrichor_ai_model_config
    ADD CONSTRAINT petrichor_ai_model_config_protocol_chk
    CHECK (protocol IN ('OPENAI', 'DEEPSEEK', 'OPENAI_COMPAT', 'SILICONFLOW', 'GEMINI'));
