package kb

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"petrichor/api/internal/config"
	"petrichor/api/internal/typesafe"
)

func TestInboxRecommendationDatabaseLifecycle(t *testing.T) {
	q := inboxTestPool(t)
	oldPool, oldCfg := pool, config.Get().TypeSafe
	pool = func() *pgxpool.Pool { return q }
	t.Cleanup(func() { pool = oldPool; config.Get().TypeSafe = oldCfg })
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO petrichor_user(email,password_hash) VALUES ('rec@test.invalid','unused'),('other@test.invalid','unused')`,
		`INSERT INTO petrichor_kb_knowledge_base(user_id,name,description) VALUES (1,'数据库','PostgreSQL'),(2,'其他用户的秘密库','secret description')`,
		`INSERT INTO petrichor_kb_node(user_id,knowledge_base_id,type,name) VALUES (1,1,'FOLDER','PostgreSQL'),(2,2,'FOLDER','秘密文件夹')`,
	} {
		if _, err := q.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = inboxRequest(CreateInboxNote, 1, map[string]any{"clientId": "tag-candidate-source", "contentMd": "标签来源", "tags": []string{"数据库"}})
	_, _ = inboxRequest(CreateInboxNote, 2, map[string]any{"clientId": "other-user-private", "contentMd": "secret note", "tags": []string{"秘密标签"}})
	code, note := inboxRequest(CreateInboxNote, 1, map[string]any{"clientId": "recommend-this-note", "contentMd": "PostgreSQL 索引", "tags": []string{"随手记"}})
	if code != 200 {
		t.Fatal(note)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			State     any                          `json:"state"`
			Questions map[string]typesafe.Question `json:"questions"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("无效请求")
		}
		raw, _ := json.Marshal(body)
		if strings.Contains(string(raw), "秘密") || strings.Contains(string(raw), "secret") {
			t.Error("候选跨用户泄漏")
		}
		answers := map[string]any{}
		for id, question := range body.Questions {
			if question.Type == "noul" {
				answers[id] = map[string]any{"type": "noul", "noul": .95}
				continue
			}
			choice := "b0"
			if id == "folder" {
				choice = "f0"
			}
			probabilities := map[string]float64{}
			for key := range question.Criteria {
				probabilities[key] = 0
			}
			probabilities[choice] = 1
			answers[id] = map[string]any{"type": "choice", "choice": choice, "probabilities": probabilities, "confidence": .95}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "jev-1.13.0", "answers": answers})
	}))
	defer server.Close()
	config.Get().TypeSafe = config.TypeSafeConfig{Enabled: true, APIKey: "test-only", BaseURL: server.URL, Model: "jev-1.13.0", TimeoutSeconds: 5, MinConfidence: .7, TagThreshold: .85}
	request := map[string]any{"id": note["id"], "version": note["version"]}
	if status, _ := inboxRequest(RecommendInboxArchive, 2, request); status != 404 {
		t.Fatal("其他用户可读取随笔", status)
	}
	code, result := inboxRequest(RecommendInboxArchive, 1, request)
	if code != 200 || result["status"] != "recommended" || calls != 2 {
		t.Fatal(code, result, calls)
	}
	destination := result["destination"].(map[string]any)
	if destination["knowledgeBaseId"] != "1" || destination["parentId"] != "1" {
		t.Fatal(destination)
	}
	archive := map[string]any{"id": note["id"], "version": note["version"], "knowledgeBaseId": "1", "parentId": "1", "title": "索引笔记", "tags": []string{"随手记", "秘密标签"}}
	if code, _ = inboxRequest(ArchiveInboxNote, 1, archive); code != 400 {
		t.Fatal("不能新增其他用户的标签", code)
	}
	archive["tags"] = []string{"随手记", "数据库"}
	archive["recommendationToken"] = result["feedbackToken"]
	archive["recommendationApplied"] = true
	var feedback bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&feedback, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	code, archived := inboxRequest(ArchiveInboxNote, 1, archive)
	if code != 200 {
		t.Fatal(code, archived)
	}
	if len(archived["tags"].([]any)) != 1 {
		t.Fatal("原随笔标签被修改")
	}
	// 幂等重试的表单内容并未再次保存，不能把它记录为新的修改反馈。
	archive["tags"] = []string{}
	if code, repeated := inboxRequest(ArchiveInboxNote, 1, archive); code != 200 || repeated["articleId"] != archived["articleId"] {
		t.Fatal("重复归档未返回原文章", code)
	}
	if strings.Count(feedback.String(), "inbox_recommendation_archived") != 1 || !strings.Contains(feedback.String(), `"outcome":"accepted"`) || !strings.Contains(feedback.String(), `"applied":true`) {
		t.Fatal("采纳记录缺失或被重复提交污染")
	}
	var count int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM petrichor_kb_article_tag WHERE article_id=$1`, archived["articleId"]).Scan(&count); err != nil || count != 2 {
		t.Fatal("推荐标签未落到文章", count, err)
	}
	if code, _ = inboxRequest(RecommendInboxArchive, 1, request); code != 409 {
		t.Fatal("已归档随笔不应再次调用模型", code)
	}
}
