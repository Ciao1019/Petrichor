"use client"

import * as React from "react"

import { PixelFlowerLayer, type PixelFlowerDecoration } from "@/features/pages/blog/PixelDecorations"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"

import { BlueNote, DateTag, HandStamp, HandUnderline, LinkDoodle, MarkerHighlight, type MarkerColor } from "../about/DeskAccents"

/* 项目宣传页（/petrichor）。
   骨架与「关于我」保持一致：同一片暖纸背景 + 像素花、右侧固定站点 dock、同宽正文容器；
   左侧正文完全采用 about-desk 的桌面注记语言——手绘下划线、荧光笔、便签、纸质清单卡。
   本页是纯静态介绍，不走接口；内容源自仓库 README / docs，改文案直接改下面的常量。 */

const LINKS = {
    repo: "https://github.com/Ciao1019/Petrichor",
    demo: "https://wl.do",
    deploy:
        "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FCiao1019%2FPetrichor&project-name=petrichor&repository-name=petrichor&root-directory=apps%2Fweb",
    license: "https://github.com/Ciao1019/Petrichor/blob/main/LICENSE",
    agentDocs: "https://github.com/Ciao1019/Petrichor/blob/main/docs/agent-integration.md",
} as const

/* 能力矩阵：对齐 README 的功能特性表，每条补上「具体到能点开的东西」的细节，
   dot 用马克笔色轮换，像清单前随手点的墨点。 */
const CAPABILITIES: { title: string; tag: string; detail: string; dot: MarkerColor }[] = [
    {
        title: "富文本编辑器",
        tag: "PlateJS",
        dot: "red",
        detail: "Markdown 双向输入、代码块高亮、表格、数学公式、白板、思维导图、媒体嵌入与拖拽上传，块级结构化存储而非纯文本。",
    },
    {
        title: "知识库",
        tag: "Tree",
        dot: "orange",
        detail: "多层级目录树、文章标签、跨库搜索、Wiki 编译视图、文章分享（可设访问密码与到期时间）、独立 RSS / Atom Feed。",
    },
    {
        title: "AI 写作助手",
        tag: "Multi-model",
        dot: "green",
        detail: "续写 / 改写 / 翻译 / 语气调整、文章总结、思维导图与知识图谱生成，以及 AI 周报 & 月报回顾。模型在后台自行配置。",
    },
    {
        title: "站内对话助手",
        tag: "Runtime",
        dot: "teal",
        detail: "自研运行时：工具调用、子代理分发、写操作二次确认、上下文压缩与向量召回、跨会话多层记忆，详见下一节。",
    },
    {
        title: "认证体系",
        tag: "Better Auth",
        dot: "blue",
        detail: "httpOnly Cookie 会话、邮箱密码登录、LinuxDo OAuth、二步验证与强制开启策略；首个注册账号自动成为超级管理员。",
    },
    {
        title: "对象存储",
        tag: "S3",
        dot: "purple",
        detail: "封面、附件、头像、AI 配图统一走服务端签名的预签名 URL，上传 / 下载有效期可配，兼容 Bitiful / AWS S3 / MinIO。",
    },
    {
        title: "仪表盘",
        tag: "Metrics",
        dot: "pink",
        detail: "写作数据统计、活跃度热力图、知识库分布、文档导入任务队列与失败详情回看。",
    },
    {
        title: "公开站点",
        tag: "SEO",
        dot: "red",
        detail: "文章公开页与短链分享、阅后即焚链接、完整 SEO 元数据、sitemap.xml、RSS 与 Atom，自定义站点标题 / 图标 / 主题。",
    },
    {
        title: "Agent 开放层",
        tag: "MCP / REST",
        dot: "blue",
        detail: "API Key 管理、MCP Server（Streamable HTTP）、可下载 Skill 包、全量调用审计日志与免鉴权能力发现接口。",
    },
]

