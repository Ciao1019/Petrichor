// wiki-build-job.go 管理「构建知识」的 Asynq 入队、状态轮询与 Worker 执行。
// 中间状态和成功结果按 Asynq retention 保存在 Redis；长期知识结果仍由 wiki-build.go 事务落库。
package kb

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/hibiken/asynq"

	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

type knowledgeBuildTaskResult struct {
	Result      map[string]any          `json:"result"`
	Error       *string                 `json:"error,omitempty"`
	Progress    *knowledgeBuildProgress `json:"progress,omitempty"`
	StartedAt   time.Time               `json:"startedAt"`
	CompletedAt time.Time               `json:"completedAt"`
}

type skipTaskRetryError struct {
	message string
}

func (err *skipTaskRetryError) Error() string { return err.message }
func (err *skipTaskRetryError) Unwrap() error { return asynq.SkipRetry }

const knowledgeBuildStatusListLimit = 200

var (
	questionBatchConcurrency = config.DefaultKnowledgeBuildQuestionBatchConcurrency
	wikiPageBatchConcurrency = config.DefaultKnowledgeBuildPageBatchConcurrency
	knowledgeBuildModelSlots = make(chan struct{}, config.DefaultKnowledgeBuildModelConcurrency)
)

// ConfigureKnowledgeBuild 为 Asynq Worker 加载阶段任务池与全局模型并发配置。
func ConfigureKnowledgeBuild(settings config.KnowledgeBuildConfig) {
	questionBatchConcurrency = settings.QuestionBatchConcurrency
	wikiPageBatchConcurrency = settings.PageBatchConcurrency
	knowledgeBuildModelSlots = make(chan struct{}, settings.ModelConcurrency)
	slog.Info("知识构建 Asynq 并发配置已加载",
		"articleConcurrency", settings.Concurrency,
		"queueLimit", settings.QueueSize,
		"questionBatchConcurrency", settings.QuestionBatchConcurrency,
		"pageBatchConcurrency", settings.PageBatchConcurrency,
		"modelConcurrency", settings.ModelConcurrency,
	)
}

func executeArticleKnowledgeBuild(ctx context.Context, userID, knowledgeBaseID, articleID int64) (map[string]any, error) {
	return buildArticleKnowledgeCore(ctx, pool(), userID, knowledgeBaseID, articleID)
}

// HandleKnowledgeBuildTask 执行单篇知识构建，并把阶段进度与最终结果写入 Asynq ResultWriter。
func HandleKnowledgeBuildTask(ctx context.Context, task *asynq.Task) error {
	payload, err := taskqueue.DecodeKnowledgeBuildPayload(task)
	if err != nil {
		return &skipTaskRetryError{message: "知识构建任务负载无效"}
	}
	taskID, ok := asynq.GetTaskID(ctx)
	if !ok || taskID == "" {
		return errors.New("知识构建任务缺少 Asynq 任务 ID")
	}
	startedAt := time.Now().UTC()
	retried, _ := asynq.GetRetryCount(ctx)
	maxRetry, _ := asynq.GetMaxRetry(ctx)
	progressWriter := newKnowledgeBuildTaskProgressWriter(task, startedAt, retried+1, maxRetry+1)
	ctx = withKnowledgeBuildProgressReporter(ctx, progressWriter)
	stopHeartbeat := progressWriter.startHeartbeat(ctx)
	defer stopHeartbeat()
	progressWriter.reportEvent(knowledgeBuildPhaseQueued, "Worker 已接收知识构建任务")
	progressWriter.report(knowledgeBuildProgress{
		Percent: 2, Phase: knowledgeBuildPhasePreparing, Message: "正在读取文章与知识库配置",
	})

	result, buildErr := executeArticleKnowledgeBuild(
		ctx, payload.UserID, payload.KnowledgeBaseID, payload.ArticleID,
	)
	if buildErr != nil {
		stopHeartbeat()
		slog.Error("后台知识构建失败",
			"jobId", taskID,
			"userId", payload.UserID,
			"knowledgeBaseId", payload.KnowledgeBaseID,
			"articleId", payload.ArticleID,
			"err", buildErr,
		)
		message := knowledgeBuildErrorMessage(buildErr)
		phase := knowledgeBuildPhaseFailed
		progressMessage := message
		if workerErrorRetryable(buildErr) {
			phase = knowledgeBuildPhaseRetrying
			progressMessage = "本轮构建失败，等待 Asynq 自动重试"
		}
		progressWriter.report(knowledgeBuildProgress{
			Percent: -1, Phase: phase, Message: progressMessage,
		})
		progress := progressWriter.snapshot()
		_ = writeKnowledgeBuildTaskResult(task, knowledgeBuildTaskResult{
			Error: &message, Progress: &progress, StartedAt: startedAt, CompletedAt: time.Now().UTC(),
		})
		if !workerErrorRetryable(buildErr) {
			return &skipTaskRetryError{message: message}
		}
		return errors.New(message)
	}

	stopHeartbeat()
	completedAt := time.Now().UTC()
	progressWriter.report(knowledgeBuildProgress{
		Percent: 100, Phase: knowledgeBuildPhaseCompleted, Message: "知识构建完成",
	})
	progress := progressWriter.snapshot()
	if err := writeKnowledgeBuildTaskResult(task, knowledgeBuildTaskResult{
		Result: result, Progress: &progress, StartedAt: startedAt, CompletedAt: completedAt,
	}); err != nil {
		return errors.New("知识构建结果写入失败")
	}
	slog.Info("知识构建 Asynq 任务完成",
		"jobId", taskID,
		"userId", payload.UserID,
		"knowledgeBaseId", payload.KnowledgeBaseID,
		"articleId", payload.ArticleID,
		"durationMs", completedAt.Sub(startedAt).Milliseconds(),
	)
	return nil
}

