package kb

import (
	"testing"
	"time"
)

func TestArticleKnowledgeBuildJobResponseContainsOnlyRuntimeFields(t *testing.T) {
	now := time.Now()
	response := articleKnowledgeBuildJobResponse(&articleKnowledgeBuildJob{
		ID: "job-1", UserID: 1, KnowledgeBaseID: 2, ArticleID: 3,
		Status: "pending", CreatedAt: now, UpdatedAt: now,
	})
	for _, removed := range []string{
		"attemptCount", "maxAttempts", "nextAttemptAt", "lastError",
		"leaseExpiresAt", "heartbeatAt", "deadLetteredAt", "replayCount",
	} {
		if _, exists := response[removed]; exists {
			t.Fatalf("内存任务响应不应包含数据库字段 %q", removed)
		}
	}
}