/* 助手运行时：最近几轮迭代的重点，也是这个项目和普通博客系统拉开差距的地方。 */
const RUNTIME_NOTES: { title: string; detail: string; ink: MarkerColor }[] = [
    {
        title: "工具调用与子代理",
        ink: "blue",
        detail: "助手可以直接读写你的知识库、检索文档、生成摘要；复杂任务会分发给子代理并行处理，子代理有深度上限，不会无限递归。",
    },
    {
        title: "写操作先确认",
        ink: "red",
        detail: "任何会落库的动作（新建 / 更新 / 删除文章、移动目录）都会先弹出待确认卡片，展示改动预览，确认后才执行。",
    },
    {
        title: "上下文窗口治理",
        ink: "green",
        detail: "长对话自动压缩历史、按需向量召回相关片段，配合 prompt 缓存，让长会话不至于越聊越贵、越聊越糊。",
    },
    {
        title: "操作员多层记忆",
        ink: "purple",
        detail: "记忆按层分区存放，跨会话保留你的写作偏好与项目背景；可以手动触发「进化」，把近期对话沉淀成长期记忆。",
    },
    {
        title: "可写 Skills",
        ink: "orange",
        detail: "助手能读写自己的 Skill 目录，把重复流程固化成技能，下次直接调用，而不是每次重新描述一遍要求。",
    },
    {
        title: "Plan 侧栏",
        ink: "teal",
        detail: "多步骤任务会展开成可勾选的计划列表，执行到哪一步、哪一步失败了、要不要重试，全程可见可干预。",
    },
]

/* Agent 开放层：外部工具（Claude Code / Codex / Cursor …）怎么接进来。 */
const AGENT_STEPS: { title: string; detail: string; ink: string }[] = [
    {
        title: "签发 API Key",
        ink: "blue",
        detail: "仪表盘 → Agent 集成 → API Key 管理，按 article:write / doc:read / qa:read 等粒度勾权限。明文只展示一次，服务端仅存 sha256。",
    },
    {
        title: "接入方式二选一",
        ink: "green",
        detail: "把站点注册成 MCP Server（Streamable HTTP，Claude Code / Codex / Cursor 通用），或下载 Skill 包放进工具的 Skills 目录。",
    },
    {
        title: "按意图加载子文档",
        ink: "orange",
        detail: "Skill 包只有一个顶层 petrichor，根 SKILL.md 内置路由表，按意图按需读取 setup / articles / docs / qa / share / ai 子文档。",
    },
    {
        title: "能力自发现",
        ink: "teal",
        detail: "GET /api/agent/manifest 免鉴权返回全部接口、参数与所需权限，Agent 可以自己探明能干什么，无需人工贴文档。",
    },
    {
        title: "全量审计",
        ink: "pink",
        detail: "每次调用记录来源 Agent、工具名、IP、UA、入参、出参、状态码与耗时，登录后在「调用日志」逐条回看。",
    },
]

const STACK: { group: string; items: string[] }[] = [
    { group: "框架", items: ["Next.js 16", "React", "TypeScript 5.9", "React Router", "Tailwind CSS", "shadcn/ui"] },
    { group: "编辑器", items: ["PlateJS", "Slate", "Markdown", "KaTeX", "Mind Map", "Whiteboard"] },
    { group: "数据层", items: ["PostgreSQL", "Supabase", "Drizzle ORM", "S3 兼容存储"] },
    { group: "AI", items: ["Vercel AI SDK", "OpenAI", "Gemini", "DeepSeek", "向量召回", "MCP"] },
    { group: "工程", items: ["pnpm 10", "Vitest", "ESLint", "Vercel", "Node ≥ 22"] },
]

