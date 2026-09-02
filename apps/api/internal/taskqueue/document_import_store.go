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
	ID               int64      `json:"id"`
	UserID           int64      `json:"userId"`
	KnowledgeBaseID  int64      `json:"knowledgeBaseId"`
	ParentNodeID     *int64     `json:"parentNodeId,omitempty"`
	SourceType       string     `json:"sourceType"`
	FileName         string     `json:"fileName"`
	SourceKey        *string    `json:"sourceKey,omitempty"`
	Title            string     `json:"title"`
	TotalPages       int32      `json:"totalPages"`
	ProcessedPages   int32      `json:"processedPages"`
	Status           string     `json:"status"`
	ModelConfigID    *int64     `json:"modelConfigId,omitempty"`
	PendingArticleID *int64     `json:"pendingArticleId,omitempty"`
	ArticleID        *int64     `json:"articleId,omitempty"`
	Error            *string    `json:"error,omitempty"`
	DeadLetteredAt   *time.Time `json:"deadLetteredAt,omitempty"`
	ReplayCount      int32      `json:"replayCount"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}

// DocumentImportPage 是完全保存在 Redis Hash 中的页级进度与转写结果。
type DocumentImportPage struct {
	ID             int64      `json:"id"`
	JobID          int64      `json:"jobId"`
	PageNo         int32      `json:"pageNo"`
	ImageKey       *string    `json:"imageKey,omitempty"`
	ExtractedBy    string     `json:"extractedBy"`
	Status         string     `json:"status"`
	Markdown       *string    `json:"markdown,omitempty"`
	Error          *string    `json:"error,omitempty"`
	AttemptCount   int32      `json:"attemptCount"`
	MaxAttempts    int32      `json:"maxAttempts"`
	NextAttemptAt  time.Time  `json:"nextAttemptAt"`
	LastError      *string    `json:"lastError,omitempty"`
	DeadLetteredAt *time.Time `json:"deadLetteredAt,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
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

func (s *DocumentImportStore) Create(ctx context.Context, job DocumentImportJob) (*DocumentImportJob, error) {
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
	job.SourceType = "pdf"
	if job.Status == "" {
		job.Status = "processing"
	}
	job.CreatedAt = now
	job.UpdatedAt = now
	data, err := json.Marshal(job)
	if err != nil {
		return nil, err
	}
	score := float64(now.UnixMilli())
	_, err = s.redis.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.Set(ctx, documentImportJobKey(id), data, 0)
		pipe.ZAdd(ctx, documentImportUserKey(job.UserID), redis.Z{Score: score, Member: id})
		pipe.ZAdd(ctx, documentImportUserKBKey(job.UserID, job.KnowledgeBaseID), redis.Z{Score: score, Member: id})
		pipe.ZAdd(ctx, documentImportStatusKey(job.Status), redis.Z{Score: score, Member: id})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return cloneDocumentImportJob(&job), nil
}

func (s *DocumentImportStore) Get(ctx context.Context, jobID int64) (*DocumentImportJob, error) {
	raw, err := s.redis.Get(ctx, documentImportJobKey(jobID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrDocumentImportNotFound
	}
	if err != nil {
		return nil, err
	}
	return decodeDocumentImportJob(raw)
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
			previousStatus := job.Status
			if err := mutate(job); err != nil {
				return err
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
		job, err := s.GetOwned(ctx, userID, id)
		if errors.Is(err, ErrDocumentImportNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if _, err := s.redis.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.Del(ctx, documentImportJobKey(id), documentImportPagesKey(id), documentImportLockKey(id))
			pipe.ZRem(ctx, documentImportUserKey(job.UserID), id)
			pipe.ZRem(ctx, documentImportUserKBKey(job.UserID, job.KnowledgeBaseID), id)
			pipe.ZRem(ctx, documentImportStatusKey(job.Status), id)
			pipe.ZRem(ctx, documentImportRunnableKey(), id)
			return nil
		}); err != nil {
			return nil, err
		}
		deleted = append(deleted, id)
	}
	return deleted, nil
}

