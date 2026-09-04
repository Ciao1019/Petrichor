package kb

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hibiken/asynq"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

func TestArticleKnowledgeBuildJobResponseMapsAsynqStates(t *testing.T) {
	createdAt := time.Now().Add(-time.Minute).UTC()
	payload, err := json.Marshal(taskqueue.KnowledgeBuildPayload{
		UserID: 7, KnowledgeBaseID: 11, ArticleID: 13, CreatedAt: createdAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := articleKnowledgeBuildJobResponse(&asynq.TaskInfo{
		ID: "job-1", Type: taskqueue.TypeKnowledgeBuild, Payload: payload, State: asynq.TaskStatePending,
	})
	if err != nil {
		t.Fatalf("映射 pending 任务失败: %v", err)
	}
	if pending["status"] != "pending" || pending["userId"] != "7" || pending["articleId"] != "13" {
		t.Fatalf("pending 响应错误: %#v", pending)
	}

	startedAt := createdAt.Add(10 * time.Second)
	completedAt := startedAt.Add(20 * time.Second)
	resultBytes, err := json.Marshal(knowledgeBuildTaskResult{
		Result: map[string]any{"articleId": "13"}, StartedAt: startedAt, CompletedAt: completedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := articleKnowledgeBuildJobResponse(&asynq.TaskInfo{
		ID: "job-1", Type: taskqueue.TypeKnowledgeBuild, Payload: payload,
		State: asynq.TaskStateCompleted, Result: resultBytes, CompletedAt: completedAt,
	})
	if err != nil {
		t.Fatalf("映射 completed 任务失败: %v", err)
	}
	if completed["status"] != "completed" || completed["result"] == nil || completed["completedAt"] == nil {
		t.Fatalf("completed 响应错误: %#v", completed)
	}

	failed, err := articleKnowledgeBuildJobResponse(&asynq.TaskInfo{
		ID: "job-1", Type: taskqueue.TypeKnowledgeBuild, Payload: payload,
		State: asynq.TaskStateArchived, LastErr: "构建失败", LastFailedAt: completedAt,
	})
	if err != nil {
		t.Fatalf("映射 archived 任务失败: %v", err)
	}
	if failed["status"] != "failed" || failed["error"] == nil {
		t.Fatalf("failed 响应错误: %#v", failed)
	}
}

func TestArticleKnowledgeBuildJobResponseIncludesActiveProgress(t *testing.T) {
	createdAt := time.Now().Add(-time.Minute).UTC()
	startedAt := createdAt.Add(5 * time.Second)
	updatedAt := startedAt.Add(20 * time.Second)
	payload, err := json.Marshal(taskqueue.KnowledgeBuildPayload{
		UserID: 7, KnowledgeBaseID: 11, ArticleID: 13, CreatedAt: createdAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	resultBytes, err := json.Marshal(knowledgeBuildTaskResult{
		StartedAt: startedAt,
		Progress: &knowledgeBuildProgress{
			Percent: 63, Phase: knowledgeBuildPhasePages, Message: "正在生成 Wiki 页面",
			Completed: 2, Total: 4, UpdatedAt: updatedAt,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := articleKnowledgeBuildJobResponse(&asynq.TaskInfo{
		ID: "job-1", Type: taskqueue.TypeKnowledgeBuild, Payload: payload,
		State: asynq.TaskStateActive, Result: resultBytes,
	})
	if err != nil {
		t.Fatalf("映射 active 任务失败: %v", err)
	}
	progress, ok := response["progress"].(knowledgeBuildProgress)
	if !ok {
		t.Fatalf("progress 类型错误: %#v", response["progress"])
	}
	if progress.Percent != 63 || progress.Phase != knowledgeBuildPhasePages || progress.Completed != 2 || progress.Total != 4 {
		t.Fatalf("active 进度错误: %#v", progress)
	}
	if response["startedAt"] == nil {
		t.Fatalf("active 响应缺少 startedAt: %#v", response)
	}
}

func TestListArticleKnowledgeBuildJobsRestoresRetainedTasks(t *testing.T) {
	createdAt := time.Now().Add(-time.Minute).UTC()
	payload, err := json.Marshal(taskqueue.KnowledgeBuildPayload{
		UserID: 7, KnowledgeBaseID: 11, ArticleID: 13, CreatedAt: createdAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	lookedUp := []string{}
	jobs, err := listArticleKnowledgeBuildJobs(7, 11, []int64{13, 14, 13}, func(jobID string) (*asynq.TaskInfo, error) {
		lookedUp = append(lookedUp, jobID)
		if jobID == "knowledge-build-7-11-14" {
			return nil, asynq.ErrTaskNotFound
		}
		return &asynq.TaskInfo{
			ID: jobID, Type: taskqueue.TypeKnowledgeBuild, Payload: payload, State: asynq.TaskStatePending,
		}, nil
	})
	if err != nil {
		t.Fatalf("批量恢复任务失败: %v", err)
	}
	if len(lookedUp) != 2 || lookedUp[0] != "knowledge-build-7-11-13" || lookedUp[1] != "knowledge-build-7-11-14" {
		t.Fatalf("查询任务 ID 错误: %#v", lookedUp)
	}
	if len(jobs) != 1 || jobs[0]["articleId"] != "13" || jobs[0]["status"] != "pending" {
		t.Fatalf("恢复结果错误: %#v", jobs)
	}
}

func TestInvokeKnowledgeBuildChatRetriesTransientModelError(t *testing.T) {
	originalSlots := knowledgeBuildModelSlots
	originalInvoker := ChatInvoker
	originalDelay := knowledgeBuildModelRetryDelay
	knowledgeBuildModelSlots = make(chan struct{}, 1)
	knowledgeBuildModelRetryDelay = func(int) time.Duration { return 0 }
	defer func() {
		knowledgeBuildModelSlots = originalSlots
		ChatInvoker = originalInvoker
		knowledgeBuildModelRetryDelay = originalDelay
	}()

	var calls atomic.Int32
	var maxTokens atomic.Int64
	ChatInvoker = func(_ context.Context, request ChatRequest) (string, error) {
		maxTokens.Store(request.MaxTokens)
		if calls.Add(1) < 3 {
			return "", &httpx.HttpError{Status: 502, Message: `模型调用失败(500)：{"message":"Internal server error"}`}
		}
		return "ok", nil
	}
	answer, err := invokeKnowledgeBuildChat(context.Background(), ChatRequest{Op: "kb.build.pages"})
	if err != nil {
		t.Fatalf("临时错误重试后仍失败: %v", err)
	}
	if answer != "ok" || calls.Load() != 3 {
		t.Fatalf("answer=%q calls=%d，期望第 3 次成功", answer, calls.Load())
	}
	if maxTokens.Load() != 16_384 {
		t.Fatalf("页面生成输出上限 = %d，期望 16384", maxTokens.Load())
	}
}

func TestInvokeKnowledgeBuildJSONRetriesInvalidPayload(t *testing.T) {
	originalSlots := knowledgeBuildModelSlots
	originalInvoker := ChatInvoker
	originalDelay := knowledgeBuildModelRetryDelay
	knowledgeBuildModelSlots = make(chan struct{}, 1)
	knowledgeBuildModelRetryDelay = func(int) time.Duration { return 0 }
	defer func() {
		knowledgeBuildModelSlots = originalSlots
		ChatInvoker = originalInvoker
		knowledgeBuildModelRetryDelay = originalDelay
	}()

	var calls atomic.Int32
	var requestedJSON atomic.Bool
	ChatInvoker = func(_ context.Context, request ChatRequest) (string, error) {
		requestedJSON.Store(request.RequireJSON)
		if calls.Add(1) == 1 {
			return "不是 JSON", nil
		}
		return `{"pages":[]}`, nil
	}
	parsed, err := invokeKnowledgeBuildJSON(context.Background(), ChatRequest{Op: "kb.build.pages"})
	if err != nil {
		t.Fatalf("非法 JSON 重试后仍失败: %v", err)
	}
	if _, ok := parsed["pages"]; !ok || calls.Load() != 2 {
		t.Fatalf("parsed=%#v calls=%d", parsed, calls.Load())
	}
	if !requestedJSON.Load() {
		t.Fatal("知识构建 JSON 调用没有请求协议层结构化输出")
	}
}

func TestExtractJSONObjectsToleratesModelWrappers(t *testing.T) {
	cases := map[string]string{
		"Markdown 围栏": "结果如下：\n```json\n{\"assignments\":[]}\n```",
		"前置坏对象":       "说明 {不是 JSON}，最终结果 {\"assignments\":[]}",
		"后置大括号":       "{\"assignments\":[]}\n说明 {done}",
		"二次字符串编码":     `"{\"assignments\":[]}"`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			parsed := extractJSONObjects(raw)
			if parsed == nil {
				t.Fatalf("未能提取模型包装后的 JSON：%q", raw)
			}
			if _, ok := parsed["assignments"]; !ok {
				t.Fatalf("提取了错误对象：%#v", parsed)
			}
		})
	}
	if parsed := extractJSONObjects("只有普通说明文字"); parsed != nil {
		t.Fatalf("非 JSON 文本不应被接受：%#v", parsed)
	}
}

func TestKnowledgeBuildFallbackWarningKeepsFinalReason(t *testing.T) {
	err := &knowledgeBuildModelCallError{
		cause: errKnowledgeBuildInvalidJSON, attempts: 3, retryable: true,
	}
	got := knowledgeBuildFallbackWarning("知识目录规划", "本批页面保留旧目录", err)
	want := "知识目录规划连续 3 次调用失败，本批页面保留旧目录：模型结果不是有效 JSON"
	if got != want {
		t.Fatalf("warning=%q，期望 %q", got, want)
	}
}

func TestInvokeKnowledgeBuildChatDoesNotRetryProviderClientError(t *testing.T) {
	originalSlots := knowledgeBuildModelSlots
	originalInvoker := ChatInvoker
	originalDelay := knowledgeBuildModelRetryDelay
	knowledgeBuildModelSlots = make(chan struct{}, 1)
	knowledgeBuildModelRetryDelay = func(int) time.Duration { return 0 }
	defer func() {
		knowledgeBuildModelSlots = originalSlots
		ChatInvoker = originalInvoker
		knowledgeBuildModelRetryDelay = originalDelay
	}()

	var calls atomic.Int32
	ChatInvoker = func(context.Context, ChatRequest) (string, error) {
		calls.Add(1)
		return "", &httpx.HttpError{Status: 502, Message: "模型调用失败(401)：unauthorized"}
	}
	_, err := invokeKnowledgeBuildChat(context.Background(), ChatRequest{Op: "kb.build.pages"})
	if err == nil {
		t.Fatal("供应商 401 应返回错误")
	}
	if calls.Load() != 1 {
		t.Fatalf("供应商 401 调用了 %d 次，期望不重试", calls.Load())
	}
}

func TestKnowledgeBuildModelLimiterCapsAllArticles(t *testing.T) {
	originalSlots := knowledgeBuildModelSlots
	originalInvoker := ChatInvoker
	knowledgeBuildModelSlots = make(chan struct{}, 3)
	defer func() {
		knowledgeBuildModelSlots = originalSlots
		ChatInvoker = originalInvoker
	}()

	started := make(chan struct{}, 5)
	release := make(chan struct{})
	var active atomic.Int32
	var maximum atomic.Int32
	ChatInvoker = func(ctx context.Context, _ ChatRequest) (string, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			observed := maximum.Load()
			if current <= observed || maximum.CompareAndSwap(observed, current) {
				break
			}
		}
		started <- struct{}{}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-release:
			return "ok", nil
		}
	}

	var workers sync.WaitGroup
	for range 5 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if _, err := invokeKnowledgeBuildChat(context.Background(), ChatRequest{}); err != nil {
				t.Errorf("invokeKnowledgeBuildChat() error = %v", err)
			}
		}()
	}
	for range 3 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("全局模型并发额度没有被占满")
		}
	}
	select {
	case <-started:
		t.Fatal("模型调用越过了全局信号量上限")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	workers.Wait()
	if maximum.Load() != 3 {
		t.Fatalf("最大模型并发 = %d，期望 3", maximum.Load())
	}
}