func writeKnowledgeBuildTaskResult(task *asynq.Task, result knowledgeBuildTaskResult) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = task.ResultWriter().Write(encoded)
	return err
}

func knowledgeBuildErrorMessage(err error) string {
	message := "知识构建失败，请稍后重试"
	var httpErr *httpx.HttpError
	switch {
	case errors.As(err, &httpErr):
		message = httpErr.Message
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		message = "知识构建执行超时或中断"
	}
	return truncateRunes(message, 500)
}

func articleKnowledgeBuildJobResponse(info *asynq.TaskInfo) (map[string]any, error) {
	payload, err := taskqueue.DecodeKnowledgeBuildPayload(asynq.NewTask(info.Type, info.Payload))
	if err != nil {
		return nil, err
	}
	status := "pending"
	var result map[string]any
	var errorMessage *string
	var startedAt, completedAt *time.Time
	updatedAt := payload.CreatedAt
	progress := initialKnowledgeBuildProgress(payload.CreatedAt, info.Retried+1, info.MaxRetry+1)
	var taskResult knowledgeBuildTaskResult
	hasTaskResult := len(info.Result) > 0 && json.Unmarshal(info.Result, &taskResult) == nil
	if hasTaskResult {
		if !taskResult.StartedAt.IsZero() {
			startedAt = &taskResult.StartedAt
		}
		if taskResult.Progress != nil {
			progress = normalizeKnowledgeBuildProgress(*taskResult.Progress)
			updatedAt = progress.UpdatedAt
		}
	}

	switch info.State {
	case asynq.TaskStateActive:
		status = "processing"
		if progress.Percent == 0 {
			progress = knowledgeBuildProgress{
				Percent: 1, Phase: knowledgeBuildPhasePreparing, Message: "Worker 已开始处理", UpdatedAt: time.Now().UTC(),
			}
		}
	case asynq.TaskStateCompleted:
		status = "completed"
		result = taskResult.Result
		completed := info.CompletedAt
		completedAt = &completed
		if hasTaskResult && !taskResult.CompletedAt.IsZero() {
			completedAt = &taskResult.CompletedAt
			completed = taskResult.CompletedAt
		}
		updatedAt = completed
		progress.Percent = 100
		progress.Phase = knowledgeBuildPhaseCompleted
		progress.Message = "知识构建完成"
		progress.UpdatedAt = completed
	case asynq.TaskStateArchived:
		status = "failed"
		failedAt := info.LastFailedAt
		if failedAt.IsZero() {
			failedAt = payload.CreatedAt
		}
		completedAt = &failedAt
		updatedAt = failedAt
		message := "知识构建失败，请稍后重试"
		if hasTaskResult && taskResult.Error != nil && strings.TrimSpace(*taskResult.Error) != "" {
			message = *taskResult.Error
		}
		message = truncateRunes(message, 500)
		errorMessage = &message
		progress.Phase = knowledgeBuildPhaseFailed
		progress.Message = message
		progress.UpdatedAt = failedAt
	case asynq.TaskStateRetry, asynq.TaskStateScheduled, asynq.TaskStatePending, asynq.TaskStateAggregating:
		status = "pending"
		completedAt = nil
		if !info.LastFailedAt.IsZero() {
			updatedAt = info.LastFailedAt
		}
		if info.State == asynq.TaskStateRetry {
			progress.Phase = knowledgeBuildPhaseRetrying
			progress.Message = "等待 Asynq 自动重试"
		}
	}
	if !hasTaskResult {
		progress.Attempt = info.Retried + 1
	}
	progress.MaxAttempts = max(progress.MaxAttempts, info.MaxRetry+1)
	progress = normalizeKnowledgeBuildProgress(progress)

	return map[string]any{
		"id":              info.ID,
		"userId":          strconv.FormatInt(payload.UserID, 10),
		"knowledgeBaseId": strconv.FormatInt(payload.KnowledgeBaseID, 10),
		"articleId":       strconv.FormatInt(payload.ArticleID, 10),
		"status":          status,
		"progress":        progress,
		"result":          result,
		"error":           errorMessage,
		"startedAt":       isoPtr(startedAt),
		"completedAt":     isoPtr(completedAt),
		"createdAt":       iso(payload.CreatedAt),
		"updatedAt":       iso(updatedAt),
	}, nil
}