const DEPLOY_STEPS: { title: string; detail: string; ink: string }[] = [
    {
        title: "开一个 Supabase 项目",
        ink: "green",
        detail: "取 Transaction Pooler（6543 端口）连接串作为 DATABASE_URL；免费额度足够起步。",
    },
    {
        title: "准备 S3 兼容存储",
        ink: "blue",
        detail: "Bitiful / AWS S3 / MinIO 任选，建一个公开读的 Bucket，记下 endpoint、region、bucket 与密钥对。",
    },
    {
        title: "生成三串密钥",
        ink: "orange",
        detail: "SESSION_SECRET 与 PETRICHOR_ENCRYPT_KEY 各取 32 字节 base64，PETRICHOR_ENCRYPT_SALT 取 8 字节 hex。上线后不要再换。",
    },
    {
        title: "一键部署到 Vercel",
        ink: "pink",
        detail: "部署按钮会自动 fork 仓库、创建项目、把 Root Directory 设为 apps/web，并弹出环境变量表单。",
    },
    {
        title: "初始化表结构",
        ink: "teal",
        detail: "把 docs/petrichor-init.sql 粘进 Supabase SQL Editor 执行一次；该文件与代码里的 Drizzle schema 保持同步。",
    },
    {
        title: "造出第一个管理员",
        ink: "purple",
        detail: "临时开放注册并重新部署，注册的首个账号自动成为 SUPER_ADMIN，然后再把注册关掉。",
    },
]

const TERMINAL_LINES: { text: string; prompt?: boolean; muted?: boolean; caret?: boolean }[] = [
    { text: "git clone https://github.com/Ciao1019/Petrichor.git petrichor", prompt: true },
    { text: "cd petrichor && pnpm install", prompt: true },
    { text: "cp apps/web/.env.example apps/web/.env.local", prompt: true },
    { text: "# 填好 DATABASE_URL / SESSION_SECRET / S3_* 后：", muted: true },
    { text: "pnpm dev", prompt: true, caret: true },
    { text: "→ http://localhost:3000", muted: true },
]

const VISUALIZATIONS: { title: string; detail: string; href: string }[] = [
    {
        title: "Agent 架构可视化",
        detail: "助手运行时的分层拆解：会话壳、工具面板、子代理、操作员四层记忆分区。",
        href: "/tools/visualizations/architecture.html",
    },
    {
        title: "前端技术选型",
        detail: "UI 层怎么搭：路由、状态、编辑器、组件库与主题体系的取舍。",
        href: "/tools/visualizations/frontend-stack.html",
    },
    {
        title: "后端技术选型",
        detail: "服务端分层：handler / 业务逻辑 / Drizzle schema，以及鉴权与存储的边界。",
        href: "/tools/visualizations/backend-stack.html",
    },
]

