package taskqueue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	documentImportPrefix       = "petrichor:document-import:v1:"
	documentImportMaxWatchTry  = 8
	documentImportDefaultTries = 5
)

var (
	ErrDocumentImportNotFound = errors.New("视觉导入任务不存在")
	ErrDocumentImportLockBusy = errors.New("视觉导入任务正在被其他 Worker 处理")
)

// DocumentImportJob 是完全保存在 Redis 中的视觉导入业务状态。
type DocumentImportJob struct {
	ID                   int64      `json:"id"`
	UserID               int64      `json:"userId"`
	KnowledgeBaseID      int64      `json:"knowledgeBaseId"`
	ParentNodeID         *int64     `json:"parentNodeId,omitempty"`
	SourceType           string     `json:"sourceType"`
	ImagePolicy          string     `json:"imagePolicy"`
	PageUnit             string     `json:"pageUnit"`
	FileName             string     `json:"fileName"`
	SourceKey            *string    `json:"sourceKey,omitempty"`
	Title                string     `json:"title"`
	TotalPages           int32      `json:"totalPages"`
	ProcessedPages       int32      `json:"processedPages"`
	Status               string     `json:"status"`
	Stage                string     `json:"stage"`
	Concurrency          int32      `json:"concurrency"`
	IdempotencyKey       string     `json:"idempotencyKey,omitempty"`
	Fingerprint          string     `json:"fingerprint,omitempty"`
	PrepareToken         string     `json:"prepareToken,omitempty"`
	PrepareAttempt       int32      `json:"prepareAttempt"`
	PrepareMaxAttempts   int32      `json:"prepareMaxAttempts"`
	PrepareLeaseUntil    time.Time  `json:"prepareLeaseUntil"`
	PrepareNextAttemptAt time.Time  `json:"prepareNextAttemptAt"`
	PrepareLastError     *string    `json:"prepareLastError,omitempty"`
	ModelConfigID        *int64     `json:"modelConfigId,omitempty"`
	PendingArticleID     *int64     `json:"pendingArticleId,omitempty"`
	ArticleID            *int64     `json:"articleId,omitempty"`
	Error                *string    `json:"error,omitempty"`
	DeadLetteredAt       *time.Time `json:"deadLetteredAt,omitempty"`
	ReplayCount          int32      `json:"replayCount"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

// DocumentImportPage 是完全保存在 Redis Hash 中的页级进度与转写结果。
type DocumentImportPage struct {
	ID             int64                 `json:"id"`
	JobID          int64                 `json:"jobId"`
	PageNo         int32                 `json:"pageNo"`
	ImageKey       *string               `json:"imageKey,omitempty"`
	BaseMarkdown   *string               `json:"baseMarkdown,omitempty"`
	Assets         []DocumentImportAsset `json:"assets,omitempty"`
	ExtractedBy    string                `json:"extractedBy"`
	Status         string                `json:"status"`
	Markdown       *string               `json:"markdown,omitempty"`
	Error          *string               `json:"error,omitempty"`
	AttemptCount   int32                 `json:"attemptCount"`
	MaxAttempts    int32                 `json:"maxAttempts"`
	NextAttemptAt  time.Time             `json:"nextAttemptAt"`
	LastError      *string               `json:"lastError,omitempty"`
	DeadLetteredAt *time.Time            `json:"deadLetteredAt,omitempty"`
	CreatedAt      time.Time             `json:"createdAt"`
	UpdatedAt      time.Time             `json:"updatedAt"`
}

// DocumentImportStore 提供视觉导入状态的 Redis 访问入口。
type DocumentImportStore struct {
	redis *redis.Client
}

// DocumentImports 返回共享 Asynq Redis 上的视觉导入状态仓库。
func DocumentImports() (*DocumentImportStore, error) {
	rdb, _, _, err := dependencies()
	if err != nil {
		return nil, err
	}
	return &DocumentImportStore{redis: rdb}, nil
}

func (s *DocumentImportStore) Create(ctx context.Context, job DocumentImportJob, pages ...DocumentImportPage) (*DocumentImportJob, error) {
	if !ValidDocumentImagePolicy(job.ImagePolicy) {
		return nil, errors.New("无效的图片处理策略")
	}
	job.ImagePolicy = EffectiveDocumentImagePolicy(job.ImagePolicy)
	if len(pages) > 0 {
		if err := validateDocumentImportPages(pages); err != nil {
			return nil, err
		}
		job.TotalPages = int32(len(pages))
		job.ProcessedPages = 0
		for _, page := range pages {
			if page.Status == "done" {
				job.ProcessedPages++
			}
		}
	}
	if job.UserID <= 0 || job.KnowledgeBaseID <= 0 || job.FileName == "" || job.Title == "" {
		return nil, errors.New("视觉导入任务字段不完整")
	}
	base := time.Now().UnixMilli() * 1000
	if err := s.redis.SetNX(ctx, documentImportSequenceKey(), base, 0).Err(); err != nil {
		return nil, err
	}
	id, err := s.redis.Incr(ctx, documentImportSequenceKey()).Result()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	job.ID = id
	if job.SourceType == "" {
		job.SourceType = "pdf"
	}
	job.PageUnit = "document"
	if job.SourceType == "pdf" {
		job.PageUnit = "page"
	}
	if job.Status == "" {
		job.Status = "processing"
	}
	job.CreatedAt = now
	job.UpdatedAt = now
	normalizeDocumentImportStage(&job)
	if job.Stage == "preparing" || job.IdempotencyKey != "" {
		if job.Stage != "preparing" || len(pages) != 0 || job.TotalPages != 0 || !ValidDocumentImportIdempotencyKey(job.IdempotencyKey) || job.SourceKey == nil || *job.SourceKey == "" {
			return nil, errors.New("准备任务必须为空页并提供原件和 UUID 幂等键")
		}
		job.Fingerprint = documentImportFingerprint(&job)
	}
	data, err := json.Marshal(job)
	if err != nil {
		return nil, err
	}
	fields, err := documentImportPageFields(id, pages, now)
	if err != nil {
		return nil, err
	}
	return s.persistDocumentImport(ctx, &job, pages, fields, data)
}

func (s *DocumentImportStore) Get(ctx context.Context, jobID int64) (*DocumentImportJob, error) {
	raw, err := s.redis.Get(ctx, documentImportJobKey(jobID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrDocumentImportNotFound
	}
	if err != nil {
		return nil, err
	}
	job, err := decodeDocumentImportJob(raw)
	if err == nil {
		captureDocumentImportExecution(ctx, job)
	}
	return job, err
}

func (s *DocumentImportStore) GetOwned(ctx context.Context, userID, jobID int64) (*DocumentImportJob, error) {
	job, err := s.Get(ctx, jobID)
	if err != nil {
		return nil, err
	}
	if job.UserID != userID {
		return nil, ErrDocumentImportNotFound
	}
	return job, nil
}

// UpdateJob 使用 WATCH 保证多个 API/Worker 实例不会覆盖彼此的任务更新。
func (s *DocumentImportStore) UpdateJob(ctx context.Context, jobID int64,
	mutate func(*DocumentImportJob) error,
) (*DocumentImportJob, error) {
	key := documentImportJobKey(jobID)
	var updated *DocumentImportJob
	err := retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			raw, err := tx.Get(ctx, key).Bytes()
			if errors.Is(err, redis.Nil) {
				return ErrDocumentImportNotFound
			}
			if err != nil {
				return err
			}
			job, err := decodeDocumentImportJob(raw)
			if err != nil {
				return err
			}
			previous := *job
			previousStatus := job.Status
			if err := mutate(job); err != nil {
				return err
			}
			if !frozenDocumentImportUnchanged(&previous, job) {
				return ErrDocumentImportIdempotencyConflict
			}
			normalizeDocumentImportStage(job)
			if (documentImportSealed(&previous) && job.Status != previousStatus) ||
				(previousStatus == "canceled" && job.ArticleID != nil) ||
				(previous.ArticleID != nil && (job.ArticleID == nil || *job.ArticleID != *previous.ArticleID)) ||
				(documentImportTerminal(previousStatus) && job.Status != previousStatus && job.Status != "canceled" && job.Status != "completed") {
				return ErrDocumentImportEnded
			}
			job.UpdatedAt = time.Now().UTC()
			data, err := json.Marshal(job)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Set(ctx, key, data, 0)
				if previousStatus != job.Status {
					pipe.ZRem(ctx, documentImportStatusKey(previousStatus), jobID)
					pipe.ZAdd(ctx, documentImportStatusKey(job.Status), redis.Z{
						Score: float64(job.UpdatedAt.UnixMilli()), Member: jobID,
					})
				}
				if documentImportTerminal(job.Status) {
					pipe.ZRem(ctx, documentImportRunnableKey(), jobID)
				}
				return nil
			})
			if err == nil {
				updated = cloneDocumentImportJob(job)
			}
			return err
		}, key)
	})
	return updated, err
}

func (s *DocumentImportStore) List(ctx context.Context, userID int64, knowledgeBaseID *int64,
	offset, limit int64,
) ([]DocumentImportJob, int64, error) {
	key := documentImportUserKey(userID)
	if knowledgeBaseID != nil {
		key = documentImportUserKBKey(userID, *knowledgeBaseID)
	}
	total, err := s.redis.ZCard(ctx, key).Result()
	if err != nil {
		return nil, 0, err
	}
	if limit <= 0 || offset >= total {
		return []DocumentImportJob{}, total, nil
	}
	ids, err := s.redis.ZRevRange(ctx, key, offset, offset+limit-1).Result()
	if err != nil {
		return nil, 0, err
	}
	jobs, err := s.loadJobIDs(ctx, ids)
	return jobs, total, err
}

func (s *DocumentImportStore) ListByStatus(ctx context.Context, status string, limit int64) ([]DocumentImportJob, error) {
	if limit <= 0 {
		return []DocumentImportJob{}, nil
	}
	ids, err := s.redis.ZRevRange(ctx, documentImportStatusKey(status), 0, limit-1).Result()
	if err != nil {
		return nil, err
	}
	return s.loadJobIDs(ctx, ids)
}

func (s *DocumentImportStore) StatusCounts(ctx context.Context) ([]StatusCount, error) {
	statuses := []string{"pending", "processing", "completed", "failed", "dead_letter", "canceled"}
	pipe := s.redis.Pipeline()
	commands := make([]*redis.IntCmd, 0, len(statuses))
	for _, status := range statuses {
		commands = append(commands, pipe.ZCard(ctx, documentImportStatusKey(status)))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	result := make([]StatusCount, 0, len(statuses))
	for i, command := range commands {
		if command.Val() > 0 {
			result = append(result, StatusCount{Status: statuses[i], Count: command.Val()})
		}
	}
	return result, nil
}

func (s *DocumentImportStore) UserStatusCounts(ctx context.Context, userID int64) ([]StatusCount, error) {
	ids, err := s.redis.ZRange(ctx, documentImportUserKey(userID), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	jobs, err := s.loadJobIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	counts := map[string]int64{}
	for i := range jobs {
		counts[jobs[i].Status]++
	}
	statuses := []string{"pending", "processing", "completed", "failed", "dead_letter", "canceled"}
	result := make([]StatusCount, 0, len(statuses))
	for _, status := range statuses {
		if counts[status] > 0 {
			result = append(result, StatusCount{Status: status, Count: counts[status]})
		}
	}
	return result, nil
}

func (s *DocumentImportStore) DeleteUser(ctx context.Context, userID int64) ([]int64, error) {
	values, err := s.redis.ZRange(ctx, documentImportUserKey(userID), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(values))
	for _, value := range values {
		id, err := strconv.ParseInt(value, 10, 64)
		if err == nil && id > 0 {
			ids = append(ids, id)
		}
	}
	return s.DeleteOwned(ctx, userID, ids)
}

func (s *DocumentImportStore) DeleteKnowledgeBase(ctx context.Context, userID, knowledgeBaseID int64) ([]int64, error) {
	values, err := s.redis.ZRange(ctx, documentImportUserKBKey(userID, knowledgeBaseID), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(values))
	for _, value := range values {
		id, err := strconv.ParseInt(value, 10, 64)
		if err == nil && id > 0 {
			ids = append(ids, id)
		}
	}
	return s.DeleteOwned(ctx, userID, ids)
}

func (s *DocumentImportStore) DeleteOwned(ctx context.Context, userID int64, ids []int64) ([]int64, error) {
	deleted := make([]int64, 0, len(ids))
	for _, id := range ids {
		removed, err := s.deleteOwnedJob(ctx, userID, id)
		if err != nil {
			return deleted, err
		}
		if removed {
			deleted = append(deleted, id)
		}
	}
	return deleted, nil
}

// SavePages 仅初始化历史空任务；页集合、总页数与 runnable 索引同一事务提交。
func (s *DocumentImportStore) SavePages(ctx context.Context, jobID int64, pages []DocumentImportPage) error {
	if err := validateDocumentImportPages(pages); err != nil {
		return err
	}
	jobKey, pagesKey := documentImportJobKey(jobID), documentImportPagesKey(jobID)
	return retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			raw, err := tx.Get(ctx, jobKey).Bytes()
			if errors.Is(err, redis.Nil) {
				return ErrDocumentImportNotFound
			}
			if err != nil {
				return err
			}
			job, err := decodeDocumentImportJob(raw)
			if err != nil {
				return err
			}
			count, err := tx.HLen(ctx, pagesKey).Result()
			if err != nil {
				return err
			}
			if count != 0 || DocumentImportNeedsPreparation(job) || documentImportTerminal(job.Status) || job.ArticleID != nil {
				return errors.New("不能覆盖已初始化或结束的导入任务")
			}
			now := time.Now().UTC()
			fields, err := documentImportPageFields(jobID, pages, now)
			if err != nil {
				return err
			}
			job.TotalPages, job.ProcessedPages, job.UpdatedAt = int32(len(pages)), 0, now
			for _, page := range pages {
				if page.Status == "done" {
					job.ProcessedPages++
				}
			}
			data, err := json.Marshal(job)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Set(ctx, jobKey, data, 0)
				pipe.HSet(ctx, pagesKey, fields...)
				if DocumentImportRunnable(job, pages) {
					pipe.ZAdd(ctx, documentImportRunnableKey(), redis.Z{Score: float64(now.UnixMilli()), Member: jobID})
				} else {
					pipe.ZRem(ctx, documentImportRunnableKey(), jobID)
				}
				return nil
			})
			return err
		}, jobKey, pagesKey)
	})
}

func (s *DocumentImportStore) Pages(ctx context.Context, jobID int64) ([]DocumentImportPage, error) {
	values, err := s.redis.HGetAll(ctx, documentImportPagesKey(jobID)).Result()
	if err != nil {
		return nil, err
	}
	pages := make([]DocumentImportPage, 0, len(values))
	for _, raw := range values {
		page, err := decodeDocumentImportPage([]byte(raw))
		if err != nil {
			return nil, err
		}
		pages = append(pages, *page)
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].PageNo < pages[j].PageNo })
	return pages, nil
}

func (s *DocumentImportStore) Page(ctx context.Context, jobID, pageNo int64) (*DocumentImportPage, error) {
	raw, err := s.redis.HGet(ctx, documentImportPagesKey(jobID), strconv.FormatInt(pageNo, 10)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrDocumentImportNotFound
	}
	if err != nil {
		return nil, err
	}
	return decodeDocumentImportPage(raw)
}

// SetRunnable 的调用方快照可能已经过期；索引始终按 WATCH 内当前任务和页集校准。
func (s *DocumentImportStore) SetRunnable(ctx context.Context, jobID int64, _ bool) error {
	return s.refreshRunnable(ctx, jobID)
}

func (s *DocumentImportStore) RunnableJobIDs(ctx context.Context) ([]int64, error) {
	values, err := s.redis.ZRange(ctx, documentImportRunnableKey(), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(values))
	for _, value := range values {
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// AcquireJobLock 为最终成文等跨 Redis/PostgreSQL 操作提供分布式互斥。
func (s *DocumentImportStore) AcquireJobLock(ctx context.Context, jobID int64, ttl time.Duration) (func(context.Context) error, error) {
	var tokenBytes [16]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(tokenBytes[:])
	key := documentImportLockKey(jobID)
	acquired, err := s.redis.SetNX(ctx, key, token, ttl).Result()
	if err != nil {
		return nil, err
	}
	if !acquired {
		return nil, ErrDocumentImportLockBusy
	}
	return func(releaseCtx context.Context) error {
		const compareAndDelete = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`
		return s.redis.Eval(releaseCtx, compareAndDelete, []string{key}, token).Err()
	}, nil
}

