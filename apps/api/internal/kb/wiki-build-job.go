// wiki-build-job.go 「构建知识」的异步任务生命周期与 HTTP 端点：
// 任务登记、并发槽位、状态轮询与过期清理。真正的编译与落库在 wiki-build.go。
package kb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	httpx "petrichor/api/internal/httpx"
)

// ===== knowledge/build =====

const (
	knowledgeBuildJobTTL       = 24 * time.Hour
	knowledgeBuildJobTimeout   = 15 * time.Minute
	knowledgeBuildJobPoll      = time.Second
	knowledgeBuildConcurrency  = 2
	knowledgeBuildAdvisoryLock = int32(0x50455452) // "PETR"
)

type articleKnowledgeBuildJob struct {
	ID              string
	UserID          int64
	KnowledgeBaseID int64
	ArticleID       int64
	Status          string
	Result          map[string]any
	Error           *string
	AttemptCount    int32
	MaxAttempts     int32
	NextAttemptAt   time.Time
	LastError       *string
	LeaseOwner      *string
	LeaseExpiresAt  *time.Time
	HeartbeatAt     *time.Time
	DeadLetteredAt  *time.Time
	ReplayCount     int32
	StartedAt       *time.Time
	CompletedAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

func articleKnowledgeBuildJobResponse(job *articleKnowledgeBuildJob) map[string]any {
	return map[string]any{
		"id":              job.ID,
		"userId":          strconv.FormatInt(job.UserID, 10),
		"knowledgeBaseId": strconv.FormatInt(job.KnowledgeBaseID, 10),
		"articleId":       strconv.FormatInt(job.ArticleID, 10),
		"status":          job.Status,
		"result":          job.Result,
		"error":           job.Error,
		"attemptCount":    job.AttemptCount,
		"maxAttempts":     job.MaxAttempts,
		"nextAttemptAt":   iso(job.NextAttemptAt),
		"lastError":       job.LastError,
		"leaseExpiresAt":  isoPtr(job.LeaseExpiresAt),
		"heartbeatAt":     isoPtr(job.HeartbeatAt),
		"deadLetteredAt":  isoPtr(job.DeadLetteredAt),
		"replayCount":     job.ReplayCount,
		"startedAt":       isoPtr(job.StartedAt),
		"completedAt":     isoPtr(job.CompletedAt),
		"createdAt":       iso(job.CreatedAt),
		"updatedAt":       iso(job.UpdatedAt),
	}
}

const articleKnowledgeBuildJobColumns = `id, user_id, knowledge_base_id, article_id, status,
	result_json, error, attempt_count, max_attempts, next_attempt_at, last_error, lease_owner,
	lease_expires_at, heartbeat_at, dead_lettered_at, replay_count,
	started_at, completed_at, created_at, updated_at`

func scanArticleKnowledgeBuildJob(row pgx.Row) (*articleKnowledgeBuildJob, error) {
	var (
		job       articleKnowledgeBuildJob
		resultRaw *string
	)
	if err := row.Scan(&job.ID, &job.UserID, &job.KnowledgeBaseID, &job.ArticleID, &job.Status,
		&resultRaw, &job.Error, &job.AttemptCount, &job.MaxAttempts, &job.NextAttemptAt,
		&job.LastError, &job.LeaseOwner, &job.LeaseExpiresAt, &job.HeartbeatAt, &job.DeadLetteredAt,
		&job.ReplayCount, &job.StartedAt, &job.CompletedAt, &job.CreatedAt, &job.UpdatedAt); err != nil {
		return nil, err
	}
	if resultRaw != nil && strings.TrimSpace(*resultRaw) != "" {
		if err := json.Unmarshal([]byte(*resultRaw), &job.Result); err != nil {
			return nil, fmt.Errorf("解析知识构建任务结果失败: %w", err)
		}
	}
	return &job, nil
}

func cleanupArticleKnowledgeBuildJobs(ctx context.Context, q execQuerier, now time.Time) error {
	// 租约过期表示 Worker 失联。未耗尽次数的任务立即回队列；耗尽的进入死信，
	// 不再靠 started_at 猜测中断次数。
	if _, err := q.Exec(ctx,
		`UPDATE petrichor_kb_knowledge_build_job
		 SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
		     error = CASE WHEN attempt_count >= max_attempts THEN '知识构建多次中断，已进入死信队列' ELSE NULL END,
		     last_error = COALESCE(last_error, 'Worker 租约过期'),
		     next_attempt_at = CASE WHEN attempt_count >= max_attempts THEN next_attempt_at ELSE $1 END,
		     dead_lettered_at = CASE WHEN attempt_count >= max_attempts THEN $1 ELSE NULL END,
		     completed_at = CASE WHEN attempt_count >= max_attempts THEN $1 ELSE NULL END,
		     lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = $1
		 WHERE status = 'processing' AND COALESCE(lease_expires_at, '-infinity'::timestamptz) < $1`, now); err != nil {
		return err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_knowledge_build_job
		 WHERE status IN ('completed', 'failed') AND updated_at < $1`, now.Add(-knowledgeBuildJobTTL)); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_knowledge_build_job
		 WHERE status = 'dead_letter' AND updated_at < $1`, now.Add(-workerDeadLetterTTL))
	return err
}

func loadActiveArticleKnowledgeBuildJob(ctx context.Context, q execQuerier, userID, knowledgeBaseID, articleID int64) (*articleKnowledgeBuildJob, error) {
	job, err := scanArticleKnowledgeBuildJob(q.QueryRow(ctx,
		`SELECT `+articleKnowledgeBuildJobColumns+`
		 FROM petrichor_kb_knowledge_build_job
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND article_id = $3
		   AND status IN ('pending', 'processing')
		 ORDER BY created_at DESC LIMIT 1`,
		userID, knowledgeBaseID, articleID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return job, err
}

func loadOwnedArticleKnowledgeBuildJob(ctx context.Context, q execQuerier, userID int64, jobID string) (*articleKnowledgeBuildJob, error) {
	job, err := scanArticleKnowledgeBuildJob(q.QueryRow(ctx,
		`SELECT `+articleKnowledgeBuildJobColumns+`
		 FROM petrichor_kb_knowledge_build_job WHERE id = $1 AND user_id = $2 LIMIT 1`,
		jobID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return job, err
}

func createArticleKnowledgeBuildJob(ctx context.Context, userID, knowledgeBaseID, articleID int64) (map[string]any, string, bool, error) {
	q := pool()

	now := time.Now()
	if err := cleanupArticleKnowledgeBuildJobs(ctx, q, now); err != nil {
		return nil, "", false, err
	}
	if active, err := loadActiveArticleKnowledgeBuildJob(ctx, q, userID, knowledgeBaseID, articleID); err != nil {
		return nil, "", false, err
	} else if active != nil {
		return articleKnowledgeBuildJobResponse(active), active.ID, false, nil
	}

	for attempts := 0; attempts < 3; attempts++ {
		id, err := generateCode()
		if err != nil {
			return nil, "", false, err
		}
		job, insertErr := scanArticleKnowledgeBuildJob(q.QueryRow(ctx,
			`INSERT INTO petrichor_kb_knowledge_build_job
			 (id, user_id, knowledge_base_id, article_id, status, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'pending', $5, $5)
			 ON CONFLICT DO NOTHING
			 RETURNING `+articleKnowledgeBuildJobColumns,
			id, userID, knowledgeBaseID, articleID, now))
		if insertErr == nil {
			return articleKnowledgeBuildJobResponse(job), job.ID, true, nil
		}
		if !errors.Is(insertErr, pgx.ErrNoRows) {
			return nil, "", false, insertErr
		}
		active, activeErr := loadActiveArticleKnowledgeBuildJob(ctx, q, userID, knowledgeBaseID, articleID)
		if activeErr != nil {
			return nil, "", false, activeErr
		}
		if active != nil {
			return articleKnowledgeBuildJobResponse(active), active.ID, false, nil
		}
	}
	return nil, "", false, errors.New("生成知识构建任务 ID 失败")
}

func claimNextArticleKnowledgeBuildJob(ctx context.Context, leaseOwner string, now time.Time) (*articleKnowledgeBuildJob, error) {
	job, err := scanArticleKnowledgeBuildJob(pool().QueryRow(ctx,
		`WITH candidate AS (
		   SELECT id FROM petrichor_kb_knowledge_build_job
		   WHERE status = 'pending' AND next_attempt_at <= $1 AND attempt_count < max_attempts
		   ORDER BY next_attempt_at, created_at, id
		   FOR UPDATE SKIP LOCKED
		   LIMIT 1
		 )
		 UPDATE petrichor_kb_knowledge_build_job AS job
		 SET status = 'processing', started_at = COALESCE(job.started_at, $1),
		     attempt_count = job.attempt_count + 1, error = NULL, completed_at = NULL,
		     lease_owner = $2, lease_expires_at = $3, heartbeat_at = $1, updated_at = $1
		 FROM candidate
		 WHERE job.id = candidate.id
		 RETURNING `+articleKnowledgeBuildJobColumns,
		now, leaseOwner, now.Add(workerLeaseDuration)))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return job, err
}

func finishArticleKnowledgeBuildJob(
	ctx context.Context,
	job *articleKnowledgeBuildJob,
	leaseOwner string,
	result map[string]any,
	buildErr error,
) (string, error) {
	now := time.Now()
	status := "completed"
	var resultJSON *string
	var errorMessage *string
	var lastError *string
	var completedAt *time.Time
	var deadLetteredAt *time.Time
	nextAttemptAt := job.NextAttemptAt
	if buildErr == nil {
		encoded, err := json.Marshal(result)
		if err != nil {
			return "", err
		}
		value := string(encoded)
		resultJSON = &value
		completedAt = &now
	} else {
		message := "知识构建失败，请稍后重试"
		var httpErr *httpx.HttpError
		if errors.As(buildErr, &httpErr) {
			message = httpErr.Message
		} else if errors.Is(buildErr, context.Canceled) || errors.Is(buildErr, context.DeadlineExceeded) {
			message = "知识构建执行超时或中断"
		}
		message = truncateRunes(message, 500)
		lastError = &message
		status = workerFailureStatus(buildErr, job.AttemptCount, job.MaxAttempts)
		switch status {
		case "pending":
			nextAttemptAt = now.Add(workerRetryDelay(int(job.AttemptCount), job.ID))
		case "dead_letter":
			message = "知识构建连续失败，已进入死信队列：" + message
			errorMessage = &message
			deadLetteredAt = &now
			completedAt = &now
		default:
			errorMessage = &message
			completedAt = &now
		}
	}
	tag, err := pool().Exec(ctx,
		`UPDATE petrichor_kb_knowledge_build_job
		 SET status = $3, result_json = $4, error = $5, last_error = $6,
		     next_attempt_at = $7, completed_at = $8, dead_lettered_at = $9,
		     lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = $10
		 WHERE id = $1 AND status = 'processing' AND lease_owner = $2`,
		job.ID, leaseOwner, status, resultJSON, errorMessage, lastError,
		nextAttemptAt, completedAt, deadLetteredAt, now)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		return "", fmt.Errorf("知识构建任务租约已失效: %s", job.ID)
	}
	return status, nil
}

// StartArticleKnowledgeBuildWorkers 启动可恢复的数据库 Worker。PostgreSQL advisory lock
// 把并发槽扩展为跨实例全局槽，FOR UPDATE SKIP LOCKED 保证任务只被一个 Worker 领取。
func StartArticleKnowledgeBuildWorkers(ctx context.Context) func() {
	var workers sync.WaitGroup
	for slot := 0; slot < knowledgeBuildConcurrency; slot++ {
		workers.Add(1)
		go func(slot int) {
			defer workers.Done()
			runArticleKnowledgeBuildSlot(ctx, slot)
		}(slot)
	}
	return workers.Wait
}

func runArticleKnowledgeBuildSlot(ctx context.Context, slot int) {
	for ctx.Err() == nil {
		connection, err := pool().Acquire(ctx)
		if err != nil {
			return
		}
		locked, lockErr := tryArticleKnowledgeBuildSlot(ctx, connection, slot)
		if lockErr != nil || !locked {
			connection.Release()
			if lockErr != nil {
				slog.Warn("知识构建 Worker 获取全局槽失败", "slot", slot, "err", lockErr)
			}
			if !waitKnowledgeBuildPoll(ctx) {
				return
			}
			continue
		}

		slog.Info("知识构建 Worker 已取得全局槽", "slot", slot)
		leaseOwner := fmt.Sprintf("knowledge-%d-%d", slot, time.Now().UnixNano())
		runOwnedArticleKnowledgeBuildSlot(ctx, slot, leaseOwner)
		releaseArticleKnowledgeBuildSlot(connection, slot)
		connection.Release()
		return
	}
}

func tryArticleKnowledgeBuildSlot(ctx context.Context, connection *pgxpool.Conn, slot int) (bool, error) {
	var locked bool
	err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock($1, $2)`, knowledgeBuildAdvisoryLock, slot).Scan(&locked)
	return locked, err
}

func releaseArticleKnowledgeBuildSlot(connection *pgxpool.Conn, slot int) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var unlocked bool
	if err := connection.QueryRow(ctx, `SELECT pg_advisory_unlock($1, $2)`, knowledgeBuildAdvisoryLock, slot).Scan(&unlocked); err != nil || !unlocked {
		slog.Warn("知识构建 Worker 释放全局槽失败", "slot", slot, "unlocked", unlocked, "err", err)
	}
}

func runOwnedArticleKnowledgeBuildSlot(ctx context.Context, slot int, leaseOwner string) {
	nextCleanup := time.Time{}
	for ctx.Err() == nil {
		now := time.Now()
		if now.After(nextCleanup) {
			if err := cleanupArticleKnowledgeBuildJobs(ctx, pool(), now); err != nil && !errors.Is(err, context.Canceled) {
				slog.Warn("知识构建任务清理失败", "slot", slot, "err", err)
			}
			nextCleanup = now.Add(time.Minute)
		}
		job, err := claimNextArticleKnowledgeBuildJob(ctx, leaseOwner, now)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				slog.Error("知识构建任务领取失败", "slot", slot, "err", err)
			}
			if !waitKnowledgeBuildPoll(ctx) {
				return
			}
			continue
		}
		if job == nil {
			if !waitKnowledgeBuildPoll(ctx) {
				return
			}
			continue
		}
		executeClaimedArticleKnowledgeBuildJob(ctx, job, leaseOwner)
	}
}

func executeClaimedArticleKnowledgeBuildJob(parent context.Context, job *articleKnowledgeBuildJob, leaseOwner string) {
	startedAt := time.Now()
	timeoutCtx, timeoutCancel := context.WithTimeout(parent, knowledgeBuildJobTimeout)
	defer timeoutCancel()
	ctx, stopHeartbeat := maintainArticleKnowledgeBuildLease(timeoutCtx, job.ID, leaseOwner)
	defer stopHeartbeat()
	defer func() {
		if recovered := recover(); recovered != nil {
			buildErr := fmt.Errorf("知识构建发生 panic: %v", recovered)
			slog.Error("后台知识构建异常", "jobId", job.ID, "err", buildErr)
			finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
			defer finishCancel()
			if _, err := finishArticleKnowledgeBuildJob(finishCtx, job, leaseOwner, nil, buildErr); err != nil {
				slog.Error("知识构建任务状态写入失败", "jobId", job.ID, "err", err)
			}
		}
	}()

	result, buildErr := buildArticleKnowledgeCore(ctx, pool(), job.UserID, job.KnowledgeBaseID, job.ArticleID)
	if buildErr != nil {
		slog.Error("后台知识构建失败", "jobId", job.ID, "userId", job.UserID, "knowledgeBaseId", job.KnowledgeBaseID, "articleId", job.ArticleID, "attempt", job.AttemptCount, "err", buildErr)
	}
	// 进程关停导致的取消不写失败；租约到期后其它实例会重新领取。
	if parent.Err() != nil && errors.Is(buildErr, context.Canceled) {
		return
	}
	stopHeartbeat()
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
	defer finishCancel()
	status, err := finishArticleKnowledgeBuildJob(finishCtx, job, leaseOwner, result, buildErr)
	if err != nil {
		slog.Error("知识构建任务结果写入失败", "jobId", job.ID, "err", err)
		return
	}
	slog.Info("知识构建任务结束", "jobId", job.ID, "status", status, "attempt", job.AttemptCount, "durationMs", time.Since(startedAt).Milliseconds())
}

func maintainArticleKnowledgeBuildLease(parent context.Context, jobID, leaseOwner string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	var once sync.Once
	var worker sync.WaitGroup
	worker.Add(1)
	go func() {
		defer worker.Done()
		ticker := time.NewTicker(workerHeartbeatEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				heartbeatCtx, heartbeatCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				tag, err := pool().Exec(heartbeatCtx,
					`UPDATE petrichor_kb_knowledge_build_job
					 SET heartbeat_at = $3, lease_expires_at = $4, updated_at = $3
					 WHERE id = $1 AND status = 'processing' AND lease_owner = $2`,
					jobID, leaseOwner, now, now.Add(workerLeaseDuration))
				heartbeatCancel()
				if err != nil || tag.RowsAffected() == 0 {
					slog.Error("知识构建任务租约心跳失败", "jobId", jobID, "err", err)
					cancel()
					return
				}
			}
		}
	}()
	stop := func() {
		once.Do(func() {
			cancel()
			worker.Wait()
		})
	}
	return ctx, stop
}

func waitKnowledgeBuildPoll(ctx context.Context) bool {
	timer := time.NewTimer(knowledgeBuildJobPoll)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// ArticleKnowledgeBuild 创建单篇「构建知识」后台任务；重复点击会复用同一运行中任务。
func ArticleKnowledgeBuild(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		_ = rawBool(raw, "forceRebuild") // 当前构建恒为全量重建，保留兼容参数。
		if err := requireChat(); err != nil {
			return nil, err
		}

		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		article, err := queryArticle(c.Request.Context(), q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article
			 WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3 LIMIT 1`,
			articleID, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}
		if trimSpace(article.ContentMd) == "" {
			return nil, badReq("文章没有可构建的 Markdown 内容")
		}

		response, _, _, err := createArticleKnowledgeBuildJob(c.Request.Context(), user.ID, kbID, articleID)
		if err != nil {
			return nil, err
		}
		return response, nil
	})
}

// ArticleKnowledgeBuildStatus 查询当前用户创建的知识构建任务。
func ArticleKnowledgeBuildStatus(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		jobID := trimmedString(raw, "jobId")
		if jobID == "" || len(jobID) > 200 {
			return nil, badReq("jobId 必须是合法任务 ID")
		}
		q := pool()
		requestCtx := c.Request.Context()
		if err := cleanupArticleKnowledgeBuildJobs(requestCtx, q, time.Now()); err != nil {
			return nil, err
		}
		job, err := loadOwnedArticleKnowledgeBuildJob(requestCtx, q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job == nil {
			return nil, notFoundErr("知识构建任务不存在或已过期")
		}
		return articleKnowledgeBuildJobResponse(job), nil
	})
}

// buildArticleKnowledgeCore 切片 → 问题/候选并行抽取 → 目录 → 页面物化 → 落库。
