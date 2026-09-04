// Package taskqueue 封装 Petrichor 的 Asynq 客户端、任务协议与队列状态。
package taskqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"

	"petrichor/api/internal/config"
)

const (
	QueueKnowledgeBuild = "knowledge_build"
	QueueDocumentImport = "document_import"

	TypeKnowledgeBuild          = "petrichor:knowledge:build"
	TypeDocumentImport          = "petrichor:document-import:run"
	TypeDocumentImportReconcile = "petrichor:document-import:reconcile"

	KnowledgeBuildTimeout   = 30 * time.Minute
	KnowledgeBuildRetention = 24 * time.Hour
	KnowledgeBuildMaxRetry  = 2
	DocumentImportTimeout   = 6 * time.Hour
	DocumentImportRetention = 24 * time.Hour
	DocumentImportMaxRetry  = 4
)

var (
	ErrNotInitialized = errors.New("Asynq 任务队列尚未初始化")
	ErrQueueFull      = errors.New("知识构建队列已满")
)

// KnowledgeBuildPayload 是知识构建任务的稳定协议。
type KnowledgeBuildPayload struct {
	UserID          int64     `json:"userId"`
	KnowledgeBaseID int64     `json:"knowledgeBaseId"`
	ArticleID       int64     `json:"articleId"`
	CreatedAt       time.Time `json:"createdAt"`
}

// DocumentImportPayload 标识一个由 Asynq 调度的视觉导入任务。
type DocumentImportPayload struct {
	JobID int64 `json:"jobId"`
}

// StatusCount 是管理端使用的队列状态聚合。
type StatusCount struct {
	Status string `json:"status"`
	Count  int64  `json:"count"`
}

type queueRuntime struct {
	mu        sync.RWMutex
	redis     *redis.Client
	client    *asynq.Client
	inspector *asynq.Inspector
}

var runtime queueRuntime

// Initialize 使用共享 Redis 配置初始化 Asynq。任务队列不允许进程内降级。
func Initialize(ctx context.Context) error {
	cfg := config.Get().Redis
	if cfg == nil {
		return fmt.Errorf("%w：必须配置 cache.redis.url", ErrNotInitialized)
	}
	options, err := redis.ParseURL(cfg.URL)
	if err != nil {
		return fmt.Errorf("解析 Asynq Redis 配置失败: %w", err)
	}
	options.PoolSize = cfg.PoolSize
	options.MinIdleConns = cfg.MinIdleConns
	options.DialTimeout = cfg.DialTimeout
	options.ReadTimeout = cfg.ReadTimeout
	options.WriteTimeout = cfg.WriteTimeout
	candidate := redis.NewClient(options)
	if err := candidate.Ping(ctx).Err(); err != nil {
		_ = candidate.Close()
		return fmt.Errorf("连接 Asynq Redis 失败: %w", err)
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.redis != nil {
		_ = candidate.Close()
		return errors.New("Asynq 任务队列不能重复初始化")
	}
	runtime.redis = candidate
	runtime.client = asynq.NewClientFromRedisClient(candidate)
	runtime.inspector = asynq.NewInspectorFromRedisClient(candidate)
	return nil
}

// Close 释放任务队列持有的 Redis 连接池。
func Close() error {
	runtime.mu.Lock()
	client := runtime.redis
	runtime.redis = nil
	runtime.client = nil
	runtime.inspector = nil
	runtime.mu.Unlock()
	if client == nil {
		return nil
	}
	return client.Close()
}

// Ping 验证任务队列 Redis 可用性。
func Ping(ctx context.Context) error {
	rdb, _, _, err := dependencies()
	if err != nil {
		return err
	}
	return rdb.Ping(ctx).Err()
}

// NewServer 创建复用任务队列 Redis 连接池的 Asynq Server。
func NewServer(cfg asynq.Config) (*asynq.Server, error) {
	rdb, _, _, err := dependencies()
	if err != nil {
		return nil, err
	}
	return asynq.NewServerFromRedisClient(rdb, cfg), nil
}

// NewScheduler 创建复用任务队列 Redis 连接池的 Asynq Scheduler。
func NewScheduler(opts *asynq.SchedulerOpts) (*asynq.Scheduler, error) {
	rdb, _, _, err := dependencies()
	if err != nil {
		return nil, err
	}
	return asynq.NewSchedulerFromRedisClient(rdb, opts), nil
}

// EnqueueKnowledgeBuild 以文章级稳定 TaskID 使用 Asynq 原生去重。
// 同一用户、知识库和文章的运行中任务会返回相同任务 ID；终态任务可被下一次构建替换。
func EnqueueKnowledgeBuild(ctx context.Context, payload KnowledgeBuildPayload, queueLimit int) (*asynq.TaskInfo, error) {
	_, client, inspector, err := dependencies()
	if err != nil {
		return nil, err
	}
	taskID := knowledgeBuildTaskID(payload)
	for attempt := 0; attempt < 3; attempt++ {
		info, infoErr := inspector.GetTaskInfo(QueueKnowledgeBuild, taskID)
		if infoErr == nil {
			if taskIsActive(info) {
				return info, nil
			}
			if err := inspector.DeleteTask(QueueKnowledgeBuild, taskID); err != nil && !errors.Is(err, asynq.ErrTaskNotFound) {
				return nil, err
			}
		} else if !errors.Is(infoErr, asynq.ErrTaskNotFound) && !errors.Is(infoErr, asynq.ErrQueueNotFound) {
			return nil, infoErr
		}

		if queueLimit > 0 {
			waiting, countErr := waitingTaskCount(inspector, QueueKnowledgeBuild)
			if countErr != nil {
				return nil, countErr
			}
			if waiting >= queueLimit {
				return nil, ErrQueueFull
			}
		}
		task, taskErr := NewKnowledgeBuildTask(payload)
		if taskErr != nil {
			return nil, taskErr
		}
		info, enqueueErr := client.EnqueueContext(ctx, task, asynq.TaskID(taskID))
		if enqueueErr == nil {
			return info, nil
		}
		if !errors.Is(enqueueErr, asynq.ErrTaskIDConflict) {
			return nil, enqueueErr
		}
		if info, infoErr := inspector.GetTaskInfo(QueueKnowledgeBuild, taskID); infoErr == nil && taskIsActive(info) {
			return info, nil
		}
	}
	return nil, errors.New("并发创建知识构建任务失败，请稍后重试")
}

// NewKnowledgeBuildTask 创建知识构建 Asynq 任务。
func NewKnowledgeBuildTask(payload KnowledgeBuildPayload) (*asynq.Task, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TypeKnowledgeBuild, data,
		asynq.Queue(QueueKnowledgeBuild),
		asynq.MaxRetry(KnowledgeBuildMaxRetry),
		asynq.Timeout(KnowledgeBuildTimeout),
		asynq.Retention(KnowledgeBuildRetention),
	), nil
}