func (s *DocumentImportStore) loadJobIDs(ctx context.Context, ids []string) ([]DocumentImportJob, error) {
	if len(ids) == 0 {
		return []DocumentImportJob{}, nil
	}
	keys := make([]string, 0, len(ids))
	for _, id := range ids {
		keys = append(keys, documentImportJobKeyString(id))
	}
	values, err := s.redis.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	jobs := make([]DocumentImportJob, 0, len(values))
	for _, value := range values {
		if value == nil {
			continue
		}
		var raw []byte
		switch typed := value.(type) {
		case string:
			raw = []byte(typed)
		case []byte:
			raw = typed
		default:
			return nil, fmt.Errorf("视觉导入任务数据类型异常")
		}
		job, err := decodeDocumentImportJob(raw)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, *job)
	}
	return jobs, nil
}

func retryDocumentImportWatch(ctx context.Context, run func() error) error {
	for attempt := 0; attempt < documentImportMaxWatchTry; attempt++ {
		err := run()
		if !errors.Is(err, redis.TxFailedErr) {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	return errors.New("视觉导入状态并发更新冲突")
}

func decodeDocumentImportJob(raw []byte) (*DocumentImportJob, error) {
	var job DocumentImportJob
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, fmt.Errorf("解析视觉导入任务失败: %w", err)
	}
	if job.ID <= 0 || job.UserID <= 0 || job.KnowledgeBaseID <= 0 {
		return nil, errors.New("视觉导入任务数据不完整")
	}
	if job.SourceType == "" {
		job.SourceType = "pdf"
	}
	if job.PageUnit == "" {
		job.PageUnit = "document"
		if job.SourceType == "pdf" {
			job.PageUnit = "page"
		}
	}
	normalizeDocumentImportStage(&job)
	return &job, nil
}

func decodeDocumentImportPage(raw []byte) (*DocumentImportPage, error) {
	var page DocumentImportPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, fmt.Errorf("解析视觉导入页失败: %w", err)
	}
	if page.JobID <= 0 || page.PageNo <= 0 {
		return nil, errors.New("视觉导入页数据不完整")
	}
	normalizeDocumentImportPage(&page)
	return &page, nil
}

