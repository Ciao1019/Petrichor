package taskqueue

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var ErrDocumentImportIdempotencyConflict = errors.New("幂等键已用于其他导入参数或已删除任务")
var documentImportUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

func ValidDocumentImportIdempotencyKey(key string) bool { return documentImportUUID.MatchString(key) }

// 指纹只包含规范化后的完整创建参数，不受进度、重试和成文状态影响。
func documentImportFingerprint(job *DocumentImportJob) string {
	params := struct {
		UserID, KnowledgeBaseID                int64
		ParentNodeID, ModelConfigID            *int64
		FileName, Title, SourceKey, SourceType string
		Concurrency                            int32
		ImagePolicy                            string
	}{UserID: job.UserID, KnowledgeBaseID: job.KnowledgeBaseID, ParentNodeID: job.ParentNodeID,
		ModelConfigID: job.ModelConfigID, FileName: job.FileName, Title: job.Title,
		SourceType: job.SourceType, Concurrency: job.Concurrency}
	if job.SourceKey != nil {
		params.SourceKey = *job.SourceKey
	}
	params.ImagePolicy = EffectiveDocumentImagePolicy(job.ImagePolicy)
	data, _ := json.Marshal(params)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func frozenDocumentImportUnchanged(before, after *DocumentImportJob) bool {
	return before.Fingerprint == "" || (before.Fingerprint == after.Fingerprint &&
		before.IdempotencyKey == after.IdempotencyKey && documentImportFingerprint(after) == before.Fingerprint)
}

// 幂等映射、任务、页与索引在同一 WATCH/事务中创建；删除后保留映射墓碑，避免迟到请求重复成文。
func (s *DocumentImportStore) persistDocumentImport(ctx context.Context, job *DocumentImportJob,
	pages []DocumentImportPage, fields []any, data []byte,
) (*DocumentImportJob, error) {
	key := documentImportJobKey(job.ID)
	keys := []string{key}
	idemKey := ""
	if job.IdempotencyKey != "" {
		idemKey = documentImportIdempotencyKey(job.UserID, job.IdempotencyKey)
		keys = append(keys, idemKey)
	}
	var result *DocumentImportJob
	err := retryDocumentImportWatch(ctx, func() error {
		return s.redis.Watch(ctx, func(tx *redis.Tx) error {
			if idemKey != "" {
				id, err := tx.Get(ctx, idemKey).Int64()
				if err == nil {
					existing, err := s.Get(ctx, id)
					if errors.Is(err, ErrDocumentImportNotFound) {
						return ErrDocumentImportIdempotencyConflict
					}
					if err != nil {
						return err
					}
					if existing.Fingerprint != job.Fingerprint {
						return ErrDocumentImportIdempotencyConflict
					}
					result = existing
					return nil
				}
				if !errors.Is(err, redis.Nil) {
					return err
				}
			}
			score := float64(job.CreatedAt.UnixMilli())
			_, err := tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Set(ctx, key, data, 0)
				if idemKey != "" {
					pipe.Set(ctx, idemKey, job.ID, 0)
				}
				if len(fields) > 0 {
					pipe.HSet(ctx, documentImportPagesKey(job.ID), fields...)
				}
				if DocumentImportRunnable(job, pages) {
					pipe.ZAdd(ctx, documentImportRunnableKey(), redis.Z{Score: score, Member: job.ID})
				}
				pipe.ZAdd(ctx, documentImportUserKey(job.UserID), redis.Z{Score: score, Member: job.ID})
				pipe.ZAdd(ctx, documentImportUserKBKey(job.UserID, job.KnowledgeBaseID), redis.Z{Score: score, Member: job.ID})
				pipe.ZAdd(ctx, documentImportStatusKey(job.Status), redis.Z{Score: score, Member: job.ID})
				return nil
			})
			if err == nil {
				result = cloneDocumentImportJob(job)
			}
			return err
		}, keys...)
	})
	return result, err
}

func documentImportIdempotencyKey(userID int64, key string) string {
	return documentImportPrefix + "idem:" + strconv.FormatInt(userID, 10) + ":" + strings.ToLower(key)
}

// FindIdempotent 只读快速路径：原任务已存在时不再依赖 PostgreSQL 目录/知识库可用性。
// 未命中不能据此直接写入，Create 仍在同一 WATCH/事务中重验映射。
func (s *DocumentImportStore) FindIdempotent(ctx context.Context, input DocumentImportJob) (*DocumentImportJob, error) {
	if input.UserID <= 0 || !ValidDocumentImportIdempotencyKey(input.IdempotencyKey) {
		return nil, ErrDocumentImportIdempotencyConflict
	}
	id, err := s.redis.Get(ctx, documentImportIdempotencyKey(input.UserID, input.IdempotencyKey)).Int64()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	job, err := s.GetOwned(ctx, input.UserID, id)
	if errors.Is(err, ErrDocumentImportNotFound) {
		return nil, ErrDocumentImportIdempotencyConflict
	}
	if err != nil {
		return nil, err
	}
	if input.SourceType == "" {
		input.SourceType = "pdf"
	}
	if job.Fingerprint != documentImportFingerprint(&input) {
		return nil, ErrDocumentImportIdempotencyConflict
	}
	return job, nil
}
