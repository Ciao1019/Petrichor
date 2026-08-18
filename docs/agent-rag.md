# Agent RAG

## 检索管线

```text
User Query
  ↓ （复杂问题才拆子查询，简单问题不改写）
Query Rewrite
  ↓
┌── Tree Recall    （PageIndex 式目录导航，LLM 失败退回关键词）
├── Vector Recall  （pgvector，含 embedding profile 隔离）
└── BM25 Recall    （中文 n-gram 词元 + 应用层 BM25 打分）
  ↓
RRF 融合（只依赖排名，跨召回源可比）
  ↓
Reranker（可插拔，失败即回落 RRF 顺序）
  ↓
Candidate Nodes   ← knowledge.search 到此为止，只返回定位信息
  ↓
Agent 决定读哪几个
  ↓
knowledge.read → Evidence
```

**Search ≠ Read**：`knowledge.search` 不返回全文，正文必须由 Agent 判断后显式 `read`。

## BM25 实现

Postgres 内置 parser 无法正确切中文，因此：

1. 写入时（`buildArticleTree`）把 title / summary / content 展开成 2 字 n-gram 词元，
   存进 `search_title_tokens` / `search_summary_tokens` / `search_content_tokens`；
2. 生成列 `search_vector` 用 `setweight(A/B/C)` 组合三段，GIN 索引承接查询；
3. 查询时先用 GIN 索引收窄候选池（默认 400 条），再在应用层做真正的 BM25 打分
   （`ts_rank` 不是 BM25，字段权重与长度归一都对不上）。

迁移未执行或使用 SQLite 时自动退回整表扫描路径，功能不受影响，只是召回范围变小。

## 配置

```env
RAG_BM25=true
RAG_RRF=true
RAG_RERANK_ENABLED=false
RAG_RERANK_PROVIDER=openai-compatible   # openai-compatible | bge | cross-encoder
RAG_RERANK_MODEL=bge-reranker-v2-m3
RAG_RERANK_BASE_URL=
RAG_RERANK_API_KEY=
RAG_RERANK_TOP_N=10

RAG_TREE_TOP_K=10
RAG_VECTOR_TOP_K=10
RAG_BM25_TOP_K=10
RAG_FUSION_TOP_K=20
RAG_FINAL_TOP_K=10
RAG_RRF_K=60

RAG_BM25_W_TITLE=3
RAG_BM25_W_SUMMARY=2
RAG_BM25_W_CONTENT=1
```

## 降级

| 故障 | 行为 |
| --- | --- |
| Reranker 挂了 | 回落 RRF 顺序，记录 `rerankError` |
| Vector 挂了 | Tree + BM25 继续 |
| Tree 的 LLM 挂了 | 关键词 fallback（既有实现） |
| 全部召回为空 | 返回 no result 观察，建议改写查询或加载 research |

各路降级原因写入检索诊断 `diagnostics.degraded`，并进 Trace。

## 外部研究

站内此前没有联网检索能力，新增 `apps/web/src/server/research/`：

```env
RESEARCH_SEARCH_PROVIDER=   # tavily | serper | brave | searxng，留空即关闭
RESEARCH_SEARCH_API_KEY=
RESEARCH_SEARCH_BASE_URL=   # searxng 必填
```

未配置时 `research.search` 返回 `not_configured`，Agent 会退回站内资料并如实告知用户，
而不是编造外部结论。`research.fetch` 只依赖标准 fetch，内置 SSRF 防护（阻断内网与非 http(s)）。
