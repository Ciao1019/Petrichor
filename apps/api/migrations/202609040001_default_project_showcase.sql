-- +goose Up

-- 新安装和尚未配置项目页的站点，默认展示静态演示中已经验收的项目清单。
-- 只在单例记录不存在时写入，避免覆盖管理员已经保存的内容。
ALTER TABLE public.petrichor_site_project_showcase
    ALTER COLUMN intro SET DEFAULT '我正在构建与参与的开源项目。点开每一项，可以查看项目简介、技术栈与源码。'::text;

ALTER TABLE public.petrichor_site_project_showcase
    ALTER COLUMN items_json SET DEFAULT '[{"name":"Petrichor","year":"2026","stack":["TypeScript","React","Go","PostgreSQL"],"stamp":"SELF-HOSTED","stampColor":"red","blurb":"面向人与 AI Agent 的自托管知识平台：从编辑、公开发布和语义 Wiki，到基于证据的 RAG 问答、MCP / REST 接入与可移植 Agent Skill。","repoUrl":"https://github.com/Ciao1019/Petrichor","siteUrl":""},{"name":"AgentX","year":"2025","stack":["Java","TypeScript","MCP","Docker"],"stamp":"AGENT","stampColor":"blue","blurb":"通过自然语言与工具集成构建个性化智能 Agent，涵盖 MCP 网关、模型高可用、RAG、长期记忆、定时任务、监控与 OpenAPI。","repoUrl":"https://github.com/lucky-aeon/AgentX","siteUrl":""},{"name":"stream-query","year":"2022","stack":["Java","MyBatis-Plus","Stream","Lambda"],"stamp":"DROMARA","stampColor":"green","blurb":"以 Stream 与 Lambda 封装数据查询和结果处理，提供无需手写 Mapper 的 MyBatis-Plus 体验，并支持 Database、OneToOne 与 OneToMany 等流式 API。","repoUrl":"https://github.com/dromara/stream-query","siteUrl":""}]'::text;

INSERT INTO public.petrichor_site_project_showcase (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- +goose Down

-- 单例记录可能已被管理员编辑，回滚时保留数据，仅恢复旧字段默认值。
ALTER TABLE public.petrichor_site_project_showcase
    ALTER COLUMN intro SET DEFAULT ''::text;

ALTER TABLE public.petrichor_site_project_showcase
    ALTER COLUMN items_json SET DEFAULT '[{"name":"Ech0 — self-hosted microblog","year":"2025","stack":["Go","Vue"],"stamp":"popular","stampColor":"red","blurb":"An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.","repoUrl":"https://github.com/lin-snow/Ech0","siteUrl":"https://ech0.app"},{"name":"Dox — todos in terminal","year":"2026","stack":["Go","TypeScript"],"stamp":"new","stampColor":"blue","blurb":"More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.","repoUrl":"https://github.com/lin-snow/dox"},{"name":"Kemate — a Vercel-like PaaS","year":"2026","stack":["Go"],"stamp":"WIP","stampColor":"green","blurb":"A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture."}]'::text;
