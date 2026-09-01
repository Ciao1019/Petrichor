// wiki-build-job.go 管理「构建知识」的 Go 进程内队列、状态轮询与并发执行。
// 中间状态不写数据库；真正需要长期保存的知识结果由 wiki-build.go 事务落库。
package kb

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"

	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
)

const (
	knowledgeBuildJobTTL     = time.Hour
	knowledgeBuildJobTimeout = 15 * time.Minute
)

type articleKnowledgeBuildJob struct {
	ID              string
	UserID          int64
	KnowledgeBaseID int64
	ArticleID       int64
	Status          string
	Result          map[string]any
	Error           *string
	StartedAt       *time.Time
	CompletedAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type articleKnowledgeBuildKey struct {
	userID          int64
	knowledgeBaseID int64
	articleID       int64
}

type articleKnowledgeBuildExecutor func(
	ctx context.Context,
	userID int64,
	knowledgeBaseID int64,
	articleID int64,
) (map[string]any, error)

type articleKnowledgeBuildScheduler struct {
	mu          sync.Mutex
	jobs        map[string]*articleKnowledgeBuildJob
	active      map[articleKnowledgeBuildKey]string
	queue       chan string
	executor    articleKnowledgeBuildExecutor
	concurrency int
	running     bool
	runCtx      context.Context
	workers     sync.WaitGroup
}

func newArticleKnowledgeBuildScheduler(
	concurrency int,
	queueSize int,
	executor articleKnowledgeBuildExecutor,
) *articleKnowledgeBuildScheduler {
	if concurrency < 1 {
		concurrency = 1
	}
	if queueSize < concurrency {
		queueSize = concurrency
	}
	return &articleKnowledgeBuildScheduler{
		jobs:        make(map[string]*articleKnowledgeBuildJob),
		active:      make(map[articleKnowledgeBuildKey]string),
		queue:       make(chan string, queueSize),
		executor:    executor,
		concurrency: concurrency,
	}
}

var (
	questionBatchConcurrency  = config.DefaultKnowledgeBuildQuestionBatchConcurrency
	wikiPageBatchConcurrency  = config.DefaultKnowledgeBuildPageBatchConcurrency
	knowledgeBuildModelSlots  = make(chan struct{}, config.DefaultKnowledgeBuildModelConcurrency)
	articleKnowledgeBuildJobs = newArticleKnowledgeBuildScheduler(
		config.DefaultKnowledgeBuildConcurrency,
		config.DefaultKnowledgeBuildQueueSize,
		executeArticleKnowledgeBuild,
	)
)

func executeArticleKnowledgeBuild(ctx context.Context, userID, knowledgeBaseID, articleID int64) (map[string]any, error) {
	return buildArticleKnowledgeCore(ctx, pool(), userID, knowledgeBaseID, articleID)
}

// invokeKnowledgeBuildChat 使用全局信号量在文章之间共享模型并发额度，避免嵌套任务池乘法失控。
func invokeKnowledgeBuildChat(ctx context.Context, request ChatRequest) (string, error) {
	if err := requireChat(); err != nil {
		return "", err
	}
	select {
	case knowledgeBuildModelSlots <- struct{}{}:
		defer func() { <-knowledgeBuildModelSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	return ChatInvoker(ctx, request)
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
		"startedAt":       isoPtr(job.StartedAt),
		"completedAt":     isoPtr(job.CompletedAt),
		"createdAt":       iso(job.CreatedAt),
		"updatedAt":       iso(job.UpdatedAt),
	}
}

// StartArticleKnowledgeBuildScheduler 按配置启动固定数量的 Go worker goroutine。
// Compose 只运行一个 API 实例，因此任务状态和队列都留在该进程内。
func StartArticleKnowledgeBuildScheduler(parent context.Context, settings config.KnowledgeBuildConfig) func() {
	questionBatchConcurrency = settings.QuestionBatchConcurrency
	wikiPageBatchConcurrency = settings.PageBatchConcurrency
	knowledgeBuildModelSlots = make(chan struct{}, settings.ModelConcurrency)
	articleKnowledgeBuildJobs = newArticleKnowledgeBuildScheduler(
		settings.Concurrency,
		settings.QueueSize,
		executeArticleKnowledgeBuild,
	)
	slog.Info("知识构建并发配置已加载",
		"articleConcurrency", settings.Concurrency,
		"questionBatchConcurrency", settings.QuestionBatchConcurrency,
		"pageBatchConcurrency", settings.PageBatchConcurrency,
		"modelConcurrency", settings.ModelConcurrency,
	)
	return articleKnowledgeBuildJobs.start(parent)
}

func (scheduler *articleKnowledgeBuildScheduler) start(parent context.Context) func() {
	scheduler.mu.Lock()
	if scheduler.running {
		scheduler.mu.Unlock()
		panic("知识构建调度器不能重复启动")
	}
	runCtx, cancel := context.WithCancel(parent)
	scheduler.running = true
	scheduler.runCtx = runCtx
	for slot := 0; slot < scheduler.concurrency; slot++ {
		scheduler.workers.Add(1)
		go scheduler.runWorker(runCtx, slot)
	}
	scheduler.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			scheduler.workers.Wait()
			scheduler.mu.Lock()
			scheduler.running = false
			scheduler.runCtx = nil
			scheduler.mu.Unlock()
		})
	}
}

