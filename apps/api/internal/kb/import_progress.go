package kb

import (
	"context"
	"errors"
	"fmt"
	"time"

	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

func documentImportWorkerStopped(job *JobRow) bool {
	return documentImportJobTerminal(job) || job.Status == "failed" || job.Status == "dead_letter"
}

// settleImportJobProgress 以 WATCH 内的当前页集收敛，未来可重试页优先于失败终态。
func settleImportJobProgress(ctx context.Context, store *taskqueue.DocumentImportStore, jobID int64) (bool, error) {
	ready := false
	_, err := store.UpdateJobPages(ctx, jobID, func(job *JobRow, pages []*JobPageRow) error {
		ready = false
		if documentImportWorkerStopped(job) {
			return nil
		}
		now := time.Now().UTC()
		snapshot := make([]JobPageRow, 0, len(pages))
		for _, page := range pages {
			if page.Status == "pending" && page.AttemptCount >= page.MaxAttempts {
				message := "页面重试次数已耗尽"
				page.Status, page.Error, page.DeadLetteredAt = "dead_letter", &message, &now
			}
			snapshot = append(snapshot, *page)
		}
		job.ProcessedPages = countProcessedPages(snapshot)
		stats := buildPageStats(snapshot)
		switch {
		case stats.pendingPages > 0:
			job.Status, job.Error, job.DeadLetteredAt = "processing", nil, nil
		case stats.deadLetterPages > 0:
			message := fmt.Sprintf("有 %d 页连续失败，请通过管理员重放。", stats.deadLetterPages)
			job.Status, job.Error, job.DeadLetteredAt = "dead_letter", &message, &now
		case stats.failedPages > 0:
			message := fmt.Sprintf("有 %d 页转 Markdown 失败，请重试失败页。", stats.failedPages)
			job.Status, job.Error = "failed", &message
		default:
			ready = len(snapshot) == int(job.TotalPages) && taskqueue.DocumentImportPagesReady(snapshot)
			if ready {
				job.Stage = "finalizing"
			}
		}
		return nil
	})
	if errors.Is(err, taskqueue.ErrDocumentImportEnded) || errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return false, nil
	}
	return ready && err == nil, err
}

// mutateImportRetry 原子恢复页/任务及 runnable，进程中断不会留下终态任务里的 pending 页。
func mutateImportRetry(ctx context.Context, store *taskqueue.DocumentImportStore, jobID int64, replay bool,
	mutate func([]*JobPageRow) error,
) ([]JobPageRow, error) {
	pages, err := store.UpdateJobPages(ctx, jobID, func(job *JobRow, pages []*JobPageRow) error {
		if err := mutate(pages); err != nil {
			return err
		}
		taskqueue.ResetDocumentImportTaskRetry(job)
		job.Status, job.Error, job.DeadLetteredAt = "processing", nil, nil
		job.ProcessedPages = 0
		for _, page := range pages {
			if page.Status == "done" {
				job.ProcessedPages++
			}
		}
		if replay {
			job.ReplayCount++
		}
		return nil
	})
	return pages, importMutationError(err)
}

func importMutationError(err error) error {
	switch {
	case errors.Is(err, taskqueue.ErrDocumentImportIdempotencyConflict):
		return &httpx.HttpError{Status: 409, Message: "idempotencyKey 已用于不同参数或已删除的导入任务"}
	case errors.Is(err, taskqueue.ErrDocumentImportLockBusy), errors.Is(err, taskqueue.ErrDocumentImportFinalizing):
		return &httpx.HttpError{Status: 409, Message: "任务正在生成文章或恢复状态，暂不能操作，请稍后重试"}
	case errors.Is(err, taskqueue.ErrDocumentImportEnded):
		return &httpx.HttpError{Status: 409, Message: "任务已结束，不能修改或取消"}
	case errors.Is(err, taskqueue.ErrDocumentImportNotFound):
		return notFoundErr("导入任务不存在")
	default:
		return err
	}
}
