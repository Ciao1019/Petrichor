package taskqueue

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	ErrDocumentImportEnded            = errors.New("导入任务已取消或完成，不能修改")
	ErrDocumentImportMarkdownTooLarge = errors.New("Markdown 总量超过 16MiB 或单页超过 2MiB，请减少内容后重试")
)

func documentImportSealed(job *DocumentImportJob) bool {
	return job.Status == "canceled" || job.Status == "completed" || job.ArticleID != nil
}

func documentImportRunnable(job *DocumentImportJob, pages []DocumentImportPage) bool {
	return DocumentImportRunnable(job, pages)
}

func (s *DocumentImportStore) UpdatePage(ctx context.Context, jobID, pageNo int64,
	mutate func(*DocumentImportPage) error,
) (*DocumentImportPage, error) {
	pages, err := s.UpdateJobPages(ctx, jobID, func(job *DocumentImportJob, pages []*DocumentImportPage) error {
		if documentImportSealed(job) || documentImportTerminal(job.Status) {
			return ErrDocumentImportEnded
		}
		for _, page := range pages {
			if int64(page.PageNo) != pageNo {
				continue
			}
			if page.Status == "done" {
				return nil // 已成功页不可被迟到结果或单页重试覆盖。
			}
			if err := mutate(page); err != nil {
				return err
			}
			if page.Markdown != nil && (len(*page.Markdown) > 2<<20 || documentImportMarkdownSize(pages) > 16<<20) {
				// 在同一 WATCH 中将超限 OCR 结果记为永久失败，不截断、不再次累计。
				message := ErrDocumentImportMarkdownTooLarge.Error()
				page.Status, page.Markdown = "failed", nil
				page.Error, page.LastError = &message, &message
				page.DeadLetteredAt = nil
			}
			return nil
		}
		return ErrDocumentImportNotFound
	})
	if err != nil {
		return nil, err
	}
	for i := range pages {
		if int64(pages[i].PageNo) == pageNo {
			return &pages[i], nil
		}
	}
	return nil, ErrDocumentImportNotFound
}

// UpdatePages 只更新活动任务页面；显式重试/重放使用 UpdateJobPages 同时恢复任务状态。
func (s *DocumentImportStore) UpdatePages(ctx context.Context, jobID int64,
	mutate func([]*DocumentImportPage) error,
) ([]DocumentImportPage, error) {
	return s.UpdateJobPages(ctx, jobID, func(job *DocumentImportJob, pages []*DocumentImportPage) error {
		if documentImportTerminal(job.Status) || job.ArticleID != nil {
			return ErrDocumentImportEnded
		}
		return mutate(pages)
	})
}

// UpdateJobPages 原子提交任务、页集、状态索引及 runnable；WATCH 同时覆盖 job/pages。
// canceled/completed 不执行回调；failed/dead_letter 只能由显式重试回调恢复。
func (s *DocumentImportStore) UpdateJobPages(ctx context.Context, jobID int64,
	mutate func(*DocumentImportJob, []*DocumentImportPage) error,
) ([]DocumentImportPage, error) {
	key, jobKey := documentImportPagesKey(jobID), documentImportJobKey(jobID)
	var updated []DocumentImportPage
	err := retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			rawJob, err := tx.Get(ctx, jobKey).Bytes()
			if errors.Is(err, redis.Nil) {
				return ErrDocumentImportNotFound
			}
			if err != nil {
				return err
			}
			job, err := decodeDocumentImportJob(rawJob)
			if err != nil {
				return err
			}
			if documentImportSealed(job) {
				return ErrDocumentImportEnded
			}
			previousStatus := job.Status
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
			before := documentImportMarkdownSize(pages)
			previous := *job
			if err := mutate(job, pages); err != nil {
				return err
			}
			if !frozenDocumentImportUnchanged(&previous, job) {
				return ErrDocumentImportIdempotencyConflict
			}
			normalizeDocumentImportStage(job)
			// 历史超限记录仍允许清理、重试和进度更新，但不能继续扩容。
			if after := documentImportMarkdownSize(pages); after > 16<<20 && after > before {
				return ErrDocumentImportMarkdownTooLarge
			}
			now := time.Now().UTC()
			fields := make([]any, 0, len(pages)*2)
			snapshot := make([]DocumentImportPage, 0, len(pages))
			for _, page := range pages {
				page.UpdatedAt = now
				data, err := json.Marshal(page)
				if err != nil {
					return err
				}
				fields = append(fields, strconv.Itoa(int(page.PageNo)), data)
				snapshot = append(snapshot, *page)
			}
			job.UpdatedAt = now
			data, err := json.Marshal(job)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Set(ctx, jobKey, data, 0)
				if len(fields) > 0 {
					pipe.HSet(ctx, key, fields...)
				}
				if previousStatus != job.Status {
					pipe.ZRem(ctx, documentImportStatusKey(previousStatus), jobID)
					pipe.ZAdd(ctx, documentImportStatusKey(job.Status), redis.Z{Score: float64(now.UnixMilli()), Member: jobID})
				}
				if documentImportRunnable(job, snapshot) {
					pipe.ZAdd(ctx, documentImportRunnableKey(), redis.Z{Score: float64(now.UnixMilli()), Member: jobID})
				} else {
					pipe.ZRem(ctx, documentImportRunnableKey(), jobID)
				}
				return nil
			})
			if err == nil {
				updated = snapshot
			}
			return err
		}, key, jobKey)
	})
	return updated, err
}

func (s *DocumentImportStore) refreshRunnable(ctx context.Context, jobID int64) error {
	jobKey, pagesKey := documentImportJobKey(jobID), documentImportPagesKey(jobID)
	return retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			runnable := false
			raw, err := tx.Get(ctx, jobKey).Bytes()
			if err != nil && !errors.Is(err, redis.Nil) {
				return err
			}
			if err == nil {
				job, err := decodeDocumentImportJob(raw)
				if err != nil {
					return err
				}
				if !documentImportTerminal(job.Status) && job.ArticleID == nil {
					values, err := tx.HGetAll(ctx, pagesKey).Result()
					if err != nil {
						return err
					}
					pages := make([]DocumentImportPage, 0, len(values))
					for _, raw := range values {
						page, err := decodeDocumentImportPage([]byte(raw))
						if err != nil {
							return err
						}
						pages = append(pages, *page)
					}
					runnable = documentImportRunnable(job, pages)
				}
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				if runnable {
					pipe.ZAdd(ctx, documentImportRunnableKey(), redis.Z{Score: float64(time.Now().UnixMilli()), Member: jobID})
				} else {
					pipe.ZRem(ctx, documentImportRunnableKey(), jobID)
				}
				return nil
			})
			return err
		}, jobKey, pagesKey)
	})
}

func documentImportMarkdownSize(pages []*DocumentImportPage) int {
	total := 0
	for _, page := range pages {
		if page.Markdown != nil {
			total += len(*page.Markdown)
		}
	}
	return total
}
