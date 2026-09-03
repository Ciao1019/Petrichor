"use client"

import * as React from "react"

import { RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"

import { BlueNote, DateTag, HandStamp, HandUnderline, MarkerHighlight, type MarkerColor } from "../about/DeskAccents"

/*
 * Petrichor 项目介绍页。
 * 这里不复述后台菜单，而是沿着「源内容 → 知识结构 → 可追溯回答 → Agent 调用」讲清产品价值。
 * 页面继续使用 About 同源的暖纸、手写注记和马克笔视觉语言，不依赖接口。
 */

const LINKS = {
    repo: "https://github.com/Ciao1019/Petrichor",
    docs: "https://github.com/Ciao1019/Petrichor/tree/master/docs",
    license: "https://github.com/Ciao1019/Petrichor/blob/master/LICENSE",
} as const

const KNOWLEDGE_PIPELINE: { title: string; tag: string; detail: string; ink: MarkerColor }[] = [
    {
        title: "写入与导入",
        tag: "Source",
        ink: "blue",
        detail: "在 PlateJS 编辑器里写 Markdown，把文本型或扫描型 PDF 转成源文章；DOCX、XLSX 与 CSV 也能进入文档库供检索和深读。",
    },
    {
        title: "理解文章结构",
        tag: "Outline",
        ink: "green",
        detail: "按标题层级确定性切片，保存完整标题路径；再生成 PageIndex，让 Agent 能按章节顺序浏览，而不是只靠相似度猜。",
    },
    {
        title: "建立多路索引",
        tag: "Search",
        ink: "orange",
        detail: "原文分片、推荐问题、全文 BM25 与向量索引并存。推荐问题只补齐用户问法，事实仍然回到原文。",
    },
    {
        title: "编译语义 Wiki",
        tag: "Wiki",
        ink: "purple",
        detail: "从多篇文章提取实体、概念、比较与关系，汇成可链接的 Wiki 页面，同时记录来源引用、版本与内容指纹。",
    },
    {
        title: "检索后再深读",
        tag: "Evidence",
        ink: "red",
        detail: "Search 只负责定位候选，Agent 必须显式 Read / Read Many 才能把正文纳入 Evidence；回答附带引用与检索轨迹。",
    },
    {
        title: "交给人与 Agent",
        tag: "Deliver",
        ink: "teal",
        detail: "同一份知识可以发布为文章和公开问答，也能通过站内助手、MCP、REST、Agent Skill、OKF 或 Obsidian 继续使用。",
    },
]

const KNOWLEDGE_FORMS: { title: string; role: string; detail: string; dot: MarkerColor }[] = [
    {
        title: "原文分片",
        role: "事实",
        dot: "blue",
        detail: "保留标题路径与 Markdown 正文，回答具体步骤、代码、数字和引用。",
    },
    {
        title: "推荐问题",
        role: "问法",
        dot: "orange",
        detail: "连接用户语言与原文措辞；命中后仍回到同一原始分片，不把模型生成内容当事实。",
    },
    {
        title: "语义 Wiki",
        role: "关系",
        dot: "purple",
        detail: "聚合跨文章的实体、概念和比较，适合主题导航、多跳关联与知识复用。",
    },
    {
        title: "PageIndex",
        role: "结构",
        dot: "green",
        detail: "保存章节树与摘要，处理目录、顺序总结和长文定位，避免相似度打乱文章结构。",
    },
]

const WIKI_NOTES: { title: string; detail: string; ink: MarkerColor }[] = [
    {
        title: "可编译",
        ink: "blue",
        detail: "一次知识构建会规划页面、生成正文、建立链接并写入来源；问题生成、候选抽取与页面生成支持局部重试和降级。",
    },
    {
        title: "可约束",
        ink: "orange",
        detail: "每个知识库都能保存一份“编译说明书”，告诉系统领域、读者、抽取偏好与页面写法，然后增量更新或完全重建。",
    },
    {
        title: "可维护",
        ink: "green",
        detail: "结构检查会发现断链、孤立页面和陈旧来源；人工补丁与审计事件保留对自动生成内容的修订过程。",
    },
    {
        title: "可迁移",
        ink: "purple",
        detail: "Wiki 可以导出为 OKF bundle、Obsidian vault 或知识 Skill 包，不必永远锁在 Petrichor 的数据库里。",
    },
]

const BUILT_IN_AGENT: { title: string; detail: string }[] = [
    { title: "工具循环", detail: "搜索、深读、创建、修改、分享与知识构建都能成为可组合工具。" },
    { title: "计划与子 Agent", detail: "复杂任务拆成可见步骤，并在预算和深度上限内并行委派。" },
    { title: "记忆与 Skill", detail: "跨会话保存操作员偏好，按需加载可复用流程，而不是每次重写提示词。" },
    { title: "可控写入", detail: "有副作用的操作先展示确认卡；取消、失败与重试都留在同一条执行轨迹中。" },
]

const EXTERNAL_AGENT: { title: string; detail: string }[] = [
    { title: "22 项 REST 能力", detail: "覆盖文章、目录、检索、问答、分享、Wiki、文档与 AI 操作。" },
    { title: "13 个 MCP 核心工具", detail: "Claude Code、Codex、Cursor 等客户端可通过 Streamable HTTP 直接连接。" },
    { title: "单文件 Agent Skill", detail: "动态生成可安装的 SKILL.md，让客户端先发现能力，再按权限调用接口。" },
    { title: "API Key 与审计", detail: "按作用域签发密钥，每次调用记录工具、状态码、耗时和请求轨迹。" },
]

const PRODUCT_SURFACES: { title: string; tag: string; detail: string; dot: MarkerColor }[] = [
    {
        title: "写作工作台",
        tag: "PlateJS",
        dot: "red",
        detail: "Markdown 与所见即所得共存，支持代码、公式、表格、白板、思维导图、媒体和附件。",
    },
    {
        title: "公开阅读站",
        tag: "Publish",
        dot: "orange",
        detail: "文章发布、密码与有效期、短链接、标签、全文搜索、RSS / Atom 和公开问答。",
    },
    {
        title: "视觉文档导入",
        tag: "Worker",
        dot: "green",
        detail: "可提取页直接处理，扫描页进入独立视觉队列；页进度、重试和死信都能在后台查看。",
    },
    {
        title: "多模型配置",
        tag: "Providers",
        dot: "teal",
        detail: "按对话、知识构建、Embedding、图片等用途绑定模型，兼容多种 OpenAI 风格与原生供应商。",
    },
    {
        title: "身份与权限",
        tag: "Access",
        dot: "blue",
        detail: "首次部署自行初始化超级管理员，支持本地账号与 LinuxDo；业务用户和会话状态分开保存。",
    },
    {
        title: "运营与诊断",
        tag: "Observe",
        dot: "purple",
        detail: "数据概览、构建进度、Agent 调用日志、导入任务与死信入口，把失败过程摆到台面上。",
    },
]

const ARCHITECTURE: { title: string; tag: string; detail: string }[] = [
    { title: "Web", tag: "React · Vite · Caddy", detail: "负责编辑器、公开阅读站与管理后台；生产静态资源和 API 由 Caddy 同源托管。" },
    { title: "API", tag: "Go · Gin", detail: "负责认证、业务、Agent Runtime、数据库与存储访问；启动监听前自动执行 Goose 迁移。" },
    { title: "Worker", tag: "Asynq", detail: "独立消费知识构建和视觉导入队列，让耗时模型任务不阻塞在线 API。" },
    { title: "Data", tag: "PostgreSQL · Redis · S3", detail: "PostgreSQL 保存最终知识，Redis 保存队列状态与进度，对象存储承载上传文件。" },
]

const STACK = [
    "React 19",
    "Vite 8",
    "TypeScript",
    "PlateJS",
    "Go 1.26",
    "Gin",
    "PostgreSQL 16+",
    "pg_trgm",
    "pgvector",
    "Redis 8",
    "Asynq",
    "S3",
    "Caddy",
    "Docker Compose",
]

const DEPLOY_LINES: { text: string; prompt?: boolean; muted?: boolean; caret?: boolean }[] = [
    { text: "git clone https://github.com/Ciao1019/Petrichor.git", prompt: true },
    { text: "cd Petrichor", prompt: true },
    { text: "cp .env.example .env", prompt: true },
    { text: "cp apps/api/config.example.toml apps/api/config.toml", prompt: true },
    { text: "# 填写数据库、加密、存储、Redis 与模型配置", muted: true },
    { text: "docker compose up -d --build", prompt: true },
    { text: "docker compose ps", prompt: true },
    { text: "docker compose logs -f api worker", prompt: true, caret: true },
]

const handwritingStyle: React.CSSProperties = {
    fontFamily: '"Caveat", ui-sans-serif, cursive',
}

function SectionHeading({ index, label, title }: { index: string; label: string; title: string }) {
    return (
        <div className="mb-6">
            <p className="promo-section-label font-mono">
                {index} · {label}
            </p>
            <h2 className="mt-2.5 font-serif text-3xl italic leading-tight md:text-4xl" style={{ color: "var(--desk-sheet-ink)" }}>
                {title}
            </h2>
        </div>
    )
}

function AgentCard({
    eyebrow,
    title,
    note,
    items,
}: {
    eyebrow: string
    title: string
    note: string
    items: { title: string; detail: string }[]
}) {
    return (
        <article className="promo-sheet flex h-full flex-col p-5 md:p-6">
            <p className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.2em]" style={{ color: "var(--desk-marker-blue)" }}>
                {eyebrow}
            </p>
            <h3 className="mt-2 font-serif text-2xl italic" style={{ color: "var(--desk-sheet-ink)" }}>
                {title}
            </h3>
            <p className="mt-2 text-[0.78rem] leading-relaxed" style={{ color: "var(--desk-sheet-muted)" }}>
                {note}
            </p>
            <div className="mt-5">
                {items.map((item) => (
                    <div key={item.title} className="promo-spec py-3.5">
                        <p className="text-[0.82rem] font-bold" style={{ color: "var(--desk-sheet-ink)" }}>
                            {item.title}
                        </p>
                        <p className="mt-1 text-[0.75rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            {item.detail}
                        </p>
                    </div>
                ))}
            </div>
        </article>
    )
}

