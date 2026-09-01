# Agent RAG

## 检索管线

```text
User Query
  ↓ （复杂问题才拆子查询，简单问题不改写）
Query Rewrite
  ↓
┌── Chunk Vector / BM25    （原文分片，精确事实与引用）
├── Question Vector / BM25 （分片的推荐问题，命中后映射回原分片）
└── Wiki Search            （实体、概念等 Wiki 页面，负责概念导航）
  ↓
RRF 融合（只依赖排名，跨召回源可比）
  ↓
Reranker（可插拔，失败即回落 RRF 顺序）
  ↓
Candidate Chunks / Wiki Pages ← knowledge.search 到此为止，只返回定位信息
  ↓
Agent 决定读哪几个
  ↓
knowledge.read → Evidence
```

## 结构性检索

相似度召回擅长「哪一段最像这个问题」，但对结构性问题很弱——「这份文档哪几章讲了
某主题」「按章节顺序汇总」这类需求里，相似度会把文档结构打散。这类问题走一条正交
路径：`knowledge.outline` 直接把整篇文档的目录摊给模型，由模型挑章节，再用返回的
`nodeKey` / `chunkId` 走 `knowledge.read`。

目录有两个来源，按优先级：

1. `petrichor_kb_wiki_tree_node`：`/kb/wiki/ingest` 编译出的 PageIndex 目录树，带 LLM 章节摘要；
2. `petrichor_kb_article_chunk` 的标题路径：每篇「构建知识」过的文章都有，
   并带上该分片的推荐问题——比标题更能说明这一节回答了什么。

注意「构建知识」会清掉该文章的目录树节点，所以实际部署里第二条往往才是主路径。
实现见 `apps/api/internal/assistantsvc/outline_tools.go`。

## Search / Outline / Read 的分工

**Search ≠ Read**：`knowledge.search` 不返回全文，正文必须由 Agent 判断后显式 `read`。
问题索引只是原文分片的“别名入口”，不会成为独立证据；问题命中后 `knowledge.read`
仍按 `chunkId` 读取原始分片。Wiki 用来解释概念和发现关联，具体事实、步骤或冲突结论
以原文分片为准。

文章知识构建先持久化所有分片索引，再持久化每个分片的推荐问题索引。向量补写同样严格
分两阶段执行：只有当前知识库的全部分片向量 ready 后，才开始问题向量。这样不会出现
问题可召回、对应原文分片却还不可召回的半完成状态。

旧 `petrichor_kb_wiki_tree_node` 召回仅作为存量数据兼容路径：新版分片、问题和 Wiki
三路都没有命中时才启用，不再是新文章知识的主索引。

## BM25 实现

Postgres 内置 parser 无法正确切中文，因此：

1. 写入时把文章标题、标题路径与分片正文（或推荐问题）拼成 `embedding_text`，并展开
   成中英文兼容的 n-gram 词元，存进 `search_tokens`；
2. 生成列 `search_vector` 承接 GIN 候选筛选；
3. 查询时先用 GIN 索引收窄候选池（默认 400 条），再在应用层做真正的 BM25 打分
   （`ts_rank` 不是 BM25，字段权重与长度归一都对不上）。

使用 SQLite 时自动退回原文字段候选扫描，便于本地开发和测试。生产环境必须先执行对应
迁移，确保索引表和 GIN 索引存在。

## 配置

检索预算与 BM25 / RRF 权重目前由
`apps/api/internal/assistantsvc/knowledge_recall.go` 的常量统一管理，不读取旧版
`RAG_*` 环境变量。模型和 Embedding 选择仍通过后台的 AI 场景绑定配置。

## 降级

| 故障 | 行为 |
| --- | --- |
| Reranker 挂了 | 回落 RRF 顺序，记录 `rerankError` |
| Chunk / Question Vector 挂了 | 对应 BM25 与 Wiki 继续 |
| Wiki 检索挂了 | 分片和问题召回继续 |
| 新版三路全空 | 回退旧 Wiki Tree 向量 / BM25 / 目录导航 |
| 全部召回为空 | 返回 no result 观察，建议改写查询或加载 research |

各路降级原因写入检索诊断 `diagnostics.degraded`，并进 Trace。

## 外部研究

联网检索由 `apps/api/internal/assistantsvc/research_tools.go` 提供，配置写入 Go TOML：

```toml
[agent.research]
provider = ""  # tavily | serper | brave | searxng，留空即关闭
api_key = ""
base_url = "" # searxng 必填
timeout_ms = 12000
```

未配置时 `research.search` 返回 `not_configured`，Agent 会退回站内资料并如实告知用户，
而不是编造外部结论。`research.fetch` 只依赖标准 fetch，内置 SSRF 防护（阻断内网与非 http(s)）。
