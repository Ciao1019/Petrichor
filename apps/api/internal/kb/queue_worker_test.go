package kb

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/hibiken/asynq"
	"petrichor/api/internal/adminpanel"
	"petrichor/api/internal/taskqueue"
)

func TestDocumentImportLateTerminalCallbackCannotDeadLetterReplay(t *testing.T) {
	for _, replay := range []string{"retry", "admin"} {
		for _, historical := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/historical=%v", replay, historical), func(t *testing.T) {
				store := importSafetyStore(t)
				ctx := context.Background()
				var job *JobRow
				if historical {
					key := "uploads/7/old-page.png"
					job = safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "failed", ImageKey: &key, ExtractedBy: "ocr"})
				} else {
					job = preparationTestJob(t, store, 5)
				}
				if _, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error { j.Status = "failed"; return nil }); err != nil {
					t.Fatal(err)
				}
				// 精确交错：旧 handle 已返回 SkipRetry，错误回调尚未进入；此时 API 重试/管理员重放。
				oldCtx := taskqueue.WithDocumentImportExecution(ctx)
				task := asynq.NewTask(taskqueue.TypeDocumentImport, []byte(fmt.Sprintf(`{"jobId":%d}`, job.ID)))
				failed := HandleDocumentImportTask(oldCtx, task)
				if !errors.Is(failed, asynq.SkipRetry) {
					t.Fatal(failed)
				}
				if replay == "retry" {
					if _, err := retryFailedImportJob(ctx, store, job.ID); err != nil {
						t.Fatal(err)
					}
				} else {
					response := httptest.NewRecorder()
					c, _ := gin.CreateTestContext(response)
					c.Request = httptest.NewRequest("POST", "/admin/replay?reset=1", strings.NewReader(fmt.Sprintf(`{"kind":"document_import","id":"%d"}`, job.ID)))
					c.Request.Header.Set("Content-Type", "application/json")
					adminpanel.AdminReplayDeadLetter(c)
					if response.Code != 200 {
						t.Fatal(response.Body.String())
					}
				}
				before, _ := store.Get(ctx, job.ID)
				beforePages, _ := store.Pages(ctx, job.ID)
				HandleAsynqTaskError(oldCtx, task, failed)
				after, _ := store.Get(ctx, job.ID)
				afterPages, _ := store.Pages(ctx, job.ID)
				ids, err := store.RunnableJobIDs(ctx)
				if err != nil || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforePages, afterPages) || len(ids) != 1 || ids[0] != job.ID {
					t.Fatalf("旧回调改变了新 generation: before=%+v after=%+v runnable=%v err=%v", before, after, ids, err)
				}
				// 新执行已读取当前 generation，真实失败可正常收敛页和 runnable。
				newCtx := taskqueue.WithDocumentImportExecution(ctx)
				if _, err := store.Get(newCtx, job.ID); err != nil {
					t.Fatal(err)
				}
				HandleAsynqTaskError(newCtx, task, fmt.Errorf("新执行终止: %w", asynq.SkipRetry))
				after, _ = store.Get(ctx, job.ID)
				ids, err = store.RunnableJobIDs(ctx)
				if err != nil || after.Status != "dead_letter" || len(ids) != 0 {
					t.Fatalf("新失败未收敛: %+v runnable=%v err=%v", after, ids, err)
				}
				if historical {
					pages, _ := store.Pages(ctx, job.ID)
					if pages[0].Status != "dead_letter" {
						t.Fatal(pages)
					}
				}
			})
		}
	}
}

func TestDocumentImportTerminalCallbackComparesAttemptAndToken(t *testing.T) {
	for _, field := range []string{"attempt", "token"} {
		t.Run(field, func(t *testing.T) {
			store := importSafetyStore(t)
			ctx := context.Background()
			job := preparationTestJob(t, store, 5)
			oldCtx := taskqueue.WithDocumentImportExecution(ctx)
			if _, err := store.Get(oldCtx, job.ID); err != nil {
				t.Fatal(err)
			}
			before, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error {
				if field == "attempt" {
					j.PrepareAttempt++
				} else {
					j.PrepareToken = "new-token"
				}
				j.PrepareLeaseUntil = time.Now().Add(-time.Second)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			task := asynq.NewTask(taskqueue.TypeDocumentImport, []byte(fmt.Sprintf(`{"jobId":%d}`, job.ID)))
			// 错误回调前即使处理器又读取了新状态，也不能把它冒充旧执行快照。
			before, err = store.Get(oldCtx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			markDocumentImportTerminalFailure(oldCtx, task)
			after, _ := store.Get(ctx, job.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("%s 围栏失效: %+v", field, after)
			}
			newCtx := taskqueue.WithDocumentImportExecution(ctx)
			_, _ = store.Get(newCtx, job.ID)
			markDocumentImportTerminalFailure(newCtx, task)
			after, _ = store.Get(ctx, job.ID)
			if after.Status != "dead_letter" {
				t.Fatal(after)
			}
		})
	}
}