export function PetrichorPage() {
    return (
        <main className="scrollbar-hide retypeset-home relative flex min-h-screen flex-col overflow-hidden font-mono">
            <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />

            <div className="relative z-30 mx-auto w-full max-w-6xl px-6 pt-8 md:px-24 lg:contents">
                <RetypesetSiteHeader dockVisible />
                <RetypesetSiteNav activeSection="petrichor" dockVisible />
            </div>

            <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0">
                <header className="blog-home-fade-in">
                    <div className="flex flex-wrap items-center gap-3">
                        <p className="promo-section-label">Self-hosted Knowledge System</p>
                        <DateTag tilt="rotate-2">open source · 2024 → now</DateTag>
                    </div>

                    <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-2">
                        <h1 className="font-serif text-6xl italic leading-none md:text-7xl" style={{ color: "var(--desk-sheet-ink)" }}>
                            <HandUnderline color="blue" note="rain on dry earth ☔">
                                Petrichor
                            </HandUnderline>
                        </h1>
                        <HandStamp color="green">Apache-2.0</HandStamp>
                    </div>

                    <p className="mt-6 max-w-2xl font-serif text-2xl font-medium leading-snug md:text-3xl" style={{ color: "var(--desk-sheet-ink)" }}>
                        让知识被人读懂，也被 AI Agent 正确调用。
                    </p>

                    <div className="mt-7 max-w-2xl space-y-5 text-sm leading-relaxed md:text-[0.92rem]" style={{ color: "var(--desk-sheet-ink)" }}>
                        <p>
                            Petrichor 是一套开源、自托管的知识平台。你用 Markdown 写作，系统把内容整理成
                            <HandUnderline color="purple" note="不是一次性向量">可维护的语义 Wiki</HandUnderline>
                            ，再通过 Agentic RAG 生成带来源、能复查的回答。
                        </p>
                        <p>
                            它不是给博客旁边挂一个聊天框，也不是把文档切碎后全部塞给模型。原文、问题、概念关系和章节目录会以
                            <MarkerHighlight note="四种知识表示">不同结构各司其职</MarkerHighlight>
                            ；Agent 先定位、再深读，只有读过的内容才能成为证据。
                        </p>
                        <p>
                            人可以在公开站阅读和提问，站内助手可以继续写作与整理，Claude Code、Codex、Cursor 等外部 Agent 也能通过 MCP、REST 或 Skill 使用同一份知识。
                            <HandUnderline color="green" note="你掌握边界">应用、数据、模型和密钥都由你自己托管</HandUnderline>。
                        </p>
                    </div>

                    <div className="mt-9 flex flex-wrap items-center gap-3">
                        <a href="/demo" className="promo-cta promo-cta--ink">
                            打开在线演示
                        </a>
                        <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">
                            查看 GitHub
                        </a>
                        <a href={LINKS.docs} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">
                            阅读文档
                        </a>
                    </div>
                    <p className="mt-3 text-[0.72rem]" style={{ color: "var(--desk-sheet-muted)" }}>
                        当前在线演示不连接后端；所有交互由浏览器假数据驱动，刷新后重置。
                    </p>
                </header>

                <div className="mt-20 flex flex-col gap-20">
                    <section aria-labelledby="promo-pipeline" className="blog-home-fade-in blog-delay-300">
                        <SectionHeading index="01" label="Knowledge Pipeline" title="一篇 Markdown，会经历什么" />
                        <h3 id="promo-pipeline" className="sr-only">知识处理链路</h3>
                        <p className="mb-8 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            Petrichor 不把“保存文章”和“知识已经可用”混为一谈。从源文档到最终回答，每一步都有明确产物，也能单独检查、重建或导出。
                        </p>
                        <ol className="promo-steps space-y-7">
                            {KNOWLEDGE_PIPELINE.map((step, index) => (
                                <li key={step.title} className="promo-step" data-ink={step.ink}>
                                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                        <span className="text-[0.66rem] font-bold" style={{ color: "var(--desk-sheet-muted)" }}>
                                            {String(index + 1).padStart(2, "0")}
                                        </span>
                                        <h4 className="text-[0.9rem] font-bold" style={{ color: "var(--desk-sheet-ink)" }}>{step.title}</h4>
                                        <span className="text-[0.6rem] font-bold uppercase tracking-[0.16em]" style={{ color: `var(--desk-marker-${step.ink})` }}>
                                            {step.tag}
                                        </span>
                                    </div>
                                    <p className="mt-1.5 max-w-2xl text-[0.8rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                                        {step.detail}
                                    </p>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <section aria-labelledby="promo-rag" className="blog-home-fade-in">
                        <SectionHeading index="02" label="Agentic RAG" title="检索负责找，阅读负责证明" />
                        <h3 id="promo-rag" className="sr-only">Agentic RAG 的四种知识表示</h3>
                        <p className="mb-7 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            普通 Top-K RAG 容易把“看起来相似”误当成“足以作答”。Petrichor 把定位和取证分开，并为不同问题保留四种互补表示。
                        </p>
                        <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                            {KNOWLEDGE_FORMS.map((item) => (
                                <article key={item.title} className="promo-cap flex gap-3 py-4">
                                    <span className="promo-cap-dot" aria-hidden="true" style={{ background: `var(--desk-marker-${item.dot})` }} />
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                            <h4 className="text-[0.92rem] font-bold" style={{ color: "var(--desk-sheet-ink)" }}>{item.title}</h4>
                                            <span className="text-[0.6rem] font-bold uppercase tracking-widest" style={{ color: "var(--desk-sheet-muted)" }}>{item.role}</span>
                                        </div>
                                        <p className="mt-1.5 text-[0.78rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>{item.detail}</p>
                                    </div>
                                </article>
                            ))}
                        </div>
                        <div className="promo-sheet mt-8 px-5 py-4 md:px-6">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-3 text-[0.68rem] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--desk-sheet-soft)" }}>
                                {[
                                    ["Question", "blue"],
                                    ["Search / Outline", "orange"],
                                    ["Read", "purple"],
                                    ["Evidence + Trace", "green"],
                                    ["Answer", "red"],
                                ].map(([label, color], index) => (
                                    <React.Fragment key={label}>
                                        {index > 0 ? <span aria-hidden="true" style={{ color: "var(--desk-sheet-muted)" }}>→</span> : null}
                                        <span className="promo-chip px-2.5 py-1" style={{ borderColor: `color-mix(in srgb, var(--desk-marker-${color}) 55%, transparent)` }}>
                                            {label}
                                        </span>
                                    </React.Fragment>
                                ))}
                            </div>
                            <p className="mt-3 text-[0.74rem] leading-relaxed" style={{ color: "var(--desk-sheet-muted)" }}>
                                Search 返回候选不等于引用。只有 Read 过的原文或 Wiki 页面才进入 Evidence，推荐问题本身永远不会成为事实来源。
                            </p>
                        </div>
                    </section>

                    <section aria-labelledby="promo-wiki" className="blog-home-fade-in">
                        <SectionHeading index="03" label="Semantic Wiki" title="把文章编译成会生长的知识网络" />
                        <h3 id="promo-wiki" className="sr-only">语义 Wiki</h3>
                        <p className="mb-6 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            文章适合完整阅读，Wiki 适合跨文档组织。Petrichor 把源文档、概念、实体、比较、答案和日志组织到同一张关系网，同时保留每条结论来自哪里。
                        </p>
                        <div className="promo-sheet px-5 py-1.5 md:px-6">
                            {WIKI_NOTES.map((note) => (
                                <div key={note.title} className="promo-spec -mx-5 px-5 py-4 md:-mx-6 md:px-6">
                                    <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-5">
                                        <span className="shrink-0 text-[0.82rem] font-bold sm:w-24" style={{ color: `var(--desk-marker-${note.ink})` }}>
                                            {note.title}
                                        </span>
                                        <span className="text-[0.8rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>{note.detail}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <p className="mt-4 text-xl" style={{ ...handwritingStyle, color: "var(--desk-sheet-soft)" }}>
                            source → concept → relation → answer，全部还能回到 source。
                        </p>
                    </section>

                    <section aria-labelledby="promo-agents" className="blog-home-fade-in">
                        <SectionHeading index="04" label="Agent Interfaces" title="同一份知识，两种 Agent 入口" />
                        <h3 id="promo-agents" className="sr-only">站内与外部 Agent</h3>
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                            <AgentCard
                                eyebrow="Inside Petrichor"
                                title="站内助手"
                                note="面向正在写作和维护知识的人，带 UI、计划、确认与执行过程。"
                                items={BUILT_IN_AGENT}
                            />
                            <AgentCard
                                eyebrow="Outside Petrichor"
                                title="外部 Agent"
                                note="面向已经在使用的编码助手和自动化系统，提供稳定协议与权限边界。"
                                items={EXTERNAL_AGENT}
                            />
                        </div>
                        <div className="mt-7 max-w-2xl">
                            <BlueNote>
                                <span className="block italic">“能调用”不等于“可以随便调用”。</span>
                                <span className="mt-2 block not-italic">
                                    写操作确认、细粒度权限、调用审计与自托管数据边界，会和能力一起交付。
                                </span>
                            </BlueNote>
                        </div>
                    </section>

                    <section aria-labelledby="promo-product" className="blog-home-fade-in">
                        <SectionHeading index="05" label="Product Surface" title="从写作到开放调用，是一套完整产品" />
                        <h3 id="promo-product" className="sr-only">产品能力</h3>
                        <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                            {PRODUCT_SURFACES.map((item) => (
                                <article key={item.title} className="promo-cap flex gap-3 py-4">
                                    <span className="promo-cap-dot" aria-hidden="true" style={{ background: `var(--desk-marker-${item.dot})` }} />
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                            <h4 className="text-[0.92rem] font-bold" style={{ color: "var(--desk-sheet-ink)" }}>{item.title}</h4>
                                            <span className="text-[0.6rem] font-bold uppercase tracking-widest" style={{ color: "var(--desk-sheet-muted)" }}>{item.tag}</span>
                                        </div>
                                        <p className="mt-1.5 text-[0.78rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>{item.detail}</p>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>

                    <section aria-labelledby="promo-deploy" className="blog-home-fade-in">
                        <SectionHeading index="06" label="Self-host" title="应用归你，数据也归你" />
                        <h3 id="promo-deploy" className="sr-only">自托管架构</h3>
                        <p className="mb-7 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            正式版不是 Vercel 上的一张静态页面。它由 Web、API、Worker 和你自己的数据服务组成，Docker Compose 负责把运行边界固定下来。
                        </p>
                        <div className="promo-sheet px-5 py-1.5 md:px-6">
                            {ARCHITECTURE.map((item) => (
                                <div key={item.title} className="promo-viz-row -mx-5 px-5 py-4 md:-mx-6 md:px-6">
                                    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-5">
                                        <span className="shrink-0 text-[0.82rem] font-bold sm:w-16" style={{ color: "var(--desk-sheet-ink)" }}>{item.title}</span>
                                        <div className="min-w-0 flex-1">
                                            <span className="text-[0.62rem] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--desk-marker-blue)" }}>{item.tag}</span>
                                            <p className="mt-1 text-[0.78rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>{item.detail}</p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="mt-7 flex flex-wrap gap-2">
                            {STACK.map((item) => (
                                <span key={item} className="promo-chip px-2.5 py-1 font-mono text-[0.68rem] font-medium">{item}</span>
                            ))}
                        </div>

                        <div className="mt-10">
                            <p className="mb-3 text-xl" style={{ ...handwritingStyle, color: "var(--desk-sheet-soft)" }}>
                                从仓库到运行 ↓
                            </p>
                            <div className="promo-terminal p-4 font-mono text-[0.72rem] leading-[1.95] md:p-5">
                                <div className="promo-terminal-dots mb-3" aria-hidden="true">
                                    <span style={{ background: "var(--desk-marker-red)" }} />
                                    <span style={{ background: "var(--desk-marker-orange)" }} />
                                    <span style={{ background: "var(--desk-marker-green)" }} />
                                </div>
                                {DEPLOY_LINES.map((line) => (
                                    <span
                                        key={line.text}
                                        data-prompt={line.prompt ? "true" : "false"}
                                        className="promo-terminal-line"
                                        style={{ color: line.muted ? "rgba(239,233,219,0.45)" : undefined }}
                                    >
                                        {line.text}
                                        {line.caret ? <span className="promo-caret ml-1.5" aria-hidden="true" /> : null}
                                    </span>
                                ))}
                            </div>
                            <p className="mt-3 text-[0.72rem] leading-relaxed" style={{ color: "var(--desk-sheet-muted)" }}>
                                需要 Docker Compose 与启用 pg_trgm、pgvector 的 PostgreSQL 16+。API 启动时自动执行迁移；生产只公开 Caddy。
                            </p>
                        </div>
                    </section>

                    <section aria-labelledby="promo-cta" className="blog-home-fade-in">
                        <h3 id="promo-cta" className="sr-only">开始使用</h3>
                        <div className="max-w-xl">
                            <BlueNote>
                                <span className="block break-words italic">
                                    “知识不该只躺在文件夹里，也不该在进入向量库后失去出处。”
                                </span>
                                <span className="mt-2.5 block not-italic">
                                    Petrichor 保留原文、结构与证据，再让 Wiki 和 Agent 在它们之上生长。Apache-2.0 开源，你可以阅读、修改并部署成自己的知识基础设施。
                                </span>
                            </BlueNote>
                        </div>
                        <div className="mt-8 flex flex-wrap items-center gap-3">
                            <a href="/demo" className="promo-cta promo-cta--ink">先体验完整界面</a>
                            <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">阅读源码</a>
                            <a href={LINKS.license} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">License</a>
                        </div>
                    </section>
                </div>
            </section>

        </main>
    )
}
