package assistantsvc

import (
	"context"
	"os"
	"strconv"
	"testing"

	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/config"
)

// TestKnowledgeOutlineLive 只读集成测试：用本地 config.toml 的 PostgreSQL
// 对一篇已构建知识的文章跑 knowledge.outline，验证两条取数路径都能真实工作。
// 默认跳过。
func TestKnowledgeOutlineLive(t *testing.T) {
	if os.Getenv("PETRICHOR_OUTLINE_LIVE_TEST") != "1" {
		t.Skip("设置 PETRICHOR_OUTLINE_LIVE_TEST=1 才运行真实目录测试")
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}

	var userID, articleID int64
	if err := dbPool().QueryRow(context.Background(), `
		SELECT c.user_id, c.article_id
		FROM petrichor_kb_article_chunk c
		GROUP BY c.user_id, c.article_id
		ORDER BY COUNT(*) DESC
		LIMIT 1`).Scan(&userID, &articleID); err != nil {
		t.Skipf("没有已构建知识的文章：%v", err)
	}

	// 工具输入来自 JSON，articleId 是字符串，与 schema 声明一致。
	articleIDText := strconv.FormatInt(articleID, 10)
	ctx := &rt.ToolExecutionContext{Context: context.Background(), UserID: userID}
	output, err := executeKnowledgeOutline(ctx, map[string]any{"articleId": articleIDText})
	if err != nil {
		t.Fatalf("读取目录失败：%v", err)
	}
	result, _ := output.(map[string]any)
	nodes, _ := result["nodes"].([]outlineNode)
	if len(nodes) == 0 {
		t.Fatalf("目录为空：%#v", result)
	}
	for i := range nodes {
		if nodes[i].NodeKey == "" && nodes[i].ChunkID == "" {
			t.Fatalf("第 %d 节既没有 nodeKey 也没有 chunkId，无法回读：%#v", i, nodes[i])
		}
		if nodes[i].Title == "" {
			t.Fatalf("第 %d 节缺少标题：%#v", i, nodes[i])
		}
	}
	withQuestions := 0
	for i := range nodes {
		if len(nodes[i].Questions) > 0 {
			withQuestions++
		}
		if len(nodes[i].Questions) > outlineMaxQuestionsPerNode {
			t.Fatalf("第 %d 节推荐问题超出上限：%#v", i, nodes[i].Questions)
		}
	}
	t.Logf("《%v》来源 %v，共 %d 节，其中 %d 节带推荐问题；首节 %#v",
		result["title"], result["source"], len(nodes), withQuestions, nodes[0])

	// 越权访问必须当作不存在。
	if _, err := executeKnowledgeOutline(
		&rt.ToolExecutionContext{Context: context.Background(), UserID: userID + 999999},
		map[string]any{"articleId": articleIDText},
	); err == nil {
		t.Fatal("其他用户读取该文章目录时必须报错")
	}
}
