package kb

import (
	"context"

	"petrichor/api/internal/taskqueue"
)

// requestImportFinalization 仅修改 Redis 调度状态，与取消及 Worker 成文共用非等待锁。
func requestImportFinalization(ctx context.Context, store *taskqueue.DocumentImportStore, userID, jobID int64) (*JobRow, []JobPageRow, error) {
	job, err := store.GetOwned(ctx, userID, jobID)
	if err != nil {
		return nil, nil, importMutationError(err)
	}
	if job.Status == "canceled" {
		return nil, nil, badReq("任务已取消")
	}
	if documentImportJobTerminal(job) {
		pages, err := store.Pages(ctx, jobID)
		return job, pages, err
	}
	release, err := store.AcquireJobLock(ctx, jobID, taskqueue.DocumentImportFinalizeLockTTL)
	if err != nil {
		return nil, nil, importMutationError(err)
	}
	defer func() { _ = release(context.WithoutCancel(ctx)) }()

	pages, err := store.UpdateJobPages(ctx, jobID, func(current *JobRow, pages []*JobPageRow) error {
		// WATCH 内重新校验归属、阶段和完整页集；已取消/完成由仓库直接拒绝。
		if current.UserID != userID {
			return taskqueue.ErrDocumentImportNotFound
		}
		switch current.Stage {
		case "preparing", "parsing", "rendering":
			return badReq("任务页面尚未准备完成")
		}
		snapshot := make([]JobPageRow, 0, len(pages))
		for _, page := range pages {
			snapshot = append(snapshot, *page)
		}
		if err := validateImportFinalization(current, snapshot); err != nil {
			return err
		}
		// 显式重新调度推进代次，旧执行的迟到死信回调不能覆盖此次请求。
		// 不重置成功页、预留文章 ID 或任何解析/OCR 尝试次数。
		current.ReplayCount++
		current.Status, current.Stage = "processing", "finalizing"
		current.Error, current.DeadLetteredAt = nil, nil
		current.ProcessedPages = int32(len(snapshot))
		job = current
		return nil
	})
	return job, pages, importMutationError(err)
}