const promoBackgroundFlowers: PixelFlowerDecoration[] = [
    {
        className: "left-[4%] top-[12%] size-12 opacity-40",
        tone: "yellow",
        speed: 0.4,
        animationClassName: "blog-float-medium",
    },
    {
        className: "bottom-[8%] right-[6%] size-16 opacity-35",
        tone: "red",
        speed: 0.8,
        animationClassName: "blog-float-slow blog-delay-500",
    },
    {
        className: "left-[10%] top-[58%] hidden size-8 opacity-30 md:block",
        tone: "yellow",
        speed: 1.2,
        animationClassName: "blog-float-fast blog-delay-300",
    },
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

export function PetrichorPage() {
    const [parallax, setParallax] = React.useState({ x: 0, y: 0 })

    const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === "touch") return

        const rect = event.currentTarget.getBoundingClientRect()
        setParallax({
            x: (rect.width / 2 - (event.clientX - rect.left)) / 80,
            y: (rect.height / 2 - (event.clientY - rect.top)) / 80,
        })
    }, [])

    const resetParallax = React.useCallback(() => {
        setParallax({ x: 0, y: 0 })
    }, [])

    return (
        <main
            className="scrollbar-hide retypeset-home relative flex min-h-screen flex-col overflow-hidden font-mono"
            onPointerMove={handlePointerMove}
            onPointerLeave={resetParallax}
        >
            <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />
            <PixelFlowerLayer
                flowers={promoBackgroundFlowers}
                className="fixed inset-0 z-0 overflow-hidden"
                parallax={parallax}
            />

            <div className="relative z-30 mx-auto w-full max-w-6xl px-6 pt-8 md:px-24 lg:contents">
                <RetypesetSiteHeader dockVisible />
                <RetypesetSiteNav activeSection="projects" dockVisible />
            </div>

            <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0">
                {/* ——— Hero：大字标题 + 手写副题 + 注记正文 ——— */}
                <header className="blog-home-fade-in">
                    <div className="group flex flex-wrap items-center gap-3">
                        <p className="promo-section-label">Current Project</p>
                        <DateTag tilt="rotate-2">2024 → now</DateTag>
                    </div>

                    <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-2">
                        <h1
                            className="font-serif text-6xl italic leading-none md:text-7xl"
                            style={{ color: "var(--desk-sheet-ink)" }}
                        >
                            <HandUnderline color="blue" note="rain on dry earth ☔">
                                Petrichor
                            </HandUnderline>
                        </h1>
                        <HandStamp color="green">open source!</HandStamp>
                    </div>

                    <p
                        className="mt-5 text-2xl leading-snug md:text-3xl"
                        style={{ ...handwritingStyle, color: "var(--desk-sheet-soft)" }}
                    >
                        开箱即用的全栈知识库与博客平台 —— 一个人也能撑起来的内容基建。
                    </p>

                    <div
                        className="mt-8 max-w-2xl space-y-5 text-sm leading-relaxed md:text-[0.92rem]"
                        style={{ color: "var(--desk-sheet-ink)" }}
                    >
                        <p>
                            Petrichor 面向个人与小团队，把富文本编辑器、多层级知识库、公开博客、AI 助手与 Agent
                            开放层做进<HandUnderline color="red" note="one repo, all in">同一个全栈应用</HandUnderline>
                            ：不拆微服务、不搞插件市场，一份仓库跑完整条链路。
                        </p>
                        <p>
                            部署形态刻意做轻：Vercel 托管前后端、Supabase 提供 Postgres、任意 S3 兼容存储放附件，
                            <MarkerHighlight note="免费额度就够用">零自建服务器</MarkerHighlight>
                            ，填好环境变量就能上线。
                        </p>
                        <p>
                            对外是一个按 Retypeset 风格排版、专注中文阅读的<HandUnderline color="green" note="就是本站">博客</HandUnderline>
                            ；登录后进入仪表盘，管理知识库、导入文档、配置 AI 模型、签发 Agent 密钥——对内是一套
                            <HandUnderline color="purple" note="知识工作台">完整的知识工作台</HandUnderline>。
                        </p>
                    </div>

                    <div className="mt-9 flex flex-wrap items-center gap-3">
                        <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--ink">
                            GitHub 仓库
                        </a>
                        <a href={LINKS.demo} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">
                            在线 Demo
                        </a>
                        <a href={LINKS.deploy} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">
                            一键部署
                        </a>
                    </div>
                </header>

                <div className="mt-20 flex flex-col gap-20">
                    {/* ——— 01 能力矩阵 ——— */}
                    <section aria-labelledby="promo-capabilities" className="blog-home-fade-in blog-delay-300">
                        <SectionHeading index="01" label="Capabilities" title="一套仓库里的九个模块" />
                        <h3 id="promo-capabilities" className="sr-only">
                            能力矩阵
                        </h3>
                        <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
                            {CAPABILITIES.map((item) => (
                                <article key={item.title} className="promo-cap flex gap-3 py-4">
                                    <span
                                        className="promo-cap-dot"
                                        aria-hidden="true"
                                        style={{ background: `var(--desk-marker-${item.dot})` }}
                                    />
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                            <h4 className="text-[0.95rem] font-bold" style={{ color: "var(--desk-sheet-ink)" }}>
                                                {item.title}
                                            </h4>
                                            <span
                                                className="font-mono text-[0.62rem] font-bold uppercase tracking-widest"
                                                style={{ color: "var(--desk-sheet-muted)" }}
                                            >
                                                {item.tag}
                                            </span>
                                        </div>
                                        <p className="mt-1.5 text-[0.8rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                                            {item.detail}
                                        </p>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>

                    {/* ——— 02 助手运行时 ——— */}
                    <section aria-labelledby="promo-runtime" className="blog-home-fade-in">
                        <SectionHeading index="02" label="Assistant Runtime" title="站内助手，不只是一个聊天框" />
                        <h3 id="promo-runtime" className="sr-only">
                            助手运行时
                        </h3>
                        <p className="mb-6 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            助手直接长在知识库上：它看得到你的目录树和正文，也<HandUnderline color="red" note="所以要管住它">能改</HandUnderline>
                            。为了让「能改」这件事可控，运行时这一层做了不少约束。
                        </p>
                        <div className="promo-sheet px-5 py-1.5 md:px-6">
                            {RUNTIME_NOTES.map((note) => (
                                <div key={note.title} className="promo-spec -mx-5 px-5 py-4 md:-mx-6 md:px-6">
                                    <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-5">
                                        <span
                                            className="shrink-0 text-[0.82rem] font-bold sm:w-36"
                                            style={{ color: `var(--desk-marker-${note.ink})` }}
                                        >
                                            {note.title}
                                        </span>
                                        <span className="text-[0.8rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                                            {note.detail}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* ——— 03 Agent 开放层 ——— */}
                    <section aria-labelledby="promo-agent" className="blog-home-fade-in">
                        <SectionHeading index="03" label="Open Agent Layer" title="把知识库接进你现有的 AI 工具" />
                        <h3 id="promo-agent" className="sr-only">
                            Agent 开放层
                        </h3>
                        <p className="mb-7 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            Claude Code、Codex、Cursor、ChatGPT 桌面端都可以直接读写这套知识库——鉴权、审计、能力发现都在
                            <code
                                className="mx-1 rounded-sm px-1.5 py-0.5 text-[0.75rem]"
                                style={{ background: "var(--desk-sticky)", color: "var(--desk-sticky-ink)" }}
                            >
                                /api/agent/**
                            </code>
                            统一收口。
                        </p>
                        <ol className="promo-steps space-y-6">
                            {AGENT_STEPS.map((step) => (
                                <li key={step.title} className="promo-step" data-ink={step.ink}>
                                    <h4 className="text-[0.88rem] font-bold" style={{ color: "var(--desk-sheet-ink)" }}>
                                        {step.title}
                                    </h4>
                                    <p className="mt-1.5 max-w-2xl text-[0.8rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                                        {step.detail}
                                    </p>
                                </li>
                            ))}
                        </ol>
                        <a
                            href={LINKS.agentDocs}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group/link relative mt-7 inline-flex items-center font-mono text-[0.74rem] font-bold underline decoration-transparent underline-offset-4 transition-colors duration-200 hover:decoration-current"
                            style={{ color: "var(--desk-marker-blue)" }}
                        >
                            设计文档 docs/agent-integration.md
                            <LinkDoodle />
                        </a>
                    </section>

                    {/* ——— 04 技术选型 ——— */}
                    <section aria-labelledby="promo-stack" className="blog-home-fade-in">
                        <SectionHeading index="04" label="Stack" title="技术选型" />
                        <h3 id="promo-stack" className="sr-only">
                            技术栈
                        </h3>
                        <div className="space-y-5">
                            {STACK.map((group) => (
                                <div key={group.group} className="flex flex-col gap-2.5 sm:flex-row sm:items-baseline sm:gap-6">
                                    <span
                                        className="shrink-0 font-mono text-[0.66rem] font-bold uppercase tracking-[0.18em] sm:w-16 sm:text-right"
                                        style={{ color: "var(--desk-sheet-muted)" }}
                                    >
                                        {group.group}
                                    </span>
                                    <div className="flex flex-wrap gap-2">
                                        {group.items.map((item) => (
                                            <span key={item} className="promo-chip px-2.5 py-1 font-mono text-[0.7rem] font-medium">
                                                {item}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* ——— 05 部署 ——— */}
                    <section aria-labelledby="promo-deploy" className="blog-home-fade-in">
                        <SectionHeading index="05" label="Deploy" title="5–10 分钟，从零到上线" />
                        <h3 id="promo-deploy" className="sr-only">
                            部署流程
                        </h3>
                        <ol className="promo-steps space-y-6">
                            {DEPLOY_STEPS.map((step) => (
                                <li key={step.title} className="promo-step" data-ink={step.ink}>
                                    <h4 className="text-[0.88rem] font-bold" style={{ color: "var(--desk-sheet-ink)" }}>
                                        {step.title}
                                    </h4>
                                    <p className="mt-1.5 max-w-2xl text-[0.8rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                                        {step.detail}
                                    </p>
                                </li>
                            ))}
                        </ol>

                        <div className="mt-10">
                            <p className="mb-3 text-xl" style={{ ...handwritingStyle, color: "var(--desk-sheet-soft)" }}>
                                或者本地跑一份 ↓
                            </p>
                            <div className="promo-terminal p-4 font-mono text-[0.72rem] leading-[1.95] md:p-5">
                                <div className="promo-terminal-dots mb-3" aria-hidden="true">
                                    <span style={{ background: "var(--desk-marker-red)" }} />
                                    <span style={{ background: "var(--desk-marker-orange)" }} />
                                    <span style={{ background: "var(--desk-marker-green)" }} />
                                </div>
                                {TERMINAL_LINES.map((line) => (
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
                                需要 Node ≥ 22 与 pnpm 10.x。提交前跑 pnpm typecheck / lint / test 三件套。
                            </p>
                        </div>
                    </section>

                    {/* ——— 06 架构可视化 ——— */}
                    <section aria-labelledby="promo-viz" className="blog-home-fade-in">
                        <SectionHeading index="06" label="Under the Hood" title="架构可视化" />
                        <h3 id="promo-viz" className="sr-only">
                            架构可视化
                        </h3>
                        <p className="mb-6 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                            几张交互式的手绘风拆解图，比 README 里的文字更快说清这套东西是怎么搭起来的。
                        </p>
                        <div className="promo-sheet px-5 py-1.5 md:px-6">
                            {VISUALIZATIONS.map((viz) => (
                                <a
                                    key={viz.href}
                                    href={viz.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="promo-viz-row group/link -mx-5 block px-5 py-4 md:-mx-6 md:px-6"
                                >
                                    <div className="flex items-baseline justify-between gap-4">
                                        <h4
                                            className="relative text-[0.88rem] font-bold underline decoration-transparent underline-offset-4 transition-colors duration-200 group-hover/link:decoration-current"
                                            style={{ color: "var(--desk-sheet-ink)" }}
                                        >
                                            {viz.title}
                                            <LinkDoodle />
                                        </h4>
                                    </div>
                                    <p className="mt-1 text-[0.78rem] leading-relaxed" style={{ color: "var(--desk-sheet-soft)" }}>
                                        {viz.detail}
                                    </p>
                                </a>
                            ))}
                        </div>
                    </section>

                    {/* ——— 结尾便签 ——— */}
                    <section aria-labelledby="promo-cta" className="blog-home-fade-in">
                        <h3 id="promo-cta" className="sr-only">
                            开始使用
                        </h3>
                        <div className="max-w-xl">
                            <BlueNote>
                                <span className="block break-words italic">
                                    "知识不该是一堆散落的文件，而是能被检索、复述、再生长的结构。"
                                </span>
                                <span className="mt-2.5 block not-italic">
                                    Apache-2.0 开源，允许自托管与商用改造。Fork 一份，填几个环境变量，它就是
                                    <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
                                        你自己的知识底座
                                    </a>
                                    。
                                </span>
                            </BlueNote>
                        </div>
                        <div className="mt-8 flex flex-wrap items-center gap-3">
                            <a href={LINKS.deploy} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--ink">
                                一键部署到 Vercel
                            </a>
                            <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">
                                阅读源码
                            </a>
                            <a href={LINKS.license} target="_blank" rel="noopener noreferrer" className="promo-cta promo-cta--paper">
                                License
                            </a>
                        </div>
                    </section>
                </div>
            </section>

            <div className="relative z-30 mx-auto mt-auto w-full max-w-6xl px-6 pb-8 md:px-24 lg:contents">
                <RetypesetSiteFooter dockVisible />
            </div>
        </main>
    )
}
