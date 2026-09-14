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
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	payload, err := taskqueue.DecodeDocumentImportPayload(task)
	if err != nil {
		return
	}
	execution, ok := taskqueue.FailedDocumentImportExecution(ctx)
	if !ok || execution.JobID != payload.JobID {
		// 尚未读取业务状态的基础设施失败没有可信围栏，由 runnable 补偿继续调度。
		slog.Warn("视觉导入死信缺少执行快照，保留调度", "jobId", payload.JobID)
		return
	}
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return
	}
	// 页、任务与 runnable 一次收敛；WATCH 内只比较真正失败执行的快照。
	_, err = store.UpdateJobPages(ctx, payload.JobID, func(current *JobRow, pages []*JobPageRow) error {
		if documentImportWorkerStopped(current) || !execution.Matches(current) {
			return taskqueue.ErrDocumentImportPrepareStale
		}
		now := time.Now().UTC()
		if taskqueue.DocumentImportNeedsPreparation(current) && current.PrepareLeaseUntil.After(now) {
			return nil
		}
		message := "视觉导入多次失败，任务已进入 Asynq 死信队列，可在管理页重放。"
		current.ProcessedPages = 0
		for _, page := range pages {
			if page.Status == "pending" || page.Status == "processing" {
				pageMessage := "Asynq 重试耗尽"
				if page.LastError != nil {
					pageMessage = *page.LastError
				}
				page.Status, page.AttemptCount = "dead_letter", page.MaxAttempts
				page.Error, page.LastError, page.DeadLetteredAt = &pageMessage, &pageMessage, &now
			}
			if page.Status == "done" || page.Status == "failed" || page.Status == "dead_letter" {
				current.ProcessedPages++
			}
		}
		if taskqueue.DocumentImportNeedsPreparation(current) {
			// 保留实际准备 attempt（包括 Worker 崩溃），管理员可见，不伪造页计数。
			current.PrepareToken, current.PrepareLeaseUntil = "", time.Time{}
			if current.PrepareLastError == nil {
				current.PrepareLastError = &message
			}
		}
		current.Status, current.Error, current.DeadLetteredAt = "dead_letter", &message, &now
		return nil
	})
	if err != nil && !preparationObsolete(err) {
		slog.Warn("收敛视觉导入 Redis 死信失败", "jobId", payload.JobID, "err", err)
	}
}