// ArticleKnowledgeBuild 创建单篇「构建知识」Asynq 任务；重复点击会复用同一运行中任务。
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
		_ = rawBool(raw, "forceRebuild") // 当前构建恒为全量重建，保留请求契约。
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
		info, err := taskqueue.EnqueueKnowledgeBuild(c.Request.Context(), taskqueue.KnowledgeBuildPayload{
			UserID: user.ID, KnowledgeBaseID: kbID, ArticleID: articleID, CreatedAt: time.Now(),
		}, config.Get().KnowledgeBuild.QueueSize)
		if errors.Is(err, taskqueue.ErrQueueFull) {
			return nil, &httpx.HttpError{Status: 429, Message: "知识构建队列已满，请稍后重试"}
		}
		if err != nil {
			slog.Error("知识构建任务入队失败",
				"userId", user.ID,
				"knowledgeBaseId", kbID,
				"articleId", articleID,
				"err", err,
			)
			return nil, &httpx.HttpError{Status: 503, Message: "知识构建队列暂不可用，请稍后重试"}
		}
		return articleKnowledgeBuildJobResponse(info)
	})
}

type knowledgeBuildTaskInfoLookup func(jobID string) (*asynq.TaskInfo, error)

func listArticleKnowledgeBuildJobs(
	userID, knowledgeBaseID int64,
	articleIDs []int64,
	lookup knowledgeBuildTaskInfoLookup,
) ([]map[string]any, error) {
	jobs := make([]map[string]any, 0, len(articleIDs))
	seen := make(map[int64]struct{}, len(articleIDs))
	for _, articleID := range articleIDs {
		if _, duplicate := seen[articleID]; duplicate {
			continue
		}
		seen[articleID] = struct{}{}
		jobID := taskqueue.KnowledgeBuildTaskID(userID, knowledgeBaseID, articleID)
		info, err := lookup(jobID)
		if errors.Is(err, asynq.ErrTaskNotFound) || errors.Is(err, asynq.ErrQueueNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		response, err := articleKnowledgeBuildJobResponse(info)
		if err != nil {
			return nil, err
		}
		if response["userId"] != strconv.FormatInt(userID, 10) ||
			response["knowledgeBaseId"] != strconv.FormatInt(knowledgeBaseID, 10) ||
			response["articleId"] != strconv.FormatInt(articleID, 10) {
			continue
		}
		jobs = append(jobs, response)
	}
	return jobs, nil
}

// ArticleKnowledgeBuildStatusList 按当前可见文章批量恢复 Asynq 中保留的构建状态。
func ArticleKnowledgeBuildStatusList(c *ginContext) {
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
		rawArticleIDs, ok := raw["articleIds"].([]any)
		if !ok || len(rawArticleIDs) == 0 {
			return nil, badReq("articleIds 不能为空")
		}
		if len(rawArticleIDs) > knowledgeBuildStatusListLimit {
			return nil, badReq("articleIds 最多包含 200 项")
		}
		articleIDs := make([]int64, 0, len(rawArticleIDs))
		for _, rawArticleID := range rawArticleIDs {
			articleID, err := reqID(rawArticleID, "文章 ID 必须是正整数")
			if err != nil {
				return nil, err
			}
			articleIDs = append(articleIDs, articleID)
		}
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), pool(), user.ID, kbID); err != nil {
			return nil, err
		}
		jobs, err := listArticleKnowledgeBuildJobs(
			user.ID, kbID, articleIDs, taskqueue.KnowledgeBuildTaskInfo,
		)
		if err != nil {
			slog.Error("批量读取知识构建任务状态失败",
				"userId", user.ID,
				"knowledgeBaseId", kbID,
				"articleCount", len(articleIDs),
				"err", err,
			)
			return nil, &httpx.HttpError{Status: 503, Message: "知识构建队列暂不可用，请稍后重试"}
		}
		return map[string]any{"jobs": jobs}, nil
	})
}

// ArticleKnowledgeBuildStatus 查询 Asynq 中保留的知识构建任务。
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
		info, err := taskqueue.KnowledgeBuildTaskInfo(jobID)
		if errors.Is(err, asynq.ErrTaskNotFound) || errors.Is(err, asynq.ErrQueueNotFound) {
			return nil, notFoundErr("知识构建任务不存在或已过期")
		}
		if err != nil {
			slog.Error("读取知识构建任务状态失败", "jobId", jobID, "userId", user.ID, "err", err)
			return nil, &httpx.HttpError{Status: 503, Message: "知识构建队列暂不可用，请稍后重试"}
		}
		response, err := articleKnowledgeBuildJobResponse(info)
		if err != nil || response["userId"] != strconv.FormatInt(user.ID, 10) {
			return nil, notFoundErr("知识构建任务不存在或已过期")
		}
		return response, nil
	})
}