// KnowledgeBuildTaskInfo 读取知识构建任务状态与结果。
func KnowledgeBuildTaskInfo(jobID string) (*asynq.TaskInfo, error) {
	_, _, inspector, err := dependencies()
	if err != nil {
		return nil, err
	}
	return inspector.GetTaskInfo(QueueKnowledgeBuild, jobID)
}

// EnqueueDocumentImport 把视觉导入任务交给 Asynq。任务 ID 按 Redis 业务任务稳定去重；
// 已完成或归档的任务会先删除，以支持用户、管理员或 asynqmon 显式重放。
func EnqueueDocumentImport(ctx context.Context, jobID int64) error {
	if jobID <= 0 {
		return errors.New("视觉导入任务 ID 必须是正整数")
	}
	_, client, inspector, err := dependencies()
	if err != nil {
		return err
	}
	taskID := documentImportTaskID(jobID)
	if info, infoErr := inspector.GetTaskInfo(QueueDocumentImport, taskID); infoErr == nil {
		if taskIsActive(info) {
			return nil
		}
		if deleteErr := inspector.DeleteTask(QueueDocumentImport, taskID); deleteErr != nil && !errors.Is(deleteErr, asynq.ErrTaskNotFound) {
			return deleteErr
		}
	} else if !errors.Is(infoErr, asynq.ErrTaskNotFound) && !errors.Is(infoErr, asynq.ErrQueueNotFound) {
		return infoErr
	}
	payload, err := json.Marshal(DocumentImportPayload{JobID: jobID})
	if err != nil {
		return err
	}
	task := asynq.NewTask(TypeDocumentImport, payload,
		asynq.Queue(QueueDocumentImport),
		asynq.MaxRetry(DocumentImportMaxRetry),
		asynq.Timeout(DocumentImportTimeout),
		asynq.Retention(DocumentImportRetention),
	)
	_, err = client.EnqueueContext(ctx, task, asynq.TaskID(taskID))
	if errors.Is(err, asynq.ErrTaskIDConflict) {
		return nil
	}
	return err
}

// RemoveDocumentImportTask 尽力取消执行并删除等待中的视觉导入任务。
func RemoveDocumentImportTask(jobID int64) error {
	if jobID <= 0 {
		return errors.New("视觉导入任务 ID 必须是正整数")
	}
	_, _, inspector, err := dependencies()
	if err != nil {
		return err
	}
	taskID := documentImportTaskID(jobID)
	cancelErr := inspector.CancelProcessing(taskID)
	if cancelErr != nil && !errors.Is(cancelErr, asynq.ErrTaskNotFound) {
		return cancelErr
	}
	deleteErr := inspector.DeleteTask(QueueDocumentImport, taskID)
	if deleteErr != nil && !errors.Is(deleteErr, asynq.ErrTaskNotFound) {
		// 活跃任务不能立即删除；状态仓库中的 canceled/deleted 会让处理器自行退出。
		return nil
	}
	return nil
}