func cloneDocumentImportJob(job *DocumentImportJob) *DocumentImportJob {
	cloned := *job
	return &cloned
}

func documentImportTerminal(status string) bool {
	switch status {
	case "completed", "failed", "dead_letter", "canceled":
		return true
	default:
		return false
	}
}

func documentImportSequenceKey() string { return documentImportPrefix + "sequence" }
func documentImportJobKey(id int64) string {
	return documentImportJobKeyString(strconv.FormatInt(id, 10))
}
func documentImportJobKeyString(id string) string { return documentImportPrefix + "job:" + id }
func documentImportPagesKey(id int64) string {
	return documentImportPrefix + "pages:" + strconv.FormatInt(id, 10)
}
func documentImportUserKey(userID int64) string {
	return documentImportPrefix + "user:" + strconv.FormatInt(userID, 10)
}
func documentImportUserKBKey(userID, knowledgeBaseID int64) string {
	return documentImportPrefix + "user-kb:" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(knowledgeBaseID, 10)
}
func documentImportStatusKey(status string) string { return documentImportPrefix + "status:" + status }
func documentImportRunnableKey() string            { return documentImportPrefix + "runnable" }
func documentImportLockKey(id int64) string {
	return documentImportPrefix + "lock:" + strconv.FormatInt(id, 10)
}
