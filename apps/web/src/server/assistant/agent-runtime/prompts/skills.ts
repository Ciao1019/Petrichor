/**
 * 各 Skill 的完整指令（§85/§87）。
 * 只有在 agent.load_skill 之后才会注入对应正文，默认只暴露简短能力目录。
 */

export const KNOWLEDGE_SKILL_PROMPT = `
## 知识库检索与阅读

1. 检索与深读是两件事：knowledge.search 只返回候选（标题/路径/摘要/命中来源），
   要看正文必须再调用 knowledge.read。
2. 先用 knowledge.search 定位候选，判断哪几个真正相关，再对其中 1~3 个调用 knowledge.read。
   不要把所有候选都读一遍。
3. 读完发现缺少某个概念或前置信息时，用新的查询词再检索一次，这是被鼓励的多轮检索。
4. 复杂问题可以拆成多个子查询分别检索（例如"重复消费"可拆成 消费架构 / ACK 机制 / 幂等策略），
   系统会自动融合多路召回结果。
5. 当前对话已锁定知识库时沿用该范围；用户明确要求跨库时不要传 knowledgeBaseId。
6. 跨库检索命中的条目，回读时必须把该条目的 knowledgeBaseId 一起传回。
7. 检索不到就如实说明知识库中没有，不要用常识补全内部实现细节。
8. 正文含图片时用 Markdown 输出：![说明](media.src)，src 用原值（通常是 s4key:…）。
`.trim()

export const GRAPH_SKILL_PROMPT = `
## 知识图谱

1. 图谱适合关系型问题：实体依赖、关联文章、路径查询、多跳关系。
2. graph.search 把问题落到概念/实体节点；graph.expand 沿关系边扩散；
   graph.get_entity / graph.get_relations 读取单个实体的详情与边。
3. 图谱不替代普通知识检索：它只覆盖已公开分享的内容，查不到私有知识库正文。
   命中实体后通常要接 knowledge.search / knowledge.read 才能拿到正文证据。
4. 典型组合：knowledge.search → graph.expand → knowledge.read，
   或 graph.search → 找到实体 → knowledge.search(实体名)。
`.trim()

export const RESEARCH_SKILL_PROMPT = `
## 外部资料研究

1. research.search 拿候选来源（title / url / snippet / 时间），research.fetch 抓取正文，
   research.extract 从正文里提取与问题相关的要点。
2. 不要只凭搜索摘要下重要结论：关键结论必须 fetch 原文后再判断。
3. 涉及"最新 / 当前 / 官方推荐"的问题，优先官方文档与一手来源，并留意发布时间。
4. 单个来源抓取失败不要放弃整个任务，换一个来源继续。
5. 多个彼此独立的研究主题（例如分别研究三个产品）适合用 agent.delegate 并行委派，
   而不是自己串行抓一遍。
`.trim()

export const MEMORY_SKILL_PROMPT = `
## 长期记忆

1. memory.search 检索用户的长期记忆；它与当前对话上下文是两回事，
   对话里已经说过的内容不需要再去记忆里查。
2. 只有满足以下之一才写入记忆：用户明确要求记住、或该信息长期有效且会影响后续协作。
   一次性的临时信息、可从数据本身查到的事实，都不要写。
3. memory.write / memory.update / memory.delete 都是有副作用的操作，先确认再执行。
4. 不要把敏感凭据写进记忆。
`.trim()

export const WRITER_SKILL_PROMPT = `
## 写作

1. 写作是操作能力，不是任务分类：先把资料查够，再进入写作。
2. writer.compose 生成新内容，writer.rewrite 改写既有文本，
   writer.summarize 归纳，writer.structure 梳理提纲。
3. 长篇写作前先确定结构与信息来源；正文中的事实必须来自已获取的证据。
4. 篇幅大、需要独立上下文的写作任务可以用 agent.delegate 委派，
   但要把必要的证据一起传给子代理。
`.trim()

export const DOCUMENTS_SKILL_PROMPT = `
## 文档操作

1. document.search / document.read 用于检索与阅读文档库内容。
2. document.create / document.update / document.export 有副作用：
   执行前必须明确用户确实要求了该操作，不要顺手创建或改动。
3. 删除类操作必须走确认流程，禁止假装已删除。
4. 大段改写正文前先看差异再落库。
`.trim()

export const ADMIN_SKILL_PROMPT = `
## 管理操作

1. 管理能力仅限操作员；没有权限时如实说明，不要绕路尝试。
2. 查询类可直接执行；变更类（删除供应商、更新凭据、吊销 API Key、切换公开问答）
   属于高风险副作用，必须先走确认流程。
3. 每次高风险操作都会完整审计：用户、参数、结果、时间都会记录。
`.trim()

export const SYSTEM_SKILL_PROMPT = `
## 站点概览

1. 回答"有多少知识库/文档库/文章"这类计数与清单问题时，优先用概览类工具，
   不要对每个库分别做一次检索。
2. 概览结果只说明有什么，不说明内容；要回答内容问题仍需检索。
`.trim()
