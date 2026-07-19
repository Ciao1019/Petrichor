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
        tags: ["React", "Next.js"],
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
3. **公共库去重** —— 锁 pnpm resolution，消灭双版本 lodash

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

export function buildDashboardOverview(): DashboardOverviewResponse {
    const random = seededRandom(20260719)
    // 对齐真实服务端 overview-logic.ts：热力图 365 天、只统计文章发布
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

    const trend: DashboardOverviewResponse["trend"] = []
    for (let index = 29; index >= 0; index -= 1) {
        const date = new Date(end)
        date.setDate(end.getDate() - index)
        const article = Math.floor(random() * 3)
        const qa = Math.floor(random() * 4)
        const agent = Math.floor(random() * 2)
        trend.push({
            date: date.toISOString().slice(0, 10),
            article,
            qa,
            agent,
            total: article + qa + agent,
        })
    }

    return {
        kpis: {
            // 与热力图口径一致：演示帐号是「写了一年多」的人设，
            // 侧栏知识库里只放了 8 篇精选样例
            articles: total + demoStore.articles.size,
            qaThreads: 23,
            knowledgeBases: demoStore.knowledgeBases.length,
            activity7d: trend.slice(-7).reduce((sum, point) => sum + point.total, 0),
        },
        heatmap: {
            points,
            start: points[0]?.date ?? "",
            end: points[points.length - 1]?.date ?? "",
            total,
        },
        trend,
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
        recentThreads: demoStore.threads.map((thread) => thread.summary).slice(0, 5),
    }
}
