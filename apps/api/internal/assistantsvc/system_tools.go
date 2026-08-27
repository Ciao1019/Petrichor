package assistantsvc

import (
	"fmt"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func registerSystemTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "system.overview", Name: "list_system_overview", Namespace: rt.NamespaceSystem,
		Description: "读取当前用户的知识库、文章、文档库、文档、对话计数，以及默认对话/向量模型是否就绪。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`),
		RiskLevel:   rt.RiskLow, Core: true,
		Execute: executeSystemOverview,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{
				Summary: "已读取站点资源与模型就绪概览", Data: mustJSON(output), Progress: boolPtr(true),
			}
		},
	})
}

func executeSystemOverview(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	var knowledgeBases, articles, docLibraries, documents, assistantThreads int64
	var chatModelReady, embeddingModelReady bool
	err := dbPool().QueryRow(toolContext(ctx), `
		SELECT
			(SELECT count(*) FROM petrichor_kb_knowledge_base WHERE user_id=$1),
			(SELECT count(*) FROM petrichor_kb_article WHERE user_id=$1),
			(SELECT count(*) FROM petrichor_doc_library WHERE user_id=$1),
			(SELECT count(*) FROM petrichor_doc_document WHERE user_id=$1),
			(SELECT count(*) FROM petrichor_assistant_thread WHERE user_id=$1 AND deleted_at IS NULL),
			EXISTS(
				SELECT 1 FROM petrichor_ai_binding b
				JOIN petrichor_ai_model m ON m.id=b.model_ref_id AND m.user_id=b.user_id
				JOIN petrichor_ai_provider p ON p.id=m.provider_id AND p.user_id=m.user_id
				WHERE b.user_id=$1 AND b.purpose='CHAT' AND m.kind='LANGUAGE' AND m.enabled=true AND p.enabled=true
			),
			EXISTS(
				SELECT 1 FROM petrichor_ai_binding b
				JOIN petrichor_ai_model m ON m.id=b.model_ref_id AND m.user_id=b.user_id
				JOIN petrichor_ai_provider p ON p.id=m.provider_id AND p.user_id=m.user_id
				WHERE b.user_id=$1 AND b.purpose='EMBEDDING' AND m.kind='EMBEDDING' AND m.enabled=true AND p.enabled=true
			)`, ctx.UserID).Scan(
		&knowledgeBases, &articles, &docLibraries, &documents, &assistantThreads,
		&chatModelReady, &embeddingModelReady,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"knowledgeBases": knowledgeBases, "articles": articles,
		"docLibraries": docLibraries, "documents": documents,
		"assistantThreads": assistantThreads,
		"chatModelReady":   chatModelReady, "embeddingModelReady": embeddingModelReady,
		"summary": fmt.Sprintf("%d 个知识库、%d 篇文章、%d 个文档库、%d 份文档、%d 个对话",
			knowledgeBases, articles, docLibraries, documents, assistantThreads),
	}, nil
}
