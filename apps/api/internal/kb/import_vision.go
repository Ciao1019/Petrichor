// import_vision.go 实现 Redis/Asynq 驱动的视觉文档导入。
package kb

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

type VisionImageInput struct {
	Data     []byte
	MIMEType string
}

var VisionChatInvoker func(ctx context.Context, userID int64, modelRefID *int64,
	systemPrompt, userPrompt string, image VisionImageInput) (string, error)

const documentVisionSystemPrompt = `你是一个把文档页面图片转写为 Markdown 的引擎。
你会收到文档「某一页」的整页图片，请把该页全部可见内容忠实转写为 GitHub Flavored Markdown。

要求：
1. 严格保留原文语言、文字内容与阅读顺序，不要翻译、不要总结、不要补充原文没有的内容。
2. 还原结构：标题用 #/##/###，列表用 -/1.，引用用 >，代码用围栏代码块，表格用 Markdown 表格。
3. 数学公式用 LaTeX：行内用 $...$，独立公式用 $$...$$。
4. 原页和图形已由系统独立保存并插入文章。你只负责文字转写，不能用说明替代图片，也不要编造图片地址。
   图表中如果有可读的数据表，可按 Markdown 表格转写。
5. 页眉、页脚、页码等与正文无关的边角信息可以忽略。
6. 不要输出任何解释性文字、不要用 ` + "```markdown" + ` 包裹整体，直接输出 Markdown 正文本身。
7. 如果该页为空白页，输出空字符串。`

const documentVisionUserPrompt = "请把这一页转写为 Markdown。"

const VisionImportWorkerConcurrency = 2

var (
	mdFenceWrapRe      = regexp.MustCompile("(?is)^```(?:markdown|md)?\\s*\\n([\\s\\S]*?)\\n```$")
	errPageNotRunnable = errors.New("视觉导入页当前不可运行")
)

func RunVisionPageConversion(ctx context.Context, userID, jobID, pageNo int64) (string, error) {
	job, err := loadJobOwned(ctx, userID, jobID)
	if err != nil {
		return "", err
	}
	page, err := loadJobPage(ctx, job.ID, pageNo)
	if err != nil {
		return "", err
	}
	if page.Status == "done" || page.ExtractedBy == "direct" {
		return derefStr(page.Markdown), nil
	}
	if job.Status == "canceled" {
		return "", badReq("任务已取消")
	}
	if len(page.Assets) > 0 {
		return derefStr(page.Markdown), nil
	}
	imageKey := derefStr(page.ImageKey)
	if imageKey == "" {
		return "", badReq("该页尚未上传整页图片")
	}
	result, err := convertImportPage(ctx, job, imageKey)
	return result.Markdown, err
}

func normalizeVisionMarkdown(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	if match := mdFenceWrapRe.FindStringSubmatch(text); match != nil {
		return strings.TrimSpace(match[1])
	}
	return text
}

// HandleDocumentImportTask 只读写 Redis 任务状态；PostgreSQL 仅在最终生成业务文章时参与事务。
func HandleDocumentImportTask(ctx context.Context, task *asynq.Task) error {
	payload, err := taskqueue.DecodeDocumentImportPayload(task)
	if err != nil {
		return &skipTaskRetryError{message: "视觉导入任务负载无效"}
	}
	job, err := loadJobByID(ctx, payload.JobID)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return nil
	}
	if err != nil {
		return errors.New("读取视觉导入 Redis 状态失败")
	}
	// 技术重试不能隐式重放永久失败页；仅 API 重试/管理员重放可恢复业务终态。
	if job.Status == "failed" || job.Status == "dead_letter" {
		return &skipTaskRetryError{message: "任务已失败，请通过重试页面或管理员重放恢复"}
	}
	if documentImportJobTerminal(job) {
		return nil
	}
	if err := recoverInterruptedImportPages(ctx, payload.JobID); err != nil {
		if errors.Is(err, taskqueue.ErrDocumentImportEnded) || errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
			return nil
		}
		return errors.New("恢复中断的视觉导入页面失败")
	}
	startedAt := time.Now()
	if err := processImportJobBackground(ctx, payload.JobID); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.Error("视觉导入 Asynq 处理失败", "jobId", payload.JobID, "err", err)
		message := documentImportTaskErrorMessage(err)
		if !workerErrorRetryable(err) {
			failImportJobWithContext(ctx, payload.JobID, message)
			return &skipTaskRetryError{message: message}
		}
		return errors.New(message)
	}
	job, err = loadJobByID(ctx, payload.JobID)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return nil
	}
	if err != nil {
		return errors.New("读取视觉导入 Redis 状态失败")
	}
	slog.Info("视觉导入 Asynq 任务结束",
		"jobId", payload.JobID, "status", job.Status,
		"durationMs", time.Since(startedAt).Milliseconds())
	switch job.Status {
	case "completed", "canceled":
		return nil
	case "failed", "dead_letter":
		message := "视觉导入失败"
		if job.Error != nil && strings.TrimSpace(*job.Error) != "" {
			message = truncateRunes(*job.Error, 500)
		}
		return &skipTaskRetryError{message: message}
	}
	pages, err := loadJobPages(ctx, job.ID)
	if err != nil {
		return errors.New("读取视觉导入页状态失败")
	}
	if hasRunnableImportPage(pages) {
		return errors.New("视觉导入仍有页面等待重试")
	}
	return nil
}

