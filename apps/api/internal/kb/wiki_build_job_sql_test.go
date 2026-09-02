package kb

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/hibiken/asynq"

	"petrichor/api/internal/taskqueue"
)

func TestArticleKnowledgeBuildJobResponseDoesNotExposeAsynqError(t *testing.T) {
	now := time.Now().UTC()
	payload, err := json.Marshal(taskqueue.KnowledgeBuildPayload{
		UserID: 1, KnowledgeBaseID: 2, ArticleID: 3, CreatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := articleKnowledgeBuildJobResponse(&asynq.TaskInfo{
		ID: "job-1", Type: taskqueue.TypeKnowledgeBuild, Payload: payload,
		State: asynq.TaskStateArchived, LastErr: "内部堆栈", LastFailedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if message, ok := response["error"].(*string); ok && message != nil && *message == "内部堆栈" {
		t.Fatal("Asynq 内部错误不应直接暴露给用户")
	}
}

func TestArticleKnowledgeBuildJobResponseContainsOnlyRuntimeFields(t *testing.T) {
	now := time.Now().UTC()
	payload, err := json.Marshal(taskqueue.KnowledgeBuildPayload{
		UserID: 1, KnowledgeBaseID: 2, ArticleID: 3, CreatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := articleKnowledgeBuildJobResponse(&asynq.TaskInfo{
		ID: "job-1", Type: taskqueue.TypeKnowledgeBuild, Payload: payload, State: asynq.TaskStatePending,
	})
	if err != nil {
		t.Fatalf("组装任务响应失败: %v", err)
	}
	for _, removed := range []string{
		"attemptCount", "maxAttempts", "nextAttemptAt", "lastError",
		"leaseExpiresAt", "heartbeatAt", "deadLetteredAt", "replayCount",
	} {
		if _, exists := response[removed]; exists {
			t.Fatalf("Asynq 任务响应不应包含数据库字段 %q", removed)
		}
	}
}
