package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

func TestCreateImportHTTPIdempotentResponseAndConflictWithoutDatabase(t *testing.T) {
	store := importSafetyStore(t)
	source := "uploads/7/a.pdf"
	job, err := store.Create(context.Background(), JobRow{UserID: 7, KnowledgeBaseID: 9, FileName: "a.pdf", Title: "A", SourceKey: &source,
		SourceType: "pdf", Stage: "preparing", Concurrency: 4, IdempotencyKey: importTestUUID})
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(httpx.RequestBodyLimit(4<<20, 128<<20))
	router.Use(func(c *gin.Context) { c.Set("petrichor.user", &auth.User{ID: 7}); c.Next() })
	router.POST("/api/kb/import/create", CreateImportJob)
	base := map[string]any{"knowledgeBaseId": "9", "fileName": "a.pdf", "title": "A", "sourceKey": "s4key:" + source, "idempotencyKey": strings.ToUpper(importTestUUID)}
	request := func(body map[string]any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/api/kb/import/create", strings.NewReader(string(data)))
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	var wg sync.WaitGroup
	responses := make([]*httptest.ResponseRecorder, 12)
	for i := range responses {
		wg.Add(1)
		go func(i int) { defer wg.Done(); responses[i] = request(base) }(i)
	}
	wg.Wait()
	for _, response := range responses {
		body := response.Body.String()
		if response.Code != 200 || !strings.Contains(body, fmt.Sprintf(`"id":"%d"`, job.ID)) || !strings.Contains(body, `"stage":"preparing"`) || !strings.Contains(body, `"articleId":null`) || strings.Contains(body, "ocrPageNos") || strings.Contains(body, "isComplex") {
			t.Fatalf("%d %s", response.Code, body)
		}
	}
	_, total, err := store.List(context.Background(), 7, nil, 0, 100)
	if err != nil || total != 1 {
		t.Fatalf("total=%d %v", total, err)
	}
	counts, err := taskqueue.QueueStatusCounts(taskqueue.QueueDocumentImport)
	if err != nil || len(counts) == 0 {
		t.Fatalf("幂等命中没有补入队: %+v %v", counts, err)
	}
	for field, value := range map[string]any{"knowledgeBaseId": "10", "parentId": "2", "fileName": "b.pdf", "title": "B", "sourceKey": "uploads/7/b.pdf", "modelConfigId": "3", "concurrency": 8} {
		changed := make(map[string]any, len(base)+1)
		for k, v := range base {
			changed[k] = v
		}
		changed[field] = value
		response := request(changed)
		if response.Code != 409 {
			t.Fatalf("%s: %d %s", field, response.Code, response.Body.String())
		}
	}
}