func (scheduler *articleKnowledgeBuildScheduler) runWorker(ctx context.Context, slot int) {
	defer scheduler.workers.Done()
	slog.Info("知识构建内存 Worker 已启动", "slot", slot)
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case jobID := <-scheduler.queue:
			if ctx.Err() != nil {
				return
			}
			scheduler.execute(ctx, jobID)
		}
	}
}

func (scheduler *articleKnowledgeBuildScheduler) create(
	userID int64,
	knowledgeBaseID int64,
	articleID int64,
) (map[string]any, error) {
	now := time.Now()
	key := articleKnowledgeBuildKey{userID: userID, knowledgeBaseID: knowledgeBaseID, articleID: articleID}

	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	scheduler.cleanupLocked(now)
	if !scheduler.running || scheduler.runCtx == nil || scheduler.runCtx.Err() != nil {
		return nil, &httpx.HttpError{Status: 503, Message: "知识构建服务尚未就绪"}
	}
	if activeID := scheduler.active[key]; activeID != "" {
		if active := scheduler.jobs[activeID]; active != nil &&
			(active.Status == "pending" || active.Status == "processing") {
			return articleKnowledgeBuildJobResponse(active), nil
		}
		delete(scheduler.active, key)
	}

	var jobID string
	for attempt := 0; attempt < 3; attempt++ {
		candidate, err := generateCode()
		if err != nil {
			return nil, err
		}
		if scheduler.jobs[candidate] == nil {
			jobID = candidate
			break
		}
	}
	if jobID == "" {
		return nil, errors.New("生成知识构建任务 ID 失败")
	}
	job := &articleKnowledgeBuildJob{
		ID:              jobID,
		UserID:          userID,
		KnowledgeBaseID: knowledgeBaseID,
		ArticleID:       articleID,
		Status:          "pending",
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	scheduler.jobs[jobID] = job
	scheduler.active[key] = jobID
	select {
	case scheduler.queue <- jobID:
		return articleKnowledgeBuildJobResponse(job), nil
	default:
		delete(scheduler.jobs, jobID)
		delete(scheduler.active, key)
		return nil, &httpx.HttpError{Status: 429, Message: "知识构建队列已满，请稍后重试"}
	}
}

func (scheduler *articleKnowledgeBuildScheduler) loadOwned(userID int64, jobID string) map[string]any {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	scheduler.cleanupLocked(time.Now())
	job := scheduler.jobs[jobID]
	if job == nil || job.UserID != userID {
		return nil
	}
	return articleKnowledgeBuildJobResponse(job)
}

func (scheduler *articleKnowledgeBuildScheduler) setProcessing(jobID string) *articleKnowledgeBuildJob {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	job := scheduler.jobs[jobID]
	if job == nil || job.Status != "pending" {
		return nil
	}
	now := time.Now()
	job.Status = "processing"
	job.StartedAt = &now
	job.UpdatedAt = now
	copy := *job
	return &copy
}

func (scheduler *articleKnowledgeBuildScheduler) finish(jobID string, result map[string]any, buildErr error) {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	job := scheduler.jobs[jobID]
	if job == nil || job.Status != "processing" {
		return
	}
	now := time.Now()
	job.UpdatedAt = now
	job.CompletedAt = &now
	if buildErr == nil {
		job.Status = "completed"
		job.Result = result
		job.Error = nil
	} else {
		message := "知识构建失败，请稍后重试"
		var httpErr *httpx.HttpError
		if errors.As(buildErr, &httpErr) {
			message = httpErr.Message
		} else if errors.Is(buildErr, context.Canceled) || errors.Is(buildErr, context.DeadlineExceeded) {
			message = "知识构建执行超时或中断"
		}
		message = truncateRunes(message, 500)
		job.Status = "failed"
		job.Result = nil
		job.Error = &message
	}
	key := articleKnowledgeBuildKey{
		userID: job.UserID, knowledgeBaseID: job.KnowledgeBaseID, articleID: job.ArticleID,
	}
	if scheduler.active[key] == jobID {
		delete(scheduler.active, key)
	}
}

func (scheduler *articleKnowledgeBuildScheduler) cleanupLocked(now time.Time) {
	for jobID, job := range scheduler.jobs {
		if job.Status != "completed" && job.Status != "failed" {
			continue
		}
		if now.Sub(job.UpdatedAt) <= knowledgeBuildJobTTL {
			continue
		}
		delete(scheduler.jobs, jobID)
	}
}

func (scheduler *articleKnowledgeBuildScheduler) execute(parent context.Context, jobID string) {
	job := scheduler.setProcessing(jobID)
	if job == nil {
		return
	}
	startedAt := time.Now()
	ctx, cancel := context.WithTimeout(parent, knowledgeBuildJobTimeout)
	defer cancel()
	defer func() {
		if recovered := recover(); recovered != nil {
			buildErr := fmt.Errorf("知识构建发生 panic: %v", recovered)
			slog.Error("后台知识构建异常", "jobId", job.ID, "err", buildErr)
			scheduler.finish(job.ID, nil, buildErr)
		}
	}()

	result, buildErr := scheduler.executor(ctx, job.UserID, job.KnowledgeBaseID, job.ArticleID)
	if buildErr != nil {
		slog.Error("后台知识构建失败",
			"jobId", job.ID,
			"userId", job.UserID,
			"knowledgeBaseId", job.KnowledgeBaseID,
			"articleId", job.ArticleID,
			"err", buildErr,
		)
	}
	scheduler.finish(job.ID, result, buildErr)
	slog.Info("知识构建任务结束",
		"jobId", job.ID,
		"status", func() string {
			if buildErr == nil {
				return "completed"
			}
			return "failed"
		}(),
		"durationMs", time.Since(startedAt).Milliseconds(),
	)
}

// ArticleKnowledgeBuildStatusCount 是管理端运行指标中的内存任务计数。
type ArticleKnowledgeBuildStatusCount struct {
	Status string `json:"status"`
	Count  int64  `json:"count"`
}

// ArticleKnowledgeBuildStatusCounts 返回当前 API 进程内尚未过期的任务状态统计。
func ArticleKnowledgeBuildStatusCounts() []ArticleKnowledgeBuildStatusCount {
	articleKnowledgeBuildJobs.mu.Lock()
	defer articleKnowledgeBuildJobs.mu.Unlock()
	articleKnowledgeBuildJobs.cleanupLocked(time.Now())
	counts := make(map[string]int64)
	for _, job := range articleKnowledgeBuildJobs.jobs {
		counts[job.Status]++
	}
	statuses := make([]string, 0, len(counts))
	for status := range counts {
		statuses = append(statuses, status)
	}
	sort.Strings(statuses)
	out := make([]ArticleKnowledgeBuildStatusCount, 0, len(statuses))
	for _, status := range statuses {
		out = append(out, ArticleKnowledgeBuildStatusCount{Status: status, Count: counts[status]})
	}
	return out
}

// ArticleKnowledgeBuild 创建单篇「构建知识」内存任务；重复点击会复用同一运行中任务。
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
		return articleKnowledgeBuildJobs.create(user.ID, kbID, articleID)
	})
}

// ArticleKnowledgeBuildStatus 查询当前 API 进程中的知识构建任务。
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
		response := articleKnowledgeBuildJobs.loadOwned(user.ID, jobID)
		if response == nil {
			return nil, notFoundErr("知识构建任务不存在、已过期或 API 已重启")
		}
		return response, nil
	})
}
