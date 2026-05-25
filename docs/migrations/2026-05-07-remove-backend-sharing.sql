-- 移除后台共享专用表，保留公开分享表 petrichor_kb_article_share。
-- 幂等执行：按外键依赖顺序先删除依赖表，再删除被依赖表。

drop table if exists petrichor_kb_resource_grant;
drop table if exists petrichor_kb_article_share_invite;

drop table if exists petrichor_ai_model_config_binding;
drop table if exists petrichor_ai_model_config_binding_application;
drop table if exists petrichor_ai_model_config_share_code;
