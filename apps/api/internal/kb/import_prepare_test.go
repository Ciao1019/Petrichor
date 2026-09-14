package kb

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/hibiken/asynq"
	"petrichor/api/internal/adminpanel"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

func preparationTestJob(t *testing.T, store *taskqueue.DocumentImportStore, attempts int32, policy ...string) *JobRow {
	t.Helper()
	key := "uploads/7/" + storage.NewUUID() + ".pdf"
	if err := storage.SaveLocalObject(key, []byte("original")); err != nil {
		t.Fatal(err)
	}
	imagePolicy := ""
	if len(policy) > 0 {
		imagePolicy = policy[0]
	}
	job, err := store.Create(context.Background(), JobRow{UserID: 7, KnowledgeBaseID: 9, FileName: "a.pdf", SourceType: "pdf", Title: "A", SourceKey: &key,
		Stage: "preparing", IdempotencyKey: storage.NewUUID(), PrepareMaxAttempts: attempts, ImagePolicy: imagePolicy})
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestImportPrepareCompletePlanImmediateImageUploadAndNoReparse(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	job := preparationTestJob(t, store, 5)
	old := prepareImportDocument
	defer func() { prepareImportDocument = old }()
	calls, workDir := 0, ""
	prepareImportDocument = func(ctx context.Context, cfg documentparse.Config, name string, source []byte, dir string, stage func(string), emit func(documentparse.Page) error) error {
		calls++
		workDir = dir
		current, err := store.Get(ctx, job.ID)
		if err != nil {
			return err
		}
		deadline, ok := ctx.Deadline()
		if !ok || !deadline.Before(current.PrepareLeaseUntil) || string(source) != "original" || name != "a.pdf" {
			return errors.New("准备输入或截止时间错误")
		}
		stage("parsing")
		empty := ""
		if err := emit(documentparse.Page{PageNo: 1, Markdown: &empty}); err != nil {
			return err
		}
		stage("rendering")
		imagePath := filepath.Join(dir, "page.png")
		if err := os.WriteFile(imagePath, safetyPNG(t), 0600); err != nil {
			return err
		}
		if err := emit(documentparse.Page{PageNo: 2, ImagePath: imagePath}); err != nil {
			return err
		}
		if err := os.Remove(imagePath); err != nil {
			return err
		}
		key := taskqueue.DocumentImportPageImageKey(job.UserID, job.ID, current.PrepareToken, 2)
		if !storage.LocalObjectExists(key) {
			return errors.New("图片没有在回调内上传")
		}
		pages, err := store.Pages(ctx, job.ID)
		if err != nil || len(pages) != 0 {
			return errors.New("部分页提前提交")
		}
		current, err = store.Get(ctx, job.ID)
		if err != nil || current.TotalPages != 0 || current.Stage != "rendering" {
			return errors.New("准备阶段进度错误")
		}
		return nil
	}
	ready, err := prepareImportJob(ctx, store, job)
	if err != nil || !ready {
		t.Fatalf("ready=%v err=%v", ready, err)
	}
	if _, err := os.Stat(workDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("临时目录泄漏")
	}
	current, _ := store.Get(ctx, job.ID)
	pages, _ := store.Pages(ctx, job.ID)
	if current.Stage != "ocr" || current.TotalPages != 2 || current.ProcessedPages != 1 || len(pages) != 2 || pages[0].Markdown == nil || *pages[0].Markdown != "" || pages[1].ImageKey == nil {
		t.Fatalf("%+v %+v", current, pages)
	}
	if ready, err := prepareImportJob(ctx, store, current); err != nil || !ready || calls != 1 {
		t.Fatalf("已准备任务重新解析: %v %d", err, calls)
	}
	if err := EnqueueRunnableDocumentImports(ctx); err != nil {
		t.Fatal(err)
	}
	counts, err := taskqueue.QueueStatusCounts(taskqueue.QueueDocumentImport)
	if err != nil || len(counts) == 0 {
		t.Fatalf("%+v %v", counts, err)
	}
}

func TestImportPrepareCanceledWhileParsingStopsWithoutFinalizationLock(t *testing.T) {
	for _, businessCancel := range []bool{false, true} {
		t.Run(fmt.Sprint(businessCancel), func(t *testing.T) {
			store := importSafetyStore(t)
			job := preparationTestJob(t, store, 5)
			old := prepareImportDocument
			defer func() { prepareImportDocument = old }()
			started := make(chan string, 1)
			prepareImportDocument = func(ctx context.Context, _ documentparse.Config, _ string, _ []byte, dir string, stage func(string), _ func(documentparse.Page) error) error {
				stage("parsing")
				started <- dir
				<-ctx.Done()
				return ctx.Err()
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := prepareImportJob(ctx, store, job); done <- err }()
			dir := <-started
			if businessCancel {
				if _, err := store.CancelOwned(context.Background(), job.UserID, job.ID); err != nil {
					t.Fatal("准备占用了成文锁", err)
				}
			} else {
				cancel()
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("取消未终止解析器")
			}
			current, _ := store.Get(context.Background(), job.ID)
			pages, _ := store.Pages(context.Background(), job.ID)
			if len(pages) != 0 || current.TotalPages != 0 || (businessCancel && current.Status != "canceled") || (!businessCancel && current.Status != "pending") {
				t.Fatalf("%+v %+v", current, pages)
			}
			if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("取消后临时目录未删除")
			}
		})
	}
}

