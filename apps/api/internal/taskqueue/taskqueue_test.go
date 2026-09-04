package taskqueue

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

func TestKnowledgeBuildTimeoutIsThirtyMinutes(t *testing.T) {
	if KnowledgeBuildTimeout != 30*time.Minute {
		t.Fatalf("知识构建任务超时=%s，期望 30m", KnowledgeBuildTimeout)
	}
}

func TestKnowledgeBuildTaskPayloadRoundTrip(t *testing.T) {
	createdAt := time.Now().UTC().Truncate(time.Microsecond)
	payload := KnowledgeBuildPayload{
		UserID: 1, KnowledgeBaseID: 2, ArticleID: 3, CreatedAt: createdAt,
	}
	task, err := NewKnowledgeBuildTask(payload)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeKnowledgeBuildPayload(task)
	if err != nil {
		t.Fatal(err)
	}
	if decoded != payload {
		t.Fatalf("任务负载往返不一致: got=%+v want=%+v", decoded, payload)
	}
	if task.Type() != TypeKnowledgeBuild {
		t.Fatalf("任务类型=%q", task.Type())
	}
}

func TestKnowledgeBuildEnqueueCreatesMissingQueue(t *testing.T) {
	installTestRuntime(t)

	counts, err := QueueStatusCounts(QueueKnowledgeBuild)
	if err != nil {
		t.Fatalf("读取尚未创建的队列状态失败: %v", err)
	}
	if len(counts) != 0 {
		t.Fatalf("尚未创建的队列状态=%+v", counts)
	}

	payload := KnowledgeBuildPayload{
		UserID: 1, KnowledgeBaseID: 2, ArticleID: 3, CreatedAt: time.Now().UTC(),
	}
	info, err := EnqueueKnowledgeBuild(context.Background(), payload, 128)
	if err != nil {
		t.Fatalf("首次入队应创建知识构建队列: %v", err)
	}
	if info.ID != knowledgeBuildTaskID(payload) || info.State != asynq.TaskStatePending {
		t.Fatalf("知识构建任务错误: %+v", info)
	}
	repeated, err := EnqueueKnowledgeBuild(context.Background(), payload, 128)
	if err != nil {
		t.Fatalf("重复入队应复用稳定任务: %v", err)
	}
	if repeated.ID != info.ID {
		t.Fatalf("重复任务 ID=%q，首次任务 ID=%q", repeated.ID, info.ID)
	}
}

func TestDocumentImportTaskEnqueueIsStable(t *testing.T) {
	installTestRuntime(t)

	ctx := context.Background()
	if err := EnqueueDocumentImport(ctx, 42); err != nil {
		t.Fatal(err)
	}
	if err := EnqueueDocumentImport(ctx, 42); err != nil {
		t.Fatalf("重复入队应复用稳定任务: %v", err)
	}
	info, err := runtime.inspector.GetTaskInfo(QueueDocumentImport, documentImportTaskID(42))
	if err != nil {
		t.Fatal(err)
	}
	if info.Type != TypeDocumentImport || info.State != asynq.TaskStatePending {
		t.Fatalf("视觉导入任务错误: %+v", info)
	}
}

func installTestRuntime(t *testing.T) {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	runtime.mu.Lock()
	if runtime.redis != nil {
		runtime.mu.Unlock()
		t.Fatal("测试开始前 Asynq runtime 不应已初始化")
	}
	runtime.redis = client
	runtime.client = asynq.NewClientFromRedisClient(client)
	runtime.inspector = asynq.NewInspectorFromRedisClient(client)
	runtime.mu.Unlock()
	t.Cleanup(func() { _ = Close() })
}

func TestTaskPayloadValidationAndStableKeys(t *testing.T) {
	invalidKnowledge, err := NewKnowledgeBuildTask(KnowledgeBuildPayload{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeKnowledgeBuildPayload(invalidKnowledge); err == nil {
		t.Fatal("空知识构建负载应被拒绝")
	}
	if got := documentImportTaskID(42); got != "document-import-42" {
		t.Fatalf("视觉导入任务 ID=%q", got)
	}
	taskID := knowledgeBuildTaskID(KnowledgeBuildPayload{UserID: 1, KnowledgeBaseID: 2, ArticleID: 3})
	if taskID != "knowledge-build-1-2-3" {
		t.Fatalf("知识构建任务 ID=%q", taskID)
	}
}