func (s *DocumentImportStore) SavePages(ctx context.Context, jobID int64, pages []DocumentImportPage) error {
	if _, err := s.Get(ctx, jobID); err != nil {
		return err
	}
	if len(pages) == 0 {
		return nil
	}
	now := time.Now().UTC()
	values := make([]any, 0, len(pages)*2)
	for i := range pages {
		page := pages[i]
		page.ID = int64(page.PageNo)
		page.JobID = jobID
		if page.Status == "" {
			page.Status = "pending"
		}
		if page.MaxAttempts <= 0 {
			page.MaxAttempts = documentImportDefaultTries
		}
		if page.NextAttemptAt.IsZero() {
			page.NextAttemptAt = now
		}
		if page.CreatedAt.IsZero() {
			page.CreatedAt = now
		}
		page.UpdatedAt = now
		data, err := json.Marshal(page)
		if err != nil {
			return err
		}
		values = append(values, strconv.FormatInt(int64(page.PageNo), 10), data)
	}
	return s.redis.HSet(ctx, documentImportPagesKey(jobID), values...).Err()
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

func (s *DocumentImportStore) UpdatePage(ctx context.Context, jobID, pageNo int64,
	mutate func(*DocumentImportPage) error,
) (*DocumentImportPage, error) {
	key := documentImportPagesKey(jobID)
	field := strconv.FormatInt(pageNo, 10)
	var updated *DocumentImportPage
	err := retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			raw, err := tx.HGet(ctx, key, field).Bytes()
			if errors.Is(err, redis.Nil) {
				return ErrDocumentImportNotFound
			}
			if err != nil {
				return err
			}
			page, err := decodeDocumentImportPage(raw)
			if err != nil {
				return err
			}
			if err := mutate(page); err != nil {
				return err
			}
			page.UpdatedAt = time.Now().UTC()
			data, err := json.Marshal(page)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.HSet(ctx, key, field, data)
				return nil
			})
			if err == nil {
				updated = page
			}
			return err
		}, key)
	})
	return updated, err
}

// UpdatePages 在单个 WATCH 事务中批量修改一个任务的全部页面。
func (s *DocumentImportStore) UpdatePages(ctx context.Context, jobID int64,
	mutate func([]*DocumentImportPage) error,
) ([]DocumentImportPage, error) {
	key := documentImportPagesKey(jobID)
	var updated []DocumentImportPage
	err := retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			values, err := tx.HGetAll(ctx, key).Result()
			if err != nil {
				return err
			}
			pages := make([]*DocumentImportPage, 0, len(values))
			for _, raw := range values {
				page, err := decodeDocumentImportPage([]byte(raw))
				if err != nil {
					return err
				}
				pages = append(pages, page)
			}
			sort.Slice(pages, func(i, j int) bool { return pages[i].PageNo < pages[j].PageNo })
			if err := mutate(pages); err != nil {
				return err
			}
			now := time.Now().UTC()
			fields := make([]any, 0, len(pages)*2)
			for _, page := range pages {
				page.UpdatedAt = now
				data, err := json.Marshal(page)
				if err != nil {
					return err
				}
				fields = append(fields, strconv.FormatInt(int64(page.PageNo), 10), data)
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				if len(fields) > 0 {
					pipe.HSet(ctx, key, fields...)
				}
				return nil
			})
			if err == nil {
				updated = make([]DocumentImportPage, 0, len(pages))
				for _, page := range pages {
					updated = append(updated, *page)
				}
			}
			return err
		}, key)
	})
	return updated, err
}

func (s *DocumentImportStore) SetRunnable(ctx context.Context, jobID int64, runnable bool) error {
	if runnable {
		return s.redis.ZAdd(ctx, documentImportRunnableKey(), redis.Z{
			Score: float64(time.Now().UnixMilli()), Member: jobID,
		}).Err()
	}
	return s.redis.ZRem(ctx, documentImportRunnableKey(), jobID).Err()
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