func documentImportTaskErrorMessage(err error) string {
	message := "视觉导入处理失败，请稍后重试"
	var httpErr *httpx.HttpError
	switch {
	case errors.As(err, &httpErr):
		message = httpErr.Message
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		message = "视觉导入执行超时或中断"
	}
	return truncateRunes(message, 500)
}

func HandleDocumentImportReconcileTask(ctx context.Context, _ *asynq.Task) error {
	return EnqueueRunnableDocumentImports(ctx)
}

// EnqueueRunnableDocumentImports 从 Redis runnable 索引补偿 API 与 Asynq 入队之间的极小失败窗口。
func EnqueueRunnableDocumentImports(ctx context.Context) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		job, err := store.Get(ctx, id)
		if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
			_ = store.SetRunnable(ctx, id, false)
			continue
		}
		if err != nil {
			return err
		}
		if documentImportWorkerStopped(job) {
			_ = store.SetRunnable(ctx, id, false)
			continue
		}
		pages, err := store.Pages(ctx, id)
		if err != nil {
			return err
		}
		if !taskqueue.DocumentImportRunnable(job, pages) {
			_ = store.SetRunnable(ctx, id, false)
			continue
		}
		if err := taskqueue.EnqueueDocumentImport(ctx, id); err != nil {
			return fmt.Errorf("补偿入队视觉导入任务 %d 失败: %w", id, err)
		}
	}
	return nil
}

func recoverInterruptedImportPages(ctx context.Context, jobID int64) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	_, err = store.UpdatePages(ctx, jobID, func(pages []*JobPageRow) error {
		for _, page := range pages {
			if page.Status != "processing" {
				continue
			}
			message := "Asynq Worker 中断"
			page.LastError = &message
			page.NextAttemptAt = now
			if page.AttemptCount >= page.MaxAttempts {
				deadMessage := "页面多次处理中断，已进入死信队列"
				page.Status = "dead_letter"
				page.Error = &deadMessage
				page.DeadLetteredAt = &now
			} else {
				page.Status = "pending"
				page.Error = nil
				page.DeadLetteredAt = nil
			}
		}
		return nil
	})
	return err
}

func processImportJobBackground(ctx context.Context, jobID int64) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	job, err := store.Get(ctx, jobID)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if documentImportWorkerStopped(job) {
		return nil
	}
	prepared, err := prepareImportJob(ctx, store, job)
	if err != nil || !prepared {
		return err
	}
	job, err = store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
		if documentImportWorkerStopped(current) {
			return nil
		}
		current.Status = "processing"
		current.Error = nil
		return nil
	})
	if err != nil {
		return err
	}
	if documentImportWorkerStopped(job) {
		return nil
	}
	pages, err := loadJobPages(ctx, job.ID)
	if err != nil {
		return err
	}
	if !taskqueue.DocumentImportRunnable(job, pages) {
		return store.SetRunnable(ctx, job.ID, false)
	}
	if err := runImportWorkerPool(ctx, job, pages); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	ready, err := settleImportJobProgress(ctx, store, jobID)
	if err != nil || !ready {
		return err
	}
	err = finalizeImportJobToArticle(ctx, jobID)
	if err != nil && !errors.Is(err, taskqueue.ErrDocumentImportLockBusy) {
		_, _ = store.UpdateJob(ctx, jobID, func(current *JobRow) error {
			if documentImportWorkerStopped(current) {
				return nil
			}
			message := documentImportTaskErrorMessage(err)
			current.Stage, current.Error = "finalizing", &message
			return nil
		})
	}
	return err
}