func TestImportPrepareFailureClassificationExhaustionRetryAndAdminReplay(t *testing.T) {
	permanent := documentparse.Prepare(context.Background(), documentparse.DefaultConfig(), "a.pdf", nil, t.TempDir(), nil, func(documentparse.Page) error { return nil })
	if !documentparse.IsPermanent(permanent) {
		t.Fatal(permanent)
	}
	for _, tc := range []struct {
		name     string
		failure  error
		attempts int
		status   string
	}{
		{"temporary", errors.New("temporary download"), 2, "dead_letter"}, {"timeout", context.DeadlineExceeded, 2, "dead_letter"},
		{"malformed", permanent, 1, "failed"}, {"limit", storage.ErrObjectTooLarge, 1, "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := importSafetyStore(t)
			ctx := context.Background()
			job := preparationTestJob(t, store, 2)
			old := prepareImportDocument
			defer func() { prepareImportDocument = old }()
			calls := 0
			prepareImportDocument = func(context.Context, documentparse.Config, string, []byte, string, func(string), func(documentparse.Page) error) error {
				calls++
				return tc.failure
			}
			for attempt := 1; attempt <= tc.attempts; attempt++ {
				if ready, err := prepareImportJob(ctx, store, job); err != nil || ready {
					t.Fatalf("%v %v", ready, err)
				}
				job, _ = store.Get(ctx, job.ID)
				if job.PrepareAttempt != int32(attempt) {
					t.Fatalf("%+v", job)
				}
				if attempt < tc.attempts {
					if job.Status != "pending" || !job.PrepareNextAttemptAt.After(time.Now()) {
						t.Fatalf("退避丢失: %+v", job)
					}
					if _, err := prepareImportJob(ctx, store, job); err != nil || calls != attempt {
						t.Fatal("退避期再次执行", err)
					}
					job, _ = store.UpdateJob(ctx, job.ID, func(j *JobRow) error { j.PrepareNextAttemptAt = time.Time{}; return nil })
				}
			}
			if job.Status != tc.status || job.TotalPages != 0 || job.PrepareLastError == nil {
				t.Fatalf("%+v", job)
			}
			if retried, err := retryFailedImportJob(ctx, store, job.ID); err != nil || retried != 1 {
				t.Fatalf("零页重试: %d %v", retried, err)
			}
			job, _ = store.Get(ctx, job.ID)
			if job.Stage != "preparing" || job.PrepareAttempt != 0 || !taskqueue.DocumentImportRunnable(job, nil) {
				t.Fatalf("%+v", job)
			}
			_, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error { j.Status = tc.status; j.PrepareAttempt = 2; return nil })
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(http.MethodPost, "/admin/replay?reset=1", strings.NewReader(fmt.Sprintf(`{"kind":"document_import","id":"%d"}`, job.ID)))
			c.Request.Header.Set("Content-Type", "application/json")
			adminpanel.AdminReplayDeadLetter(c)
			if response.Code != 200 {
				t.Fatalf("replay: %d %s", response.Code, response.Body.String())
			}
			job, _ = store.Get(ctx, job.ID)
			if job.PrepareAttempt != 0 || job.Stage != "preparing" || job.Status != "processing" {
				t.Fatalf("%+v", job)
			}
		})
	}
}

