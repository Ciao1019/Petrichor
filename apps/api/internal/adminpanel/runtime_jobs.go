package adminpanel

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	"petrichor/api/internal/httpx"
)

type deadLetterJob struct {
	Kind            string     `json:"kind"`
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

// AdminDeadLetterJobs 返回视觉导入 Worker 的死信，不暴露正文、模型输入或密钥。
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
	rows, err := db.Pool().Query(ctx, `
		SELECT 'document_import'::text, job.id::text, job.user_id,
		       job.knowledge_base_id, job.article_id, job.title,
		       COALESCE(MAX(page.attempt_count), 0)::integer,
		       COALESCE(MAX(page.max_attempts), 5)::integer, job.replay_count,
		       COALESCE(
		         (array_agg(page.last_error ORDER BY page.updated_at DESC)
		           FILTER (WHERE page.last_error IS NOT NULL))[1],
		         job.error
		       ), job.dead_lettered_at, job.updated_at
		FROM petrichor_kb_import_job AS job
		LEFT JOIN petrichor_kb_import_job_page AS page ON page.job_id = job.id
		WHERE job.status = 'dead_letter'
		GROUP BY job.id
		ORDER BY job.dead_lettered_at DESC NULLS LAST, job.updated_at DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]deadLetterJob, 0)
	for rows.Next() {
		var item deadLetterJob
		var userID, knowledgeBaseID int64
		var articleID *int64
		if err := rows.Scan(&item.Kind, &item.ID, &userID, &knowledgeBaseID, &articleID,
			&item.Title, &item.AttemptCount, &item.MaxAttempts, &item.ReplayCount,
			&item.LastError, &item.DeadLetteredAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.UserID = strconv.FormatInt(userID, 10)
		item.KnowledgeBaseID = strconv.FormatInt(knowledgeBaseID, 10)
		if articleID != nil {
			value := strconv.FormatInt(*articleID, 10)
			item.ArticleID = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type replayDeadLetterRequest struct {
	Kind string `json:"kind" binding:"required"`
	ID   string `json:"id" binding:"required"`
}

// AdminReplayDeadLetter 原子重置死信的尝试次数和调度时间；Worker 下个轮询周期自动领取。
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
		err = replayDocumentImportDeadLetter(c.Request.Context(), request.ID)
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, map[string]any{"kind": request.Kind, "id": request.ID, "status": "pending"})
}

func replayDocumentImportDeadLetter(ctx context.Context, rawID string) error {
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		return &httpx.HttpError{Status: 400, Message: "id 必须是正整数"}
	}
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM petrichor_kb_import_job WHERE id = $1 FOR UPDATE`, id).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &httpx.HttpError{Status: 404, Message: "死信任务不存在"}
		}
		return err
	}
	if status != "dead_letter" {
		return &httpx.HttpError{Status: 409, Message: "任务不在死信状态"}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE petrichor_kb_import_job_page
		SET status = 'pending', attempt_count = 0, next_attempt_at = now(),
		    error = NULL, last_error = NULL, dead_lettered_at = NULL, updated_at = now()
		WHERE job_id = $1 AND status IN ('dead_letter', 'failed', 'processing')`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE petrichor_kb_import_job
		SET status = 'processing', error = NULL, dead_lettered_at = NULL,
		    processed_pages = (SELECT COUNT(*)::integer FROM petrichor_kb_import_job_page
		                       WHERE job_id = $1 AND status = 'done'),
		    lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		    replay_count = replay_count + 1, updated_at = now()
		WHERE id = $1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
