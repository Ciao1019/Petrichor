package kb

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"

	"petrichor/api/internal/taskqueue"
)

// AsynqRetryDelay 使用有上限指数退避并加入稳定抖动。
func AsynqRetryDelay(retried int, _ error, task *asynq.Task) time.Duration {
	return workerRetryDelay(retried+1, task.Type()+":"+string(task.Payload()))
}

func HandleAsynqTaskError(ctx context.Context, task *asynq.Task, taskErr error) {
	taskID, _ := asynq.GetTaskID(ctx)
	retried, _ := asynq.GetRetryCount(ctx)
	maxRetry, _ := asynq.GetMaxRetry(ctx)
	terminal := errors.Is(taskErr, asynq.SkipRetry) || retried >= maxRetry
	slog.Error("Asynq 任务执行失败",
		"taskId", taskID, "taskType", task.Type(), "retried", retried,
		"maxRetry", maxRetry, "terminal", terminal, "err", taskErr)
	if terminal && task.Type() == taskqueue.TypeDocumentImport {
		markDocumentImportTerminalFailure(context.WithoutCancel(ctx), task)
	}
}

func markDocumentImportTerminalFailure(ctx context.Context, task *asynq.Task) {
	payload, err := taskqueue.DecodeDocumentImportPayload(task)
	if err != nil {
		return
	}
	store, err := taskqueue.DocumentImports()
	if err != nil {
		slog.Warn("读取视觉导入 Redis 状态失败", "jobId", payload.JobID, "err", err)
		return
	}
	job, err := store.Get(ctx, payload.JobID)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return
	}
	if err != nil {
		slog.Warn("读取视觉导入 Redis 任务失败", "jobId", payload.JobID, "err", err)
		return
	}
	// 明确业务失败使用 SkipRetry，但应保留 failed；只有技术重试耗尽才进入死信。
	if job.Status == "failed" || job.Status == "dead_letter" || documentImportJobTerminal(job) {
		return
	}
	now := time.Now().UTC()
	pages, err := store.UpdatePages(ctx, payload.JobID, func(pages []*JobPageRow) error {
		for _, page := range pages {
			if page.Status != "pending" && page.Status != "processing" {
				continue
			}
			message := "Asynq 重试耗尽"
			if page.LastError != nil {
				message = *page.LastError
			}
			page.Status = "dead_letter"
			page.AttemptCount = page.MaxAttempts
			page.Error = &message
			page.LastError = &message
			page.DeadLetteredAt = &now
		}
		return nil
	})
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return
	}
	if err != nil {
		slog.Warn("收敛视觉导入 Redis 死信页失败", "jobId", payload.JobID, "err", err)
		return
	}
	message := "视觉导入多次失败，任务已进入 Asynq 死信队列，可在 asynqmon 或管理页重放。"
	_, err = store.UpdateJob(ctx, payload.JobID, func(job *JobRow) error {
		if documentImportJobTerminal(job) {
			return nil
		}
		job.Status = "dead_letter"
		job.Error = &message
		job.DeadLetteredAt = &now
		job.ProcessedPages = countProcessedPages(pages)
		return nil
	})
	if err != nil && !errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		slog.Warn("收敛视觉导入 Redis 死信任务失败", "jobId", payload.JobID, "err", err)
	}
	_ = store.SetRunnable(ctx, payload.JobID, false)
}
