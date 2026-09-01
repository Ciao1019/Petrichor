package assistantsvc

import (
	rt "petrichor/api/internal/assistantsvc/runtime"
)

const kbListSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"articleId":{"type":"string","description":"可选，限定文章"}}}`

const searchSchema = `{"type":"object","properties":{"query":{"type":"string","description":"检索问题"},"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"limit":{"type":"integer","minimum":1,"maximum":20,"description":"返回条数，缺省 10"},"subQueries":{"type":"array","maxItems":4,"items":{"type":"string"},"description":"复杂问题的补充检索词"}},"required":["query"]}`

const lookupSchema = `{"type":"object","properties":{"query":{"type":"string","description":"检索词"},"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"}},"required":["query"]}`

const readManySchema = `{"type":"object","properties":{"nodes":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"knowledgeBaseId":{"type":"string"},"chunkId":{"type":"string"},"pageKey":{"type":"string"},"nodeKey":{"type":"string"},"articleId":{"type":"string"}}}}},"required":["nodes"]}`

const readOneSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":"string"},"chunkId":{"type":"string"},"pageKey":{"type":"string"},"nodeKey":{"type":"string"},"articleId":{"type":"string"}}}`

const listBasesSchema = `{"type":"object","properties":{}}`

func registerKnowledgeTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.list_bases", Name: "list_knowledge_bases", Namespace: rt.NamespaceKnowledge,
		Description: "列出当前用户全部知识库（id / 名称 / 描述）。",
		InputSchema: schemaJSON(listBasesSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute: executeKnowledgeListBases,
		Normalize: func(output any, input any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已列出全部知识库"}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.search", Name: "search_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "检索站内知识库，联合原始分片、推荐问题、Wiki 页面和存量目录，经过 BM25/向量融合、重排与去重后返回候选；不返回正文，需要证据时继续 read/read_many。",
		InputSchema: schemaJSON(searchSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeSearch,
		Normalize: normalizeSearchOutput,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.lookup", Name: "lookup_knowledge", Namespace: rt.NamespaceKnowledge,
		Description: "一站式复合检索：混合召回并直接深读最相关的 1~2 个章节，返回独立可追溯证据。简单的定义、功能、用途、用法问题优先使用。",
		InputSchema: schemaJSON(lookupSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeLookup,
		Normalize: normalizeLookupOutput,
		TimeoutMs: 60000,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read_many", Name: "read_knowledge_nodes", Namespace: rt.NamespaceKnowledge,
		Description: "并行深读多个章节/文章，返回每个目标的正文片段（含层级上下文）。",
		InputSchema: schemaJSON(readManySchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeReadMany,
		Normalize: normalizeReadOutput,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read", Name: "read_knowledge_node", Namespace: rt.NamespaceKnowledge,
		Description: "深读单个文章或章节，返回正文片段（含层级上下文）。只读一个明确章节时使用。",
		InputSchema: schemaJSON(readOneSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeReadOne,
		Normalize: normalizeReadOutput,
	})

	registerWikiTools(registry)
	registerOutlineTools(registry)
}

// ===== 工具实现 =====