func TestImportPrepareInvalidPlanDoesNotCommitPartialPages(t *testing.T) {
	store := importSafetyStore(t)
	job := preparationTestJob(t, store, 5)
	ctx := context.Background()
	old := prepareImportDocument
	defer func() { prepareImportDocument = old }()
	prepareImportDocument = func(ctx context.Context, _ documentparse.Config, _ string, _ []byte, dir string, stage func(string), emit func(documentparse.Page) error) error {
		text := "safe"
		if err := emit(documentparse.Page{PageNo: 1, Markdown: &text}); err != nil {
			return err
		}
		return emit(documentparse.Page{PageNo: 3, Markdown: &text})
	}
	if ready, err := prepareImportJob(ctx, store, job); err != nil || ready {
		t.Fatalf("%v %v", ready, err)
	}
	current, _ := store.Get(ctx, job.ID)
	pages, _ := store.Pages(ctx, job.ID)
	if current.Status != "failed" || current.TotalPages != 0 || len(pages) != 0 {
		t.Fatalf("%+v %+v", current, pages)
	}
}

func TestImportFinalizationFailureTaskRetryPreservesArticleReservation(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	text := "正文"
	job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &text})
	id := int64(456)
	_, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error {
		j.Stage = "finalizing"
		j.Status = "failed"
		j.PendingArticleID = &id
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Set("petrichor.user", &auth.User{ID: job.UserID})
	c.Request = httptest.NewRequest(http.MethodPost, "/retry-failed", strings.NewReader(fmt.Sprintf(`{"jobId":"%d"}`, job.ID)))
	c.Request.Header.Set("Content-Type", "application/json")
	RetryImportJobFailedPages(c)
	if response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	current, _ := store.Get(ctx, job.ID)
	pages, _ := store.Pages(ctx, job.ID)
	if current.PendingArticleID == nil || *current.PendingArticleID != id || current.Stage != "finalizing" || pages[0].Status != "done" || *pages[0].Markdown != text {
		t.Fatalf("%+v %+v", current, pages)
	}
	if _, err := store.CancelOwned(ctx, job.UserID, job.ID); !errors.Is(err, taskqueue.ErrDocumentImportFinalizing) {
		t.Fatal("预留文章被取消", err)
	}
	if err := completeDocumentImport(ctx, store, job.ID, id); err != nil {
		t.Fatal(err)
	}
	if _, err := retryFailedImportJob(ctx, store, job.ID); err == nil {
		t.Fatal("已完成被重试")
	}
}

func TestImportPrepareDeadLetterAttemptVisible(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	job := preparationTestJob(t, store, 5)
	_, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error { j.PrepareAttempt = 3; return nil })
	if err != nil {
		t.Fatal(err)
	}
	task := asynq.NewTask(taskqueue.TypeDocumentImport, []byte(fmt.Sprintf(`{"jobId":%d}`, job.ID)))
	ctx = taskqueue.WithDocumentImportExecution(ctx)
	if _, err := store.Get(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	markDocumentImportTerminalFailure(ctx, task)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest("GET", "/dead-letters", nil)
	adminpanel.AdminDeadLetterJobs(c)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"prepareAttempt":3`) || !strings.Contains(response.Body.String(), `"stage":"preparing"`) {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}
