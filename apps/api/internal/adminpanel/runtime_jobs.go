package adminpanel

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

type deadLetterJob struct {
	Kind            string     `json:"kind"`
	Stage           string     `json:"stage"`
	PrepareAttempt  int32      `json:"prepareAttempt"`
	ID              string     `json:"id"`
	UserID          string     `json:"userId"`
	KnowledgeBaseID string     `json:"knowledgeBaseId"`
	ArticleID       *string    `json:"articleId"`
	Title           string     `json:"title"`
	AttemptCount    int32      `json:"attemptCount"`
	MaxAttempts     int32      `json:"maxAttempts"`
	ReplayCount     int32      `json:"replayCount"`
	LastError       *string    `json:"lastError"`
	DeadLetteredAt  *time.Time `json:"deadLetteredAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

// AdminDeadLetterJobs 从 Redis 返回视觉导入业务死信，不暴露 Markdown、图片地址或模型输入。
func AdminDeadLetterJobs(c *gin.Context) {
	limit := 100
	if raw := c.Query("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = min(parsed, 200)
		}
	}
	items, err := loadDeadLetterJobs(c.Request.Context(), limit)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, map[string]any{"items": items})
}

func loadDeadLetterJobs(ctx context.Context, limit int) ([]deadLetterJob, error) {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return nil, err
	}
	jobs, err := store.ListByStatus(ctx, "dead_letter", int64(limit))
	if err != nil {
		return nil, err
	}
	items := make([]deadLetterJob, 0, len(jobs))
	for i := range jobs {
		job := jobs[i]
		pages, err := store.Pages(ctx, job.ID)
		if err != nil {
			return nil, err
		}
		item := deadLetterJob{
			Kind: "document_import", ID: strconv.FormatInt(job.ID, 10),
			UserID:          strconv.FormatInt(job.UserID, 10),
			KnowledgeBaseID: strconv.FormatInt(job.KnowledgeBaseID, 10),
			Title:           job.Title, ReplayCount: job.ReplayCount,
			LastError: job.Error, DeadLetteredAt: job.DeadLetteredAt, UpdatedAt: job.UpdatedAt,
			MaxAttempts: job.PrepareMaxAttempts, AttemptCount: job.PrepareAttempt,
			Stage: job.Stage, PrepareAttempt: job.PrepareAttempt,
		}
		if job.ArticleID != nil {
			value := strconv.FormatInt(*job.ArticleID, 10)
			item.ArticleID = &value
		}
		for pageIndex := range pages {
			page := pages[pageIndex]
			item.AttemptCount = max(item.AttemptCount, page.AttemptCount)
			item.MaxAttempts = max(item.MaxAttempts, page.MaxAttempts)
			if page.LastError != nil && page.UpdatedAt.After(item.UpdatedAt) {
				item.LastError = page.LastError
				item.UpdatedAt = page.UpdatedAt
			}
		}
		items = append(items, item)
	}
	return items, nil
}

type replayDeadLetterRequest struct {
	Kind string `json:"kind" binding:"required"`
	ID   string `json:"id" binding:"required"`
}

func AdminReplayDeadLetter(c *gin.Context) {
	var request replayDeadLetterRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httpx.HandleError(c, &httpx.HttpError{Status: 400, Message: "kind 和 id 不能为空"})
		return
	}
	var err error
	if request.Kind != "document_import" {
		err = &httpx.HttpError{Status: 400, Message: "只支持重放视觉导入死信"}
	} else {
		err = replayDocumentImportDeadLetter(c.Request.Context(), request.ID, c.Query("reset") == "1")
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, map[string]any{"kind": request.Kind, "id": request.ID, "status": "pending"})
}

func replayDocumentImportDeadLetter(ctx context.Context, rawID string, reset ...bool) error {
	canReplay := func(status string) bool {
		return status == "dead_letter" || (len(reset) > 0 && reset[0] && status == "failed")
	}
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		return &httpx.HttpError{Status: 400, Message: "id 必须是正整数"}
	}
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	job, err := store.Get(ctx, id)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return &httpx.HttpError{Status: 404, Message: "死信任务不存在"}
	}
	if err != nil {
		return err
	}
	if !canReplay(job.Status) {
		return &httpx.HttpError{Status: 409, Message: "任务不在死信状态"}
	}
	pages, err := store.UpdateJobPages(ctx, id, func(current *taskqueue.DocumentImportJob, pages []*taskqueue.DocumentImportPage) error {
		if !canReplay(current.Status) {
			return &httpx.HttpError{Status: 409, Message: "任务不在死信状态"}
		}
		for _, page := range pages {
			if page.Status != "dead_letter" && page.Status != "failed" && page.Status != "processing" {
				continue
			}
			taskqueue.ResetDocumentImportPageRetry(page)
		}
		taskqueue.ResetDocumentImportTaskRetry(current)
		current.Status = "processing"
		current.ProcessedPages = 0
		for _, page := range pages {
			if page.Status == "done" {
				current.ProcessedPages++
			}
		}
		current.Error = nil
		current.DeadLetteredAt = nil
		current.ReplayCount++
		return nil
	})
	if errors.Is(err, taskqueue.ErrDocumentImportEnded) {
		return &httpx.HttpError{Status: 409, Message: "任务已结束，不能重放"}
	}
	if err != nil {
		return err
	}
	job, err = store.Get(ctx, id)
	if err != nil {
		return err
	}
	if !taskqueue.DocumentImportRunnable(job, pages) {
		return nil
	}
	if err := taskqueue.EnqueueDocumentImport(ctx, id); err != nil {
		return &httpx.HttpError{Status: 503, Message: "视觉导入队列暂不可用；Redis 补偿任务会自动重试入队"}
	}
	return nil
}
