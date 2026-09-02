// import_vision.go 实现 Redis/Asynq 驱动的视觉文档导入。
package kb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
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
4. 页面里的照片、插图、图表、示意图等无法用文字表达的图像，用一行斜体说明代替，格式为 ` + "`*（图：简要描述）*`" + `。
   不要输出任何 Markdown 图片语法（不要写 ` + "`![...](...)`" + `），因为没有可引用的图片地址。
   图表中如果有可读的数据表，优先按 Markdown 表格转写出来，再补一行图说明。
5. 页眉、页脚、页码等与正文无关的边角信息可以忽略。
6. 不要输出任何解释性文字、不要用 ` + "```markdown" + ` 包裹整体，直接输出 Markdown 正文本身。
7. 如果该页为空白页，输出空字符串。`

const documentVisionUserPrompt = "请把这一页转写为 Markdown。"

const VisionImportWorkerConcurrency = 2

var (
	s3DownloadClient   = &http.Client{Timeout: 120 * time.Second}
	mdFenceWrapRe      = regexp.MustCompile("(?is)^```(?:markdown|md)?\\s*\\n([\\s\\S]*?)\\n```$")
	errPageNotRunnable = errors.New("视觉导入页当前不可运行")
)

func RunVisionPageConversion(ctx context.Context, userID, jobID, pageNo int64) (string, error) {
	if VisionChatInvoker == nil {
		return "", &httpx.HttpError{Status: 503, Message: "AI 服务未就绪"}
	}
	job, err := loadJobOwned(ctx, userID, jobID)
	if err != nil {
		return "", err
	}
	page, err := loadJobPage(ctx, job.ID, pageNo)
	if err != nil {
		return "", err
	}
	if page.ExtractedBy != "vision" {
		return "", badReq("该页由 PDF 本地抽取，无需模型识别")
	}
	imageKey := derefStr(page.ImageKey)
	if imageKey == "" {
		return "", badReq("该页尚未上传整页图片")
	}
	return convertVisionPage(ctx, job, pageNo, imageKey)
}

func fetchObjectBytes(ctx context.Context, objectKey string) ([]byte, string, error) {
	key := storage.StripS4KeyPrefix(objectKey)
	var data []byte
	var err error
	if storage.LocalEnabled() {
		data, err = storage.ReadLocalObject(key)
	} else {
		data, err = downloadPresignedObject(ctx, key)
	}
	if err != nil {
		return nil, "", err
	}
	return data, detectImageMIME(data, key), nil
}

func downloadPresignedObject(ctx context.Context, key string) ([]byte, error) {
	s3cfg := config.Get().S3
	if s3cfg == nil {
		return nil, fmt.Errorf("对象存储未配置")
	}
	url, err := storage.CreateS3PresignedUrl(s3cfg, "GET", key, s3cfg.DownloadExpireSecond, time.Now())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := s3DownloadClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("对象下载失败(HTTP %d)", response.StatusCode)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("对象内容为空")
	}
	return data, nil
}

func detectImageMIME(data []byte, objectKey string) string {
	sniffed := http.DetectContentType(data)
	switch sniffed {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return sniffed
	}
	switch strings.ToLower(filepath.Ext(objectKey)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return "image/png"
	}
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
	// asynqmon 对归档任务执行 Run/Retry 时自动恢复 Redis 业务死信。
	if job.Status == "failed" || job.Status == "dead_letter" {
		if err := resetDocumentImportForReplay(ctx, job.ID); err != nil {
			return errors.New("恢复视觉导入死信失败")
		}
	}
	if err := recoverInterruptedImportPages(ctx, payload.JobID); err != nil {
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
		if documentImportJobTerminal(job) {
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
	if documentImportJobTerminal(job) {
		_ = store.SetRunnable(ctx, job.ID, false)
		return nil
	}
	job, err = store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
		current.Status = "processing"
		current.Error = nil
		return nil
	})
	if err != nil {
		return err
	}
	pages, err := loadJobPages(ctx, job.ID)
	if err != nil {
		return err
	}
	if err := runImportWorkerPool(ctx, job, pages); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	job, err = store.Get(ctx, jobID)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return nil
	}
	if err != nil || documentImportJobTerminal(job) {
		return err
	}
	pages, err = store.Pages(ctx, job.ID)
	if err != nil {
		return err
	}
	stats := buildPageStats(pages)
	switch {
	case stats.deadLetterPages > 0:
		message := fmt.Sprintf("有 %d 页连续失败，任务已进入死信队列，可由管理员或 asynqmon 重放。", stats.deadLetterPages)
		now := time.Now().UTC()
		_, err = store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
			current.Status = "dead_letter"
			current.Error = &message
			current.DeadLetteredAt = &now
			current.ProcessedPages = countProcessedPages(pages)
			return nil
		})
		return err
	case stats.failedPages > 0:
		message := fmt.Sprintf("有 %d 页转 Markdown 失败，请重试失败页。", stats.failedPages)
		_, err = store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
			current.Status = "failed"
			current.Error = &message
			current.ProcessedPages = countProcessedPages(pages)
			return nil
		})
		return err
	case stats.pendingPages > 0:
		_, err = store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
			current.Status = "processing"
			current.ProcessedPages = countProcessedPages(pages)
			return nil
		})
		if err == nil {
			err = store.SetRunnable(ctx, job.ID, hasRunnableImportPage(pages))
		}
		return err
	default:
		return finalizeImportJobToArticle(ctx, job.ID)
	}
}

func runImportWorkerPool(ctx context.Context, job *JobRow, pages []JobPageRow) error {
	for i := range pages {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		page := pages[i]
		if page.Status != "pending" || page.ExtractedBy != "vision" || page.ImageKey == nil || derefStr(page.ImageKey) == "" {
			continue
		}
		latest, err := loadJobByID(ctx, job.ID)
		if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if documentImportJobTerminal(latest) {
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
		if current.Status != "pending" || current.AttemptCount >= current.MaxAttempts {
			return errPageNotRunnable
		}
		current.Status = "processing"
		current.AttemptCount++
		current.Error = nil
		current.DeadLetteredAt = nil
		return nil
	})
	if errors.Is(err, errPageNotRunnable) {
		return nil
	}
	if err != nil {
		return err
	}
	markdown, conversionErr := convertVisionPage(ctx, job, pageNo, imageKey)
	if conversionErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		message := truncateRunes(conversionErr.Error(), 500)
		_, err = store.UpdatePage(ctx, job.ID, pageNo, func(current *JobPageRow) error {
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
		_, err = store.UpdatePage(ctx, job.ID, pageNo, func(current *JobPageRow) error {
			current.Status = "done"
			current.Markdown = &markdown
			current.Error = nil
			current.LastError = nil
			current.DeadLetteredAt = nil
			return nil
		})
	}
	if err != nil {
		return err
	}
	_, _, err = refreshJobProgress(ctx, job.ID)
	return err
}

func convertVisionPage(ctx context.Context, job *JobRow, _ int64, imageKey string) (string, error) {
	if VisionChatInvoker == nil {
		return "", &httpx.HttpError{Status: 503, Message: "AI 服务未就绪"}
	}
	data, mime, err := fetchObjectBytes(ctx, imageKey)
	if err != nil {
		return "", fmt.Errorf("读取页面图片失败：%w", err)
	}
	answer, err := VisionChatInvoker(ctx, job.UserID, job.ModelConfigID,
		documentVisionSystemPrompt, documentVisionUserPrompt,
		VisionImageInput{Data: data, MIMEType: mime})
	if err != nil {
		return "", err
	}
	return normalizeVisionMarkdown(answer), nil
}

// finalizeImportJobToArticle 用 Redis 锁和预留文章 ID 跨系统幂等成文，不依赖 PostgreSQL 任务表。
func finalizeImportJobToArticle(ctx context.Context, jobID int64) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	release, err := store.AcquireJobLock(ctx, jobID, 10*time.Minute)
	if err != nil {
		return err
	}
	defer func() { _ = release(context.WithoutCancel(ctx)) }()

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
	if len(pages) == 0 {
		return badReq("任务没有可合并的页面")
	}
	if notDone := countNotDonePages(pages); notDone > 0 {
		return badReq(fmt.Sprintf("仍有 %d 页未成功转换，请先重试失败页", notDone))
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
		job.ArticleID = &articleID
		job.PendingArticleID = nil
		job.Status = "completed"
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

func resetDocumentImportForReplay(ctx context.Context, jobID int64) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	_, err = store.UpdatePages(ctx, jobID, func(pages []*JobPageRow) error {
		for _, page := range pages {
			if page.Status == "failed" || page.Status == "dead_letter" || page.Status == "processing" {
				resetDocumentImportPage(page)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	_, err = store.UpdateJob(ctx, jobID, func(job *JobRow) error {
		job.Status = "processing"
		job.Error = nil
		job.DeadLetteredAt = nil
		job.ReplayCount++
		return nil
	})
	if err != nil {
		return err
	}
	return store.SetRunnable(ctx, jobID, true)
}

func hasRunnableImportPage(pages []JobPageRow) bool {
	for i := range pages {
		page := pages[i]
		if page.Status == "pending" && page.AttemptCount < page.MaxAttempts &&
			page.ExtractedBy == "vision" && page.ImageKey != nil && strings.TrimSpace(*page.ImageKey) != "" {
			return true
		}
	}
	return false
}

func documentImportJobTerminal(job *JobRow) bool {
	return job.Status == "completed" || job.Status == "canceled" || job.ArticleID != nil
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
		value := truncateRunes(message, 500)
		job.Status = "failed"
		job.Error = &value
		return nil
	})
	_ = store.SetRunnable(ctx, jobID, false)
}
