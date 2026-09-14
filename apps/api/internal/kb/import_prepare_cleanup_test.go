package kb

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

func TestImportPrepareUploadedImagesCleanup(t *testing.T) {
	for _, outcome := range []string{"parse-failure", "invalid-next-page", "parent-cancel", "business-cancel", "stale-commit", "success", "lost-commit-response", "lost-response-then-cancel"} {
		t.Run(outcome, func(t *testing.T) {
			store := importSafetyStore(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			job := preparationTestJob(t, store, 5)
			otherKey := taskqueue.DocumentImportPageImageKey(job.UserID, job.ID, "other-attempt", 1)
			if err := storage.SaveLocalObject(otherKey, safetyPNG(t)); err != nil {
				t.Fatal(err)
			}
			oldParser, oldCommit := prepareImportDocument, commitImportPreparation
			defer func() { prepareImportDocument, commitImportPreparation = oldParser, oldCommit }()
			var uploaded []string
			var newClaim *JobRow
			prepareImportDocument = func(parseCtx context.Context, _ documentparse.Config, _ string, _ []byte, dir string, _ func(string), emit func(documentparse.Page) error) error {
				claim, err := store.Get(parseCtx, job.ID)
				if err != nil {
					return err
				}
				for i := 1; i <= 2; i++ {
					path := filepath.Join(dir, "page.png")
					if err := os.WriteFile(path, safetyPNG(t), 0600); err != nil {
						return err
					}
					if err := emit(documentparse.Page{PageNo: i, ImagePath: path}); err != nil {
						return err
					}
					key := taskqueue.DocumentImportPageImageKey(job.UserID, job.ID, claim.PrepareToken, int32(i))
					uploaded = append(uploaded, key)
					if !storage.LocalObjectExists(key) {
						return errors.New("图片未上传")
					}
				}
				switch outcome {
				case "parse-failure":
					return errors.New("第三页解析失败")
				case "invalid-next-page":
					text := "不连续页"
					return emit(documentparse.Page{PageNo: 4, Markdown: &text})
				case "parent-cancel":
					cancel()
					return ctx.Err()
				case "business-cancel":
					_, err = store.CancelOwned(context.Background(), job.UserID, job.ID)
					return err
				}
				return nil
			}
			commitImportPreparation = func(s *taskqueue.DocumentImportStore, commitCtx context.Context, id int64, token string, pages []JobPageRow) error {
				if outcome == "stale-commit" {
					// 页图上传完毕后租约过期，新 attempt 已领取并上传；旧提交被真正的 Redis 围栏拒绝。
					if _, err := s.UpdateJob(commitCtx, id, func(j *JobRow) error { j.PrepareLeaseUntil = time.Now().Add(-time.Second); return nil }); err != nil {
						return err
					}
					var err error
					newClaim, err = s.ClaimPreparation(commitCtx, id, time.Minute)
					if err != nil {
						return err
					}
					otherKey = taskqueue.DocumentImportPageImageKey(job.UserID, id, newClaim.PrepareToken, 1)
					if err := storage.SaveLocalObject(otherKey, safetyPNG(t)); err != nil {
						return err
					}
				}
				err := oldCommit(s, commitCtx, id, token, pages)
				if err == nil && strings.HasPrefix(outcome, "lost-") {
					if outcome == "lost-response-then-cancel" {
						if _, err := s.CancelOwned(context.Background(), job.UserID, id); err != nil {
							return err
						}
					}
					return errors.New("EXEC 已成功但客户端丢失响应")
				}
				return err
			}
			ready, err := prepareImportJob(ctx, store, job)
			if err != nil || ready != (outcome == "success") {
				t.Fatalf("ready=%v err=%v", ready, err)
			}
			published := outcome == "success" || strings.HasPrefix(outcome, "lost-")
			for _, key := range uploaded {
				if storage.LocalObjectExists(key) != published {
					t.Errorf("图片保留错误: %s published=%v", key, published)
				}
			}
			if !storage.LocalObjectExists(*job.SourceKey) || !storage.LocalObjectExists(otherKey) {
				t.Fatal("原件或其他 attempt 图片被删除")
			}
			pages, err := store.Pages(context.Background(), job.ID)
			if err != nil || (len(pages) == 2) != published {
				t.Fatalf("Redis 页计划错误: %+v %v", pages, err)
			}
			if newClaim != nil {
				current, _ := store.Get(context.Background(), job.ID)
				if current.PrepareToken != newClaim.PrepareToken || current.PrepareAttempt != newClaim.PrepareAttempt {
					t.Fatal("清理撤销了新领取", current)
				}
			}
		})
	}
}

func TestImportPrepareCleanupFailureIsTraceableAndConservative(t *testing.T) {
	for _, failure := range []string{"redis-unavailable", "delete-failed"} {
		t.Run(failure, func(t *testing.T) {
			store := importSafetyStore(t)
			ctx := context.Background()
			job := preparationTestJob(t, store, 5)
			claim, err := store.ClaimPreparation(ctx, job.ID, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			key := taskqueue.DocumentImportPageImageKey(job.UserID, job.ID, claim.PrepareToken, 1)
			if err := storage.SaveLocalObject(key, safetyPNG(t)); err != nil {
				t.Fatal(err)
			}
			var logs bytes.Buffer
			oldLogger := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
			defer slog.SetDefault(oldLogger)
			if failure == "redis-unavailable" {
				if err := taskqueue.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				// 对象位置被异常目录占据：helper 必须拒绝，不能递归删除。
				if err := os.Remove(key); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(key, 0700); err != nil {
					t.Fatal(err)
				}
			}
			canceled, cancel := context.WithCancel(ctx)
			cancel()
			cleanupImportPreparationImages(canceled, store, claim, []string{key})
			if !strings.Contains(logs.String(), "清理待补偿") || !strings.Contains(logs.String(), claim.PrepareToken) || !strings.Contains(logs.String(), key) {
				t.Fatal("清理失败未记录可补偿 token/keys", logs.String())
			}
			if _, err := os.Stat(key); err != nil {
				t.Fatal("保守保留失败", err)
			}
		})
	}
}

func TestImportPrepareCleanupRevokesUncertainUnpublishedCommit(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	job := preparationTestJob(t, store, 5)
	claim, err := store.ClaimPreparation(ctx, job.ID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	key := taskqueue.DocumentImportPageImageKey(job.UserID, job.ID, claim.PrepareToken, 1)
	if err := storage.SaveLocalObject(key, safetyPNG(t)); err != nil {
		t.Fatal(err)
	}
	cleanupImportPreparationImages(ctx, store, claim, []string{key})
	err = store.CommitPreparation(ctx, job.ID, claim.PrepareToken, []JobPageRow{{PageNo: 1, Status: "pending", ExtractedBy: "ocr", ImageKey: &key}})
	if !errors.Is(err, taskqueue.ErrDocumentImportPrepareStale) || storage.LocalObjectExists(key) {
		t.Fatal("清理后迟到提交未被围栏拒绝", err)
	}
}
