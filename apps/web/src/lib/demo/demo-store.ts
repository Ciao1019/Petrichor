import type {
    ArticleDetailResponse,
    AssistantPersistedPlan,
    AssistantThreadMessage,
    AssistantThreadSummary,
    DashboardOverviewResponse,
    KnowledgeBaseResponse,
    KnowledgeBaseTreeNode,
    UserProfileResponse,
} from "@/lib/api"

/*
 * 演示模式的内存数据库。
 * 模块级单例：页面刷新即重建（= 数据重置），写操作只改这里，永不触网。
 * 所有 id 带 demo- 前缀，方便在日志里一眼识别。
 */

export interface DemoNode {
    id: string
    knowledgeBaseId: string
    parentId: string | null
    type: "FOLDER" | "ARTICLE"
    name: string
    articleId: string | null
    sortOrder: number
}

export interface DemoArticle {
    articleId: string
    nodeId: string
    knowledgeBaseId: string
    title: string
    contentMd: string
    contentJson: string | null
    contentMetaJson: string | null
    tags: string[]
    createdAt: string
    updatedAt: string
}

export interface DemoThread {
    summary: AssistantThreadSummary
    messages: AssistantThreadMessage[]
    plans: AssistantPersistedPlan[]
}

function daysAgo(days: number, hour = 10) {
    const date = new Date()
    date.setDate(date.getDate() - days)
    date.setHours(hour, 30, 0, 0)
    return date.toISOString()
}

export const DEMO_USER: UserProfileResponse = {
    id: "demo-user",
    email: "demo@petrichor.app",
    systemRole: "USER",
    userType: "LOCAL",
    linuxDoBound: false,
    linuxDoUsername: null,
    linuxDoEmail: null,
    username: "demo",
    nickname: "演示访客",
    avatar: null,
    signature: "这是一个演示账号，改什么都不会保存。",
    twoFactorEnabled: false,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
}

/* ---------- 知识库 / 目录树 / 文章 fixtures ---------- */

const KB_PRODUCT = "demo-kb-product"
const KB_ENGINEERING = "demo-kb-engineering"
const KB_READING = "demo-kb-reading"

const knowledgeBases: KnowledgeBaseResponse[] = [
    {
        id: KB_PRODUCT,
        name: "Petrichor 产品手记",
        description: "这套系统本身的设计决策、路线图与踩坑记录。",
        createdAt: daysAgo(28),
        updatedAt: daysAgo(0),
    },
    {
        id: KB_ENGINEERING,
        name: "前端工程笔记",
        description: "React / TypeScript / 构建链路的日常沉淀。",
        createdAt: daysAgo(21),
        updatedAt: daysAgo(2),
    },
    {
        id: KB_READING,
        name: "读书摘录",
        description: "非虚构类读书笔记，按书拆篇。",
        createdAt: daysAgo(14),
        updatedAt: daysAgo(5),
    },
]

interface ArticleSeed {
    id: string
    kb: string
    folder: string | null
    title: string
    tags: string[]
    day: number
    md: string
}

