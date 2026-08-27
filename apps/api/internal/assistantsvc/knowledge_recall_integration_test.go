package assistantsvc

import (
	"context"
	"os"
	"testing"

	"petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/config"
)

// TestKnowledgeRecallLive 是显式开启的只读集成测试：使用本地 config.toml 的
// PostgreSQL 与当前 embedding 绑定，验证真实索引、向量服务和工具输出能串通。
// 默认跳过，避免普通单测依赖开发者密钥或外部模型。
func TestKnowledgeRecallLive(t *testing.T) {
	if os.Getenv("PETRICHOR_RECALL_LIVE_TEST") != "1" {
		t.Skip("设置 PETRICHOR_RECALL_LIVE_TEST=1 才运行真实召回测试")
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	aicore.WireInvokers()

	var userID, knowledgeBaseID, articleID int64
	var title string
	if err := dbPool().QueryRow(context.Background(), `
		SELECT a.user_id, a.knowledge_base_id, a.id, a.title
		FROM petrichor_kb_article a
		WHERE EXISTS (
			SELECT 1 FROM petrichor_kb_article_chunk_index i
			WHERE i.article_id = a.id AND i.user_id = a.user_id
		)
		ORDER BY a.id ASC LIMIT 1`).Scan(&userID, &knowledgeBaseID, &articleID, &title); err != nil {
		t.Fatal(err)
	}

	output, err := executeKnowledgeSearchV2(&rt.ToolExecutionContext{
		Context: context.Background(), UserID: userID,
	}, map[string]any{
		"query": title, "knowledgeBaseId": idStr(knowledgeBaseID), "limit": float64(10),
	})
	if err != nil {
		t.Fatal(err)
	}
	record, ok := output.(map[string]any)
	if !ok {
		t.Fatalf("召回输出类型错误: %T", output)
	}
	hits, _ := record["hits"].([]map[string]any)
	if len(hits) == 0 {
		t.Fatalf("真实索引未召回文章标题 %q: %#v", title, record["diagnostics"])
	}
	diagnostics, _ := record["diagnostics"].(map[string]any)
	if diagnosticListCount(diagnostics["chunkVectorKeys"]) == 0 {
		t.Fatalf("真实分片向量召回没有贡献候选: %#v", diagnostics)
	}
	if diagnosticListCount(diagnostics["chunkBm25Keys"]) == 0 {
		t.Fatalf("真实分片 BM25 没有贡献候选: %#v", diagnostics)
	}
	wantArticleID := idStr(articleID)
	for _, hit := range hits {
		if hit["articleId"] == wantArticleID {
			return
		}
	}
	t.Fatalf("召回结果没有目标文章 %s: %#v", wantArticleID, hits)
}