func runImportWorkerPool(ctx context.Context, job *JobRow, pages []JobPageRow) error {
	for i := range pages {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		page := pages[i]
		if page.Status == "done" {
			cleanupTextOnlyImportImages(ctx, job, &page)
		}
		if page.Status != "pending" || page.ExtractedBy == "direct" || page.ImageKey == nil || derefStr(page.ImageKey) == "" || page.NextAttemptAt.After(time.Now()) {
			continue
		}
		latest, err := loadJobByID(ctx, job.ID)
		if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if documentImportWorkerStopped(latest) {
			return nil
		}
		if err := transcribePageBackground(ctx, latest, int64(page.PageNo), *page.ImageKey); err != nil {
			return err
		}
	}
	return nil
}

func transcribePageBackground(ctx context.Context, job *JobRow, pageNo int64, imageKey string) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	page, err := store.UpdatePage(ctx, job.ID, pageNo, func(current *JobPageRow) error {
		if current.Status != "pending" || current.ExtractedBy == "direct" || current.AttemptCount >= current.MaxAttempts ||
			current.NextAttemptAt.After(time.Now()) || derefStr(current.ImageKey) != imageKey {
			return errPageNotRunnable
		}
		current.NextAttemptAt = time.Now().UTC() // 本轮领取标识，拒绝重试之后的旧结果覆盖。
		current.Status = "processing"
		current.AttemptCount++
		current.Error = nil
		current.DeadLetteredAt = nil
		return nil
	})
	if errors.Is(err, errPageNotRunnable) || errors.Is(err, taskqueue.ErrDocumentImportEnded) {
		return nil
	}
	if err != nil {
		return err
	}
	if page.Status != "processing" {
		return nil
	}
	var result importOCRResult
	var conversionErr error
	if len(page.Assets) > 0 {
		result, conversionErr = convertImportAssets(ctx, store, job, page)
	} else {
		result, conversionErr = convertImportPage(ctx, job, imageKey)
	}
	if conversionErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := truncateRunes(conversionErr.Error(), 500)
		_, err = store.UpdatePage(ctx, job.ID, pageNo, func(current *JobPageRow) error {
			if current.Status != "processing" || current.AttemptCount != page.AttemptCount || !current.NextAttemptAt.Equal(page.NextAttemptAt) {
				return nil
			}
			applyImportOCRResult(current, result)
			if len(current.Assets) == 0 {
				current.Markdown = nil
			}
			status := workerFailureStatus(conversionErr, page.AttemptCount, page.MaxAttempts)
			current.Status = status
			current.Error = &message
			current.LastError = &message
			current.NextAttemptAt = time.Now().UTC()
			if status == "pending" {
				current.NextAttemptAt = time.Now().Add(workerRetryDelay(int(page.AttemptCount),
					fmt.Sprintf("import-%d-%d", job.ID, pageNo))).UTC()
			}
			if status == "dead_letter" {
				now := time.Now().UTC()
				current.DeadLetteredAt = &now
			}
			return nil
		})
	} else {
		var saved *JobPageRow
		saved, err = store.UpdatePage(ctx, job.ID, pageNo, func(current *JobPageRow) error {
			if current.Status != "processing" || current.AttemptCount != page.AttemptCount || !current.NextAttemptAt.Equal(page.NextAttemptAt) {
				return nil
			}
			applyImportOCRResult(current, result)
			current.Status = "done"
			current.Markdown = &result.Markdown
			current.Error = nil
			current.LastError = nil
			current.DeadLetteredAt = nil
			return nil
		})
		if err == nil {
			cleanupTextOnlyImportImages(ctx, job, saved)
		}
	}
	if err != nil {
		return err
	}
	_, _, err = refreshJobProgress(ctx, job.ID)
	return err
}

