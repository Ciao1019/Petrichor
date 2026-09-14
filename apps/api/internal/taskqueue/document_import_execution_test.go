package taskqueue

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/hibiken/asynq"
)

func TestDocumentImportExecutionSnapshotAdvancesOnlyOwnAttempt(t *testing.T) {
	ctx := WithDocumentImportExecution(context.Background())
	job := &DocumentImportJob{ID: 1, ReplayCount: 2}
	captureDocumentImportExecution(ctx, job)
	claim := *job
	claim.PrepareAttempt, claim.PrepareToken = 1, "claim"
	AdvanceDocumentImportExecution(ctx, job, &claim)
	replayed := claim
	replayed.ReplayCount++
	captureDocumentImportExecution(ctx, &replayed)
	AdvanceDocumentImportExecution(ctx, &claim, &replayed)
	got, ok := FailedDocumentImportExecution(ctx)
	if !ok || !got.Matches(&claim) {
		t.Fatalf("真实 attempt 快照丢失: %+v", got)
	}
	finished := claim
	finished.PrepareToken = ""
	AdvanceDocumentImportExecution(ctx, &claim, &finished)
	got, _ = FailedDocumentImportExecution(ctx)
	if !got.Matches(&claim) {
		t.Fatal("超时回调之后快照被迟到处理器修改", got)
	}
}

func TestDocumentImportServerExecutionSnapshotSurvivesAsynqRetryExhaustion(t *testing.T) {
	installTestRuntime(t)
	store, err := DocumentImports()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Create(context.Background(), preparingTestJob())
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		execution DocumentImportExecution
		captured  bool
		retried   int
		maxRetry  int
	}
	results := make(chan result, 2)
	server, err := NewServer(asynq.Config{
		Concurrency: 1, Queues: map[string]int{QueueDocumentImport: 1},
		TaskCheckInterval: 10 * time.Millisecond, DelayedTaskCheckInterval: 10 * time.Millisecond,
		RetryDelayFunc:  func(int, error, *asynq.Task) time.Duration { return time.Millisecond },
		ShutdownTimeout: time.Second,
		ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, _ *asynq.Task, _ error) {
			e, ok := FailedDocumentImportExecution(ctx)
			retried, _ := asynq.GetRetryCount(ctx)
			maxRetry, _ := asynq.GetMaxRetry(ctx)
			// 回调间变更 generation；下一次技术执行必须使用新的独立 BaseContext。
			if retried == 0 {
				_, err := store.UpdateJob(context.Background(), job.ID, func(j *DocumentImportJob) error { j.ReplayCount++; return nil })
				if err != nil {
					t.Error(err)
				}
			}
			results <- result{e, ok, retried, maxRetry}
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Start(asynq.HandlerFunc(func(ctx context.Context, task *asynq.Task) error {
		payload, err := DecodeDocumentImportPayload(task)
		if err != nil {
			return err
		}
		if _, err := store.Get(ctx, payload.JobID); err != nil {
			return err
		}
		return errors.New("模拟基础设施失败")
	})); err != nil {
		t.Fatal(err)
	}
	defer server.Shutdown()
	// 历史任务只有 jobId，不需要迁移 payload 才能支持执行围栏。
	task := asynq.NewTask(TypeDocumentImport, []byte(fmt.Sprintf(`{"jobId":%d}`, job.ID)))
	if _, err := runtime.client.Enqueue(task, asynq.Queue(QueueDocumentImport), asynq.MaxRetry(1)); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		select {
		case r := <-results:
			if !r.captured || r.execution.JobID != job.ID || r.execution.ReplayCount != int32(attempt) || r.retried != attempt || r.maxRetry != 1 {
				t.Fatalf("超重试快照错误: %+v", r)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Asynq 回调未完成")
		}
	}
}