const ARTICLE_SEEDS: ArticleSeed[] = [
    {
        id: "demo-a-runtime",
        kb: KB_PRODUCT,
        folder: "架构决策",
        title: "为什么助手运行时要自己写",
        tags: ["架构", "AI"],
        day: 1,
        md: `# 为什么助手运行时要自己写

现成的 Agent 框架很多，但都不适合「长在知识库上」这个场景。

## 核心诉求

1. **写操作必须可控** —— 助手能改文章，就必须有确认层
2. **上下文成本可控** —— 长对话要压缩历史 + 向量召回
3. **记忆要跨会话** —— 操作员偏好、项目背景要沉淀

## 取舍

| 方案 | 优点 | 问题 |
| --- | --- | --- |
| LangChain | 生态大 | 抽象层太厚，确认流程难插 |
| 裸 AI SDK | 轻、可控 | 要自己写循环 |
| **自研运行时** | 完全贴合场景 | 维护成本 |

最后选了基于 Vercel AI SDK 自己写循环：

\`\`\`ts
// 工具调用循环的核心骨架
for await (const step of runAgentLoop(messages, tools)) {
    if (step.type === "write-intent") {
        await requireUserConfirmation(step)
    }
}
\`\`\`

> 教训：**确认层要做在运行时里，不要做在工具里**——工具应该保持纯粹。
`,
    },
    {
        id: "demo-a-memory",
        kb: KB_PRODUCT,
        folder: "架构决策",
        title: "操作员多层记忆的分区设计",
        tags: ["架构", "记忆"],
        day: 3,
        md: `# 操作员多层记忆的分区设计

记忆不是一个大 JSON，而是按稳定性分层：

## 四层分区

- **user_profile** —— 用户是谁、写作偏好（最稳定）
- **agent_notes** —— 助手自己总结的工作方式
- **skills** —— 固化的可复用流程
- **session** —— 当前会话上下文（最易变）

## 进化机制

不自动写入长期记忆——由用户手动触发「进化」，
系统给出 before/after diff，确认后才落库。

\`\`\`text
对话沉淀 → 进化提案（diff 预览） → 人工确认 → 写入分区
\`\`\`

自动沉淀试过一版，误写率太高，回滚了。
`,
    },
    {
        id: "demo-a-roadmap",
        kb: KB_PRODUCT,
        folder: null,
        title: "2026 H2 路线图",
        tags: ["路线图"],
        day: 0,
        md: `# 2026 H2 路线图

## 进行中

- [x] 操作员多层记忆
- [x] 可写 Skills
- [ ] 演示模式（就是你现在看到的这个）

## 排队中

- [ ] 知识图谱视图 v2
- [ ] 移动端适配二轮
- [ ] 导入器支持 EPUB

## 原则

> 每个迭代必须能独立上线，不留半成品分支。
`,
    },
    {
        id: "demo-a-rsc",
        kb: KB_ENGINEERING,
        folder: "React",
        title: "RSC 心智模型速记",
        tags: ["React", "Bun"],
        day: 2,
        md: `# RSC 心智模型速记

Server Component 不是「在服务端渲染的组件」，
而是**只在服务端存在的组件**——它的代码永远不进客户端 bundle。

## 判断口诀

- 要交互（onClick / useState）→ Client
- 只是取数 + 排版 → Server
- 两者都要 → Server 外壳 + Client 岛

\`\`\`tsx
// Server（默认）
export default async function Page() {
    const data = await db.query(...)
    return <Chart data={data} />   // Chart 是 client 岛
}
\`\`\`

## 常见误区

1. \`"use client"\` 不是性能开关，是边界声明
2. props 穿过边界必须可序列化
3. Server Component 里 import 的库不会算进客户端体积——放心用重库
`,
    },
    {
        id: "demo-a-ts-narrow",
        kb: KB_ENGINEERING,
        folder: "TypeScript",
        title: "TS 类型收窄的七种武器",
        tags: ["TypeScript"],
        day: 6,
        md: `# TS 类型收窄的七种武器

1. \`typeof\` —— 原始类型
2. \`instanceof\` —— 类实例
3. \`in\` —— 属性存在性
4. 字面量相等 —— discriminated union 的钥匙
5. 自定义 type guard —— \`x is T\`
6. \`satisfies\` —— 校验不改推断
7. \`asserts\` —— 断言函数

最常用的还是 discriminated union：

\`\`\`ts
type Result =
    | { ok: true; data: string }
    | { ok: false; error: Error }

if (result.ok) {
    result.data  // 这里已经收窄
}
\`\`\`
`,
    },
    {
        id: "demo-a-vite-chunk",
        kb: KB_ENGINEERING,
        folder: null,
        title: "拆包实战：首屏 JS 从 1.2M 到 380K",
        tags: ["构建", "性能"],
        day: 9,
        md: `# 拆包实战：首屏 JS 从 1.2M 到 380K

## 三板斧

1. **路由级 lazy** —— 编辑器、图表页全部动态 import
2. **重库隔离** —— KaTeX / mermaid / PlateJS 各自成 chunk
3. **公共库去重** —— 锁定 bun.lock 解析结果，消灭双版本 lodash

## 量化结果

| 阶段 | 首屏 JS | LCP |
| --- | --- | --- |
| 优化前 | 1.2 MB | 3.4s |
| 路由拆分 | 720 KB | 2.1s |
| 重库隔离 | **380 KB** | **1.3s** |

> 结论：拆包顺序很重要，先拆路由再拆库，反过来收益会被路由耦合吃掉。
`,
    },
    {
        id: "demo-a-thinking-fast",
        kb: KB_READING,
        folder: null,
        title: "《思考，快与慢》：系统 1 的陷阱清单",
        tags: ["读书", "认知"],
        day: 4,
        md: `# 《思考，快与慢》：系统 1 的陷阱清单

## 印象最深的三个偏差

1. **锚定效应** —— 先看到的数字会拖住后面的判断
2. **可得性启发** —— 容易想起的例子被高估概率
3. **损失厌恶** —— 丢 100 块的痛 ≈ 捡 200 块的爽

## 对做产品的启发

- 定价页的「原价划掉」就是锚定
- 用户反馈里响的声音 ≠ 多数需求（可得性）
- 改版要给「保留旧版」出口，对冲损失厌恶

> 系统 2 很懒，别指望用户认真读你的文案。
`,
    },
    {
        id: "demo-a-staff-eng",
        kb: KB_READING,
        folder: null,
        title: "《Staff Engineer》：影响力的四种原型",
        tags: ["读书", "职业"],
        day: 8,
        md: `# 《Staff Engineer》：影响力的四种原型

- **Tech Lead** —— 带一个方向的交付
- **Architect** —— 守一个领域的长期正确
- **Solver** —— 哪里起火去哪里
- **Right Hand** —— 高管带宽的延伸

书里反复强调：Staff 的核心产出是**让别人更快**，
不是自己写更多代码。

> "Your job is to make the organization successful,
>  not to be the best engineer in the room."
`,
    },
]