// finalizeImportJobToArticle 用 Redis 锁和预留文章 ID 跨系统幂等成文，不依赖 PostgreSQL 任务表。
func finalizeImportJobToArticle(ctx context.Context, jobID int64) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	release, err := store.AcquireJobLock(ctx, jobID, taskqueue.DocumentImportFinalizeLockTTL)
	if err != nil {
		return err
	}
	defer func() { _ = release(context.WithoutCancel(ctx)) }()
	// 数据库事务的截止时间早于锁租约，避免长事务越过互斥窗口。
	ctx, cancel := context.WithTimeout(ctx, taskqueue.DocumentImportFinalizeLockTTL-time.Minute)
	defer cancel()

	job, err := store.Get(ctx, jobID)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if job.Status == "canceled" {
		return badReq("任务已取消")
	}
	if job.ArticleID != nil {
		return completeDocumentImport(ctx, store, job.ID, *job.ArticleID)
	}
	pages, err := store.Pages(ctx, job.ID)
	if err != nil {
		return err
	}
	if err := validateImportFinalization(job, pages); err != nil {
		return err
	}
	q := pool()
	if _, err := assertKnowledgeBaseOwner(ctx, q, job.UserID, job.KnowledgeBaseID); err != nil {
		return err
	}
	if _, err := assertFolderParent(ctx, q, job.UserID, job.KnowledgeBaseID, job.ParentNodeID); err != nil {
		return err
	}
	if job.PendingArticleID == nil {
		var reservedID int64
		if err := q.QueryRow(ctx,
			`SELECT nextval(pg_get_serial_sequence('petrichor_kb_article', 'id'))`).Scan(&reservedID); err != nil {
			return err
		}
		job, err = store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
			if current.PendingArticleID == nil {
				current.PendingArticleID = &reservedID
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	articleID := *job.PendingArticleID
	var existingID int64
	if err := q.QueryRow(ctx,
		`SELECT id FROM petrichor_kb_article WHERE id = $1 AND user_id = $2`, articleID, job.UserID).
		Scan(&existingID); err == nil {
		return completeDocumentImport(ctx, store, job.ID, existingID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	tx, err := q.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	contentMD := mergePageMarkdown(pages)
	sortOrder, err := nextSortOrder(ctx, tx, job.UserID, job.KnowledgeBaseID, job.ParentNodeID)
	if err != nil {
		return err
	}
	var nodeID int64
	if err := tx.QueryRow(ctx,
		`INSERT INTO petrichor_kb_node (user_id, knowledge_base_id, parent_id, type, name, sort_order)
		 VALUES ($1,$2,$3,'ARTICLE',$4,$5) RETURNING id`,
		job.UserID, job.KnowledgeBaseID, job.ParentNodeID, job.Title, sortOrder).Scan(&nodeID); err != nil {
		return err
	}
	publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicArticleMetadata(contentMD)
	if _, err := tx.Exec(ctx,
		`INSERT INTO petrichor_kb_article (id, user_id, knowledge_base_id, node_id, title, content_md,
		 public_excerpt, reading_minutes, toc_json, public_content_hash)
		 OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		articleID, job.UserID, job.KnowledgeBaseID, nodeID, job.Title, contentMD,
		publicExcerpt, readingMinutes, tocJSON, contentHash); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return completeDocumentImport(ctx, store, job.ID, articleID)
}

func completeDocumentImport(ctx context.Context, store *taskqueue.DocumentImportStore, jobID, articleID int64) error {
	_, err := store.UpdateJob(ctx, jobID, func(job *JobRow) error {
		if job.Status == "canceled" {
			return badReq("任务已取消，不能覆盖成文状态；请联系管理员核对预留文章")
		}
		job.ArticleID = &articleID
		job.PendingArticleID = nil
		job.Status = "completed"
		job.Stage = "completed"
		job.Error = nil
		job.DeadLetteredAt = nil
		job.ProcessedPages = job.TotalPages
		return nil
	})
	if err == nil {
		err = store.SetRunnable(ctx, jobID, false)
	}
	return err
}

func hasRunnableImportPage(pages []JobPageRow) bool {
	for i := range pages {
		page := pages[i]
		if page.Status == "pending" && page.AttemptCount < page.MaxAttempts &&
			page.ExtractedBy != "direct" && page.ImageKey != nil && strings.TrimSpace(*page.ImageKey) != "" {
			return true
		}
	}
	return false
}

func documentImportJobTerminal(job *JobRow) bool {
	return job.Status == "canceled" || job.Status == "completed" || job.ArticleID != nil
}

func countNotDonePages(pages []JobPageRow) int {
	count := 0
	for i := range pages {
		if pages[i].Status != "done" {
			count++
		}
	}
	return count
}

func failImportJobWithContext(ctx context.Context, jobID int64, message string) {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return
	}
	_, _ = store.UpdateJob(ctx, jobID, func(job *JobRow) error {
		if documentImportWorkerStopped(job) {
			return nil
		}
		value := truncateRunes(message, 500)
		job.Status = "failed"
		job.Error = &value
		return nil
	})
}
