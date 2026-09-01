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

// AdminDeadLetterJobs 返回两类持久 Worker 的死信，不暴露正文、模型输入或密钥。
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
		SELECT kind, id, user_id, knowledge_base_id, article_id, title,
		       attempt_count, max_attempts, replay_count, last_error, dead_lettered_at, updated_at
		FROM (
		  SELECT 'knowledge_build'::text AS kind, job.id::text AS id, job.user_id,
		         job.knowledge_base_id, job.article_id, article.title,
		         job.attempt_count, job.max_attempts, job.replay_count,
		         job.last_error, job.dead_lettered_at, job.updated_at
		  FROM petrichor_kb_knowledge_build_job AS job
		  JOIN petrichor_kb_article AS article ON article.id = job.article_id
		  WHERE job.status = 'dead_letter'
		  UNION ALL
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
		) AS dead_jobs
		ORDER BY dead_lettered_at DESC NULLS LAST, updated_at DESC
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
	switch request.Kind {
	case "knowledge_build":
		err = replayKnowledgeBuildDeadLetter(c.Request.Context(), request.ID)
	case "document_import":
		err = replayDocumentImportDeadLetter(c.Request.Context(), request.ID)
	default:
		err = &httpx.HttpError{Status: 400, Message: "不支持的死信任务类型"}
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, map[string]any{"kind": request.Kind, "id": request.ID, "status": "pending"})
}

func replayKnowledgeBuildDeadLetter(ctx context.Context, id string) error {
	tag, err := db.Pool().Exec(ctx, `
		UPDATE petrichor_kb_knowledge_build_job AS job
		SET status = 'pending', attempt_count = 0, next_attempt_at = now(),
		    result_json = NULL, error = NULL, last_error = NULL,
		    started_at = NULL, completed_at = NULL,
		    lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		    dead_lettered_at = NULL, replay_count = replay_count + 1, updated_at = now()
		WHERE job.id = $1 AND job.status = 'dead_letter'
		  AND NOT EXISTS (
		    SELECT 1 FROM petrichor_kb_knowledge_build_job AS active
		    WHERE active.id <> job.id AND active.user_id = job.user_id
		      AND active.knowledge_base_id = job.knowledge_base_id
		      AND active.article_id = job.article_id AND active.status IN ('pending', 'processing')
		  )`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &httpx.HttpError{Status: 409, Message: "死信不存在，或同一文章已有运行中的构建任务"}
	}
	return nil
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
