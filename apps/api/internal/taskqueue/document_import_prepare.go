package taskqueue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrDocumentImportPrepareStale = errors.New("准备领取已过期或任务不可准备")
var ErrDocumentImportPreparePlan = errors.New("解析页计划无效或超限")

// ClaimPreparation 独立领取准备租约，不占用取消/成文锁。崩溃领取也计入重试次数。
func (s *DocumentImportStore) ClaimPreparation(ctx context.Context, jobID int64, lease time.Duration) (*DocumentImportJob, error) {
	if lease <= time.Second {
		return nil, errors.New("准备租约无效")
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(raw[:])
	var claimed *DocumentImportJob
	_, err := s.UpdateJobPages(ctx, jobID, func(job *DocumentImportJob, pages []*DocumentImportPage) error {
		now := time.Now().UTC()
		if !DocumentImportNeedsPreparation(job) || len(pages) != 0 || documentImportTerminal(job.Status) ||
			job.PrepareLeaseUntil.After(now) || job.PrepareNextAttemptAt.After(now) {
			return ErrDocumentImportPrepareStale
		}
		if job.PrepareAttempt >= job.PrepareMaxAttempts {
			message := "文档准备重试次数已耗尽"
			job.Status, job.Error, job.PrepareLastError, job.DeadLetteredAt = "dead_letter", &message, &message, &now
			job.PrepareToken, job.PrepareLeaseUntil = "", time.Time{}
		} else {
			job.PrepareAttempt++
			job.PrepareToken, job.PrepareLeaseUntil = token, now.Add(lease)
			job.Status, job.Stage, job.Error = "processing", "preparing", nil
		}
		claimed = cloneDocumentImportJob(job)
		return nil
	})
	return claimed, err
}

func preparationFence(job *DocumentImportJob, token string) error {
	if token == "" || job.PrepareToken != token || !job.PrepareLeaseUntil.After(time.Now()) ||
		documentImportTerminal(job.Status) || job.ArticleID != nil || !DocumentImportNeedsPreparation(job) {
		return ErrDocumentImportPrepareStale
	}
	return nil
}

func (s *DocumentImportStore) SetPreparationStage(ctx context.Context, jobID int64, token, stage string) error {
	if stage != "parsing" && stage != "rendering" {
		return ErrDocumentImportPreparePlan
	}
	_, err := s.UpdateJob(ctx, jobID, func(job *DocumentImportJob) error {
		if err := preparationFence(job, token); err != nil {
			return err
		}
		job.Stage = stage
		return nil
	})
	return err
}

func DocumentImportPageImageKey(userID, jobID int64, token string, pageNo int32) string {
	return fmt.Sprintf("uploads/%d/document-import/%d/%s/page-%d.png", userID, jobID, token, pageNo)
}

func validatePreparedPlan(job *DocumentImportJob, token string, pages []DocumentImportPage) error {
	if err := validateDocumentImportPages(pages); err != nil {
		return ErrDocumentImportPreparePlan
	}
	if (job.SourceType == "pdf" && len(pages) > 500) || (job.SourceType != "pdf" && len(pages) != 1) {
		return ErrDocumentImportPreparePlan
	}
	for _, page := range pages {
		if len(page.Assets) > 0 {
			if err := validatePreparedAssets(job, token, page); err != nil {
				return err
			}
		} else if page.Markdown != nil {
			if page.Status != "done" || page.ExtractedBy != "direct" || page.ImageKey != nil {
				return ErrDocumentImportPreparePlan
			}
		} else if page.Status != "pending" || page.ExtractedBy != "ocr" || page.ImageKey == nil ||
			*page.ImageKey != DocumentImportPageImageKey(job.UserID, job.ID, token, page.PageNo) {
			return ErrDocumentImportPreparePlan
		}
		if page.AttemptCount != 0 || page.Error != nil {
			return ErrDocumentImportPreparePlan
		}
	}
	return nil
}

// CommitPreparation 一次提交完整页计划，WATCH 内重验 token/lease/终态，绝不覆盖旧页。
func (s *DocumentImportStore) CommitPreparation(ctx context.Context, jobID int64, token string, pages []DocumentImportPage) error {
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
			if err := preparationFence(job, token); err != nil {
				return err
			}
			if err := validatePreparedPlan(job, token, pages); err != nil {
				return err
			}
			count, err := tx.HLen(ctx, pagesKey).Result()
			if err != nil {
				return err
			}
			if count != 0 {
				return ErrDocumentImportPrepareStale
			}
			now := time.Now().UTC()
			fields, err := documentImportPageFields(jobID, pages, now)
			if err != nil {
				return err
			}
			job.TotalPages, job.ProcessedPages, job.Stage = int32(len(pages)), 0, "ocr"
			for _, page := range pages {
				if page.Status == "done" {
					job.ProcessedPages++
				}
			}
			if job.ProcessedPages == job.TotalPages {
				job.Stage = "finalizing"
			}
			job.PrepareToken, job.PrepareLeaseUntil, job.PrepareNextAttemptAt = "", time.Time{}, time.Time{}
			job.Error, job.PrepareLastError, job.UpdatedAt = nil, nil, now
			data, err := json.Marshal(job)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Set(ctx, jobKey, data, 0)
				pipe.HSet(ctx, pagesKey, fields...)
				if DocumentImportRunnable(job, pages) {
					pipe.ZAdd(ctx, documentImportRunnableKey(), redis.Z{Score: float64(now.UnixMilli()), Member: jobID})
				}
				return nil
			})
			return err
		}, jobKey, pagesKey)
	})
}

func (s *DocumentImportStore) FailPreparation(ctx context.Context, jobID int64, token, status, message string, next time.Time) error {
	if status != "pending" && status != "failed" && status != "dead_letter" {
		return ErrDocumentImportPreparePlan
	}
	_, err := s.UpdateJob(ctx, jobID, func(job *DocumentImportJob) error {
		if err := preparationFence(job, token); err != nil {
			return err
		}
		job.Status, job.Error, job.PrepareLastError = status, &message, &message
		job.PrepareToken, job.PrepareLeaseUntil, job.PrepareNextAttemptAt = "", time.Time{}, next
		if status == "dead_letter" {
			now := time.Now().UTC()
			job.DeadLetteredAt = &now
		}
		return nil
	})
	return err
}