/* ---------- store 状态 ---------- */

let nodeSeq = 0
let articleSeq = 0

function buildNodes(): { nodes: DemoNode[]; articles: Map<string, DemoArticle> } {
    const nodes: DemoNode[] = []
    const articles = new Map<string, DemoArticle>()
    const folderIds = new Map<string, string>()

    for (const seed of ARTICLE_SEEDS) {
        let parentId: string | null = null
        if (seed.folder) {
            const folderKey = `${seed.kb}/${seed.folder}`
            let folderId = folderIds.get(folderKey)
            if (!folderId) {
                folderId = `demo-node-folder-${folderIds.size + 1}`
                folderIds.set(folderKey, folderId)
                nodes.push({
                    id: folderId,
                    knowledgeBaseId: seed.kb,
                    parentId: null,
                    type: "FOLDER",
                    name: seed.folder,
                    articleId: null,
                    sortOrder: nodes.filter((n) => n.knowledgeBaseId === seed.kb && n.parentId === null).length,
                })
            }
            parentId = folderId
        }

        const nodeId = `demo-node-${seed.id}`
        nodes.push({
            id: nodeId,
            knowledgeBaseId: seed.kb,
            parentId,
            type: "ARTICLE",
            name: seed.title,
            articleId: seed.id,
            sortOrder: nodes.filter((n) => n.knowledgeBaseId === seed.kb && n.parentId === parentId).length,
        })
        articles.set(seed.id, {
            articleId: seed.id,
            nodeId,
            knowledgeBaseId: seed.kb,
            title: seed.title,
            contentMd: seed.md,
            contentJson: null,
            contentMetaJson: null,
            tags: seed.tags,
            createdAt: daysAgo(seed.day + 2),
            updatedAt: daysAgo(seed.day),
        })
    }
    return { nodes, articles }
}

const built = buildNodes()

export const demoStore = {
    knowledgeBases,
    nodes: built.nodes,
    articles: built.articles,
    threads: [] as DemoThread[],
}

/* ---------- 查询 / 变更助手 ---------- */

