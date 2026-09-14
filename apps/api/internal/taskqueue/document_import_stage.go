package taskqueue

import "time"

// 历史空任务保持未知阶段，不把未提交原件的旧任务伪造成新准备任务。
func normalizeDocumentImportStage(job *DocumentImportJob) {
	if job.PrepareMaxAttempts <= 0 {
		job.PrepareMaxAttempts = documentImportDefaultTries
	}
	if job.Status == "completed" || job.ArticleID != nil {
		job.Stage = "completed"
		return
	}
	if job.Stage == "" && job.TotalPages > 0 {
		job.Stage = "ocr"
		if job.ProcessedPages == job.TotalPages && job.PendingArticleID != nil {
			job.Stage = "finalizing"
		}
	}
}

func DocumentImportNeedsPreparation(job *DocumentImportJob) bool {
	return job.TotalPages == 0 && (job.Stage == "preparing" || job.Stage == "parsing" || job.Stage == "rendering")
}

// Runnable 是持久化补偿资格；租约和退避只推迟领取，不删除待补偿任务。
func DocumentImportRunnable(job *DocumentImportJob, pages []DocumentImportPage) bool {
	if job == nil || documentImportTerminal(job.Status) || job.ArticleID != nil {
		return false
	}
	if DocumentImportNeedsPreparation(job) {
		return len(pages) == 0 && job.SourceKey != nil && *job.SourceKey != ""
	}
	return len(pages) == int(job.TotalPages) && DocumentImportPagesReady(pages)
}

// ResetDocumentImportTaskRetry 在重试/重放的 WATCH 内调用；不清除预留文章 ID，不触碰成功页。
func ResetDocumentImportTaskRetry(job *DocumentImportJob) {
	if DocumentImportNeedsPreparation(job) {
		job.Stage = "preparing"
		job.PrepareAttempt = 0
		job.PrepareToken = ""
		job.PrepareLeaseUntil = time.Time{}
		job.PrepareNextAttemptAt = time.Time{}
		job.PrepareLastError = nil
	}
}

// ResetDocumentImportPageRetry 供用户重试与管理员重放共用；保留原生正文和图片资源。
func ResetDocumentImportPageRetry(page *DocumentImportPage) {
	if page.Status == "done" {
		return
	}
	page.Status = "pending"
	page.ExtractedBy = "ocr"
	if len(page.Assets) == 0 {
		page.Markdown = nil
	}
	page.Error = nil
	page.LastError = nil
	page.AttemptCount = 0
	page.NextAttemptAt = time.Now().UTC()
	page.DeadLetteredAt = nil
}
