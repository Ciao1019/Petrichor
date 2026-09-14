package taskqueue

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const DocumentImportFinalizeLockTTL = 10 * time.Minute

var ErrDocumentImportFinalizing = errors.New("任务正在生成文章或等待成文状态恢复，暂不能取消或删除，请稍后重试")

// CancelOwned 与成文共锁；获得锁后在 WATCH 回调重新校验归属和最新状态。
func (s *DocumentImportStore) CancelOwned(ctx context.Context, userID, jobID int64) (*DocumentImportJob, error) {
	release, err := s.AcquireJobLock(ctx, jobID, DocumentImportFinalizeLockTTL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = release(context.WithoutCancel(ctx)) }()
	return s.UpdateJob(ctx, jobID, func(job *DocumentImportJob) error {
		if job.UserID != userID {
			return ErrDocumentImportNotFound
		}
		if job.Status == "completed" || job.ArticleID != nil {
			return ErrDocumentImportEnded
		}
		// 预留 ID 可能已在 PostgreSQL 提交：不能取消后丢掉跨系统幂等恢复入口。
		if job.PendingArticleID != nil {
			return ErrDocumentImportFinalizing
		}
		job.Status = "canceled"
		return nil
	})
}

func (s *DocumentImportStore) deleteOwnedJob(ctx context.Context, userID, jobID int64) (bool, error) {
	release, err := s.AcquireJobLock(ctx, jobID, DocumentImportFinalizeLockTTL)
	if err != nil {
		return false, err
	}
	defer func() { _ = release(context.WithoutCancel(ctx)) }()
	removed := false
	key := documentImportJobKey(jobID)
	err = retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			raw, err := tx.Get(ctx, key).Bytes()
			if errors.Is(err, redis.Nil) {
				return nil
			}
			if err != nil {
				return err
			}
			job, err := decodeDocumentImportJob(raw)
			if err != nil {
				return err
			}
			if job.UserID != userID {
				return nil
			}
			if job.PendingArticleID != nil && job.ArticleID == nil {
				return ErrDocumentImportFinalizing
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Del(ctx, key, documentImportPagesKey(jobID))
				pipe.ZRem(ctx, documentImportUserKey(job.UserID), jobID)
				pipe.ZRem(ctx, documentImportUserKBKey(job.UserID, job.KnowledgeBaseID), jobID)
				pipe.ZRem(ctx, documentImportStatusKey(job.Status), jobID)
				pipe.ZRem(ctx, documentImportRunnableKey(), jobID)
				return nil
			})
			removed = err == nil
			return err
		}, key)
	})
	return removed, err
}