export function kbById(id: string) {
    return demoStore.knowledgeBases.find((kb) => kb.id === id) ?? null
}

export function nodesOf(knowledgeBaseId: string, parentId: string | null) {
    return demoStore.nodes
        .filter((node) => node.knowledgeBaseId === knowledgeBaseId && node.parentId === parentId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

export function toTreeNode(node: DemoNode, withChildren: boolean): KnowledgeBaseTreeNode {
    const children = nodesOf(node.knowledgeBaseId, node.id)
    return {
        id: node.id,
        parentId: node.parentId,
        type: node.type,
        name: node.name,
        articleId: node.articleId,
        sortOrder: node.sortOrder,
        hasChildren: children.length > 0,
        ...(withChildren ? { children: children.map((child) => toTreeNode(child, true)) } : {}),
    }
}

export function nodePath(node: DemoNode): string {
    const segments = [node.name]
    let current = node
    while (current.parentId) {
        const parent = demoStore.nodes.find((item) => item.id === current.parentId)
        if (!parent) break
        segments.unshift(parent.name)
        current = parent
    }
    return `/${segments.join("/")}`
}

export function articleDetail(articleId: string): ArticleDetailResponse | null {
    const article = demoStore.articles.get(articleId)
    if (!article) return null
    const node = demoStore.nodes.find((item) => item.id === article.nodeId)
    return {
        articleId: article.articleId,
        nodeId: article.nodeId,
        knowledgeBaseId: article.knowledgeBaseId,
        parentId: node?.parentId ?? null,
        title: article.title,
        contentMd: article.contentMd,
        contentJson: article.contentJson,
        contentMetaJson: article.contentMetaJson,
        aiSummary: null,
        aiSummaryGeneratedAt: null,
        aiSummaryStale: false,
        tags: article.tags,
        path: node ? nodePath(node) : `/${article.title}`,
        permission: "OWNER",
        readOnly: false,
        createdAt: article.createdAt,
        updatedAt: article.updatedAt,
    }
}

export function nextNodeId() {
    nodeSeq += 1
    return `demo-node-new-${nodeSeq}`
}

export function nextArticleId() {
    articleSeq += 1
    return `demo-article-new-${articleSeq}`
}

export function touchKb(knowledgeBaseId: string) {
    const kb = kbById(knowledgeBaseId)
    if (kb) kb.updatedAt = new Date().toISOString()
}

/* ---------- 仪表盘 fixtures ---------- */

/** 稳定伪随机（同一次会话内热力图不跳动） */
function seededRandom(seed: number) {
    let value = seed
    return () => {
        value = (value * 9301 + 49297) % 233280
        return value / 233280
    }
}

/** 从日序列构造 KPI 磁贴，口径与服务端 buildKpiTile 保持一致 */
function demoKpiTile(input: {
    key: string
    label: string
    total: number
    series: number[]
    unit?: string
}): DashboardOverviewResponse["kpis"]["primary"][number] {
    const current = input.series.slice(-7).reduce((sum, value) => sum + value, 0)
    const previous = input.series.slice(-14, -7).reduce((sum, value) => sum + value, 0)
    return {
        key: input.key,
        label: input.label,
        value: input.total,
        current,
        previous,
        delta: previous > 0 ? ((current - previous) / previous) * 100 : null,
        spark: input.series.slice(-14),
        unit: input.unit,
    }
}

export function buildDashboardOverview(): DashboardOverviewResponse {
    const random = seededRandom(20260719)
    // 对齐真实服务端 overview-logic.ts：热力图与趋势都是 365 天、热力图只统计文章发布
    const heatmapDays = 365
    const points: { date: string; count: number }[] = []
    const end = new Date()
    for (let index = heatmapDays - 1; index >= 0; index -= 1) {
        const date = new Date(end)
        date.setDate(end.getDate() - index)
        const weekday = date.getDay()
        // 工作日 ~1/3 概率有产出、周末更低，count 以 1-2 为主，偶发高产日
        const base = weekday === 0 || weekday === 6 ? 0.14 : 0.34
        const roll = random()
        const count = roll < base ? (roll < base * 0.15 ? 3 + Math.floor(random() * 3) : 1 + Math.floor(random() * 2)) : 0
        points.push({ date: date.toISOString().slice(0, 10), count })
    }
    const total = points.reduce((sum, point) => sum + point.count, 0)

    // 趋势与热力图共用同一批文章数，助手与 Agent 另外生成
    const trend: DashboardOverviewResponse["trend"] = points.map((point) => {
        const qa = Math.floor(random() * 4)
        const agent = Math.floor(random() * 6)
        return {
            date: point.date,
            article: point.count,
            qa,
            agent,
            total: point.count + qa + agent,
        }
    })

    const articleSeries = trend.map((point) => point.article)
    const qaSeries = trend.map((point) => point.qa)
    const agentSeries = trend.map((point) => point.agent)
    // 每篇按 800-2400 字估算，累计字数跟着文章数走
    const wordSeries = articleSeries.map((count) => count * (800 + Math.floor(random() * 1600)))
    const totalArticles = total + demoStore.articles.size
    const totalWords = wordSeries.reduce((sum, value) => sum + value, 0) + 42_000
    const totalAgentCalls = agentSeries.reduce((sum, value) => sum + value, 0)

    // 按月累计
    const growth: DashboardOverviewResponse["growth"] = []
    {
        const byMonth = new Map<string, { articles: number; words: number }>()
        const order: string[] = []
        trend.forEach((point, index) => {
            const month = point.date.slice(0, 7)
            let bucket = byMonth.get(month)
            if (!bucket) {
                bucket = { articles: 0, words: 0 }
                byMonth.set(month, bucket)
                order.push(month)
            }
            bucket.articles += point.article
            bucket.words += wordSeries[index] ?? 0
        })
        let articles = demoStore.articles.size
        let words = 42_000
        for (const month of order) {
            const bucket = byMonth.get(month)
            articles += bucket?.articles ?? 0
            words += bucket?.words ?? 0
            growth.push({ month, articles, words })
        }
    }

    // 创作节律：晚间与周末更集中，让演示数据看起来有规律
    const rhythmCells: DashboardOverviewResponse["rhythm"]["cells"] = []
    for (let weekday = 0; weekday < 7; weekday += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
            const evening = hour >= 20 || hour <= 1
            const workday = weekday >= 1 && weekday <= 5
            const weight = (evening ? 0.5 : hour >= 9 && hour <= 18 ? 0.2 : 0.05) * (workday ? 1 : 0.6)
            rhythmCells.push({
                weekday,
                hour,
                count: random() < weight ? 1 + Math.floor(random() * 3) : 0,
            })
        }
    }

    const agentDaily = trend.slice(-30).map((point) => ({
        date: point.date,
        count: point.agent,
        avgMs: 90 + Math.floor(random() * 180),
        errors: random() < 0.12 ? 1 : 0,
    }))
    const agentWindowCalls = agentDaily.reduce((sum, point) => sum + point.count, 0)
    const agentErrors = agentDaily.reduce((sum, point) => sum + point.errors, 0)
    const clientErrors = Math.ceil(agentErrors * 0.7)

    return {
        generatedAt: new Date().toISOString(),
        kpis: {
            // 与热力图口径一致：演示帐号是「写了一年多」的人设，
            // 侧栏知识库里只放了 8 篇精选样例
            primary: [
                demoKpiTile({ key: "articles", label: "文章总数", total: totalArticles, series: articleSeries }),
                demoKpiTile({ key: "words", label: "累计字数", total: totalWords, series: wordSeries, unit: "字" }),
                demoKpiTile({ key: "threads", label: "助手对话", total: 23, series: qaSeries }),
                demoKpiTile({ key: "agentCalls", label: "Agent 调用", total: totalAgentCalls, series: agentSeries }),
            ],
            secondary: [
                { key: "knowledgeBases", label: "知识库", value: demoStore.knowledgeBases.length },
                { key: "wikiPages", label: "Wiki 页面", value: 36 },
                { key: "documents", label: "文档", value: 12, hint: "348 页" },
                { key: "tags", label: "标签", value: 17 },
                { key: "graphNodes", label: "图谱节点", value: 64, hint: "48 已发布" },
                { key: "graphEdges", label: "图谱关系", value: 92 },
                { key: "readingMinutes", label: "阅读时长", value: 486, hint: "分钟" },
            ],
        },
        heatmap: {
            points,
            start: points[0]?.date ?? "",
            end: points[points.length - 1]?.date ?? "",
            total,
        },
        trend,
        growth: growth.slice(-12),
        rhythm: {
            cells: rhythmCells,
            total: rhythmCells.reduce((sum, cell) => sum + cell.count, 0),
        },
        distribution: {
            knowledgeBases: demoStore.knowledgeBases.map((kb) => ({
                label: kb.name,
                count: [...demoStore.articles.values()].filter((article) => article.knowledgeBaseId === kb.id).length,
            })),
            tags: [
                { label: "架构", count: 5 },
                { label: "React", count: 4 },
                { label: "TypeScript", count: 3 },
                { label: "读书", count: 3 },
                { label: "性能", count: 2 },
            ],
        },
        assets: [
            { label: "文章", count: totalArticles },
            { label: "Wiki 页面", count: 36 },
            { label: "文档", count: 12 },
            { label: "图谱节点", count: 64 },
        ],
        agent: {
            windowDays: 30,
            totalCalls: agentWindowCalls,
            successCalls: agentWindowCalls - agentErrors,
            clientErrors,
            serverErrors: agentErrors - clientErrors,
            successRate: agentWindowCalls > 0 ? ((agentWindowCalls - agentErrors) / agentWindowCalls) * 100 : 0,
            avgDurationMs: 148,
            maxDurationMs: 2860,
            topPaths: [
                { path: "/api/agent/kb/search", method: "POST", count: 148, avgMs: 132, errorCount: 1 },
                { path: "/api/agent/kb/article", method: "POST", count: 96, avgMs: 210, errorCount: 0 },
                { path: "/api/agent/wiki/page", method: "POST", count: 54, avgMs: 178, errorCount: 2 },
                { path: "/api/agent/kb/list", method: "POST", count: 32, avgMs: 88, errorCount: 0 },
            ],
            daily: agentDaily,
        },
        tools: {
            windowDays: 30,
            items: [
                { name: "kb_search", count: 86, okCount: 84, avgMs: 420 },
                { name: "kb_read_article", count: 62, okCount: 62, avgMs: 180 },
                { name: "web_search", count: 41, okCount: 38, avgMs: 1240 },
                { name: "kb_write_article", count: 24, okCount: 23, avgMs: 960 },
                { name: "wiki_upsert_page", count: 18, okCount: 18, avgMs: 640 },
                { name: "upsert_plan", count: 12, okCount: 12, avgMs: 40 },
            ],
        },
        pipeline: {
            documents: [
                { status: "ready", count: 9 },
                { status: "parsing", count: 2 },
                { status: "failed", count: 1 },
            ],
            imports: [
                { status: "completed", count: 6 },
                { status: "pending", count: 1 },
            ],
            documentTotal: 12,
            documentBytes: 86_400_000,
            documentPages: 348,
            importTotal: 7,
        },
        recentActivity: [
            ...[...demoStore.articles.values()].slice(0, 4).map((article) => ({
                kind: "article" as const,
                id: article.articleId,
                title: article.title,
                subtitle:
                    demoStore.knowledgeBases.find((kb) => kb.id === article.knowledgeBaseId)?.name ?? null,
                at: article.updatedAt,
            })),
            ...demoStore.threads.slice(0, 4).map((thread) => ({
                kind: "thread" as const,
                id: thread.summary.id,
                title: thread.summary.title || "未命名对话",
                subtitle: null,
                at: thread.summary.updatedAt ?? thread.summary.createdAt,
            })),
        ]
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 8),
        recentThreads: demoStore.threads.map((thread) => thread.summary).slice(0, 5),
    }
}
