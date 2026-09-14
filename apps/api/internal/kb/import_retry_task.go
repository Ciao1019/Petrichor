package kb

import (
	"context"
	"petrichor/api/internal/taskqueue"
)

// 任务级失败（零页准备、全页成功但成文失败）同样允许显式重试。
func retryFailedImportJob(ctx context.Context, store *taskqueue.DocumentImportStore, jobID int64) (int, error) {
	release, err := store.AcquireJobLock(ctx, jobID, taskqueue.DocumentImportFinalizeLockTTL)
	if err != nil {
		return 0, importMutationError(err)
	}
	defer func() { _ = release(context.WithoutCancel(ctx)) }()
	retried := 0
	_, err = store.UpdateJobPages(ctx, jobID, func(job *JobRow, pages []*JobPageRow) error {
		retried = 0
		failed := job.Status == "failed" || job.Status == "dead_letter" || job.Error != nil
		allDone := len(pages) > 0 && len(pages) == int(job.TotalPages)
		for _, page := range pages {
			allDone = allDone && page.Status == "done"
			if page.Status == "failed" || page.Status == "dead_letter" {
				resetDocumentImportPage(page)
				retried++
			}
		}
		if retried == 0 {
			if !failed || (!taskqueue.DocumentImportNeedsPreparation(job) && !allDone) {
				return badReq("没有需要重试的失败页或任务")
			}
			if job.PrepareToken != "" {
				return badReq("文档准备仍在执行")
			}
			retried = 1
		}
		taskqueue.ResetDocumentImportTaskRetry(job)
		job.Status, job.Error, job.DeadLetteredAt = "processing", nil, nil
		job.ProcessedPages = 0
		for _, page := range pages {
			if page.Status == "done" {
				job.ProcessedPages++
			}
		}
		if allDone {
			job.Stage = "finalizing"
		}
		job.ReplayCount++
		return nil
	})
	return retried, importMutationError(err)
}