// NewDocumentImportReconcileTask 创建视觉任务补偿扫描任务。
func NewDocumentImportReconcileTask() *asynq.Task {
	return asynq.NewTask(TypeDocumentImportReconcile, []byte("{}"),
		asynq.Queue(QueueDocumentImport),
		asynq.MaxRetry(1),
		asynq.Timeout(5*time.Minute),
	)
}

// DecodeKnowledgeBuildPayload 严格解析知识构建任务负载。
func DecodeKnowledgeBuildPayload(task *asynq.Task) (KnowledgeBuildPayload, error) {
	var payload KnowledgeBuildPayload
	if err := json.Unmarshal(task.Payload(), &payload); err != nil {
		return payload, err
	}
	if payload.UserID <= 0 || payload.KnowledgeBaseID <= 0 || payload.ArticleID <= 0 || payload.CreatedAt.IsZero() {
		return payload, errors.New("知识构建任务负载不完整")
	}
	return payload, nil
}

// DecodeDocumentImportPayload 严格解析视觉导入任务负载。
func DecodeDocumentImportPayload(task *asynq.Task) (DocumentImportPayload, error) {
	var payload DocumentImportPayload
	if err := json.Unmarshal(task.Payload(), &payload); err != nil {
		return payload, err
	}
	if payload.JobID <= 0 {
		return payload, errors.New("视觉导入任务负载不完整")
	}
	return payload, nil
}

// QueueStatusCounts 把 Asynq 原生状态折叠为现有管理端状态契约。
func QueueStatusCounts(queue string) ([]StatusCount, error) {
	_, _, inspector, err := dependencies()
	if err != nil {
		return nil, err
	}
	info, exists, err := queueInfoIfExists(inspector, queue)
	if err != nil {
		return nil, err
	}
	if !exists {
		return []StatusCount{}, nil
	}
	counts := []StatusCount{
		{Status: "pending", Count: int64(info.Pending + info.Scheduled + info.Retry + info.Aggregating)},
		{Status: "processing", Count: int64(info.Active)},
		{Status: "completed", Count: int64(info.Completed)},
		{Status: "failed", Count: int64(info.Archived)},
	}
	out := counts[:0]
	for _, item := range counts {
		if item.Count > 0 {
			out = append(out, item)
		}
	}
	return out, nil
}

func dependencies() (*redis.Client, *asynq.Client, *asynq.Inspector, error) {
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	if runtime.redis == nil || runtime.client == nil || runtime.inspector == nil {
		return nil, nil, nil, ErrNotInitialized
	}
	return runtime.redis, runtime.client, runtime.inspector, nil
}

func waitingTaskCount(inspector *asynq.Inspector, queue string) (int, error) {
	info, exists, err := queueInfoIfExists(inspector, queue)
	if err != nil {
		return 0, err
	}
	if !exists {
		return 0, nil
	}
	return info.Pending + info.Scheduled + info.Retry + info.Aggregating, nil
}

// queueInfoIfExists 先用 Queues 判断队列是否存在。Asynq v0.26 的
// GetQueueInfo 会直接透传内部 NOT_FOUND 错误，无法用公开 ErrQueueNotFound 判定。
func queueInfoIfExists(inspector *asynq.Inspector, queue string) (*asynq.QueueInfo, bool, error) {
	queues, err := inspector.Queues()
	if err != nil {
		return nil, false, err
	}
	if !containsQueue(queues, queue) {
		return nil, false, nil
	}
	info, err := inspector.GetQueueInfo(queue)
	if err == nil {
		return info, true, nil
	}
	// 队列可能在 Queues 与 GetQueueInfo 两次读取之间被删除。
	queues, listErr := inspector.Queues()
	if listErr == nil && !containsQueue(queues, queue) {
		return nil, false, nil
	}
	return nil, true, err
}

func containsQueue(queues []string, target string) bool {
	for _, queue := range queues {
		if queue == target {
			return true
		}
	}
	return false
}

func taskIsActive(info *asynq.TaskInfo) bool {
	return info.State != asynq.TaskStateCompleted && info.State != asynq.TaskStateArchived
}

// KnowledgeBuildTaskID 返回文章构建任务的稳定 ID，供 API 在页面刷新后按文章恢复状态。
func KnowledgeBuildTaskID(userID, knowledgeBaseID, articleID int64) string {
	return "knowledge-build-" +
		strconv.FormatInt(userID, 10) + "-" +
		strconv.FormatInt(knowledgeBaseID, 10) + "-" +
		strconv.FormatInt(articleID, 10)
}

func knowledgeBuildTaskID(payload KnowledgeBuildPayload) string {
	return KnowledgeBuildTaskID(payload.UserID, payload.KnowledgeBaseID, payload.ArticleID)
}

func documentImportTaskID(jobID int64) string {
	return "document-import-" + strconv.FormatInt(jobID, 10)
}
