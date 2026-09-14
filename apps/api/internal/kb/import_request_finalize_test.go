package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/taskqueue"
)

// 全部请求仅连接 miniredis；一旦进入数据库、解析器或模型即失败。
func finalizeRequestTestSetup(t *testing.T) (*taskqueue.DocumentImportStore, http.Handler) {
	t.Helper()
	store := importSafetyStore(t)
	oldPool, oldPrepare, oldVision := pool, prepareImportDocument, VisionChatInvoker
	pool = func() *pgxpool.Pool { panic("Finalize API 不得访问数据库") }
	prepareImportDocument = func(context.Context, documentparse.Config, string, []byte, string, func(string), func(documentparse.Page) error) error {
		panic("Finalize API 不得解析原件")
	}
	VisionChatInvoker = func(context.Context, int64, *int64, string, string, VisionImageInput) (string, error) {
		panic("Finalize API 不得执行 OCR")
	}
	t.Cleanup(func() { pool, prepareImportDocument, VisionChatInvoker = oldPool, oldPrepare, oldVision })
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set("petrichor.user", &auth.User{ID: 7}); c.Next() })
	router.POST("/api/kb/import/finalize", FinalizeImportJob)
	return store, router
}

func finalizeRequestHTTP(router http.Handler, jobID int64) *httptest.ResponseRecorder {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/api/kb/import/finalize", strings.NewReader(fmt.Sprintf(`{"jobId":"%d"}`, jobID))).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}

func assertFinalizeResponse(t *testing.T, response *httptest.ResponseRecorder, jobID int64, status, stage string, articleID *int64) map[string]any {
	t.Helper()
	var data map[string]any
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &data) != nil {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	article, exists := data["articleId"]
	if !exists || len(data) != 2 || !reflect.DeepEqual(article, nullableIDString(articleID)) {
		t.Fatalf("响应必须仅包含 job 和 string|null articleId: %s", response.Body.String())
	}
	job, ok := data["job"].(map[string]any)
	if !ok || job["id"] != strconv.FormatInt(jobID, 10) || job["status"] != status || job["stage"] != stage || !reflect.DeepEqual(job["articleId"], article) {
		t.Fatalf("任务响应错误: %s", response.Body.String())
	}
	return job
}

func assertFinalizeQueueCount(t *testing.T, count int64) {
	t.Helper()
	counts, err := taskqueue.QueueStatusCounts(taskqueue.QueueDocumentImport)
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 && len(counts) == 0 {
		return
	}
	if len(counts) != 1 || counts[0].Status != "pending" || counts[0].Count != count {
		t.Fatalf("队列应仅有 %d 个待处理任务: %+v", count, counts)
	}
}

func TestImportRequestFinalizeHTTPOnlyQueuesAndPreservesResults(t *testing.T) {
	store, router := finalizeRequestTestSetup(t)
	ctx := context.Background()
	text, message := "已转换的正文", "上次成文失败"
	now := time.Now().UTC()
	reservedID := int64(42)
	for i, status := range []string{"processing", "failed", "dead_letter"} {
		t.Run(status, func(t *testing.T) {
			job := safetyImportJob(t, store,
				JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &text},
				JobPageRow{PageNo: 2, Status: "done", ExtractedBy: "multimodal", Markdown: &text, AttemptCount: 3,
					NextAttemptAt: now.Add(time.Hour)})
			before, err := store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
				current.Status, current.Error, current.DeadLetteredAt = status, &message, &now
				current.PrepareAttempt, current.ReplayCount = 3, 2
				if status != "processing" {
					current.PendingArticleID = &reservedID
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			beforePages, err := store.Pages(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			for repeat := 0; repeat < 2; repeat++ {
				data := assertFinalizeResponse(t, finalizeRequestHTTP(router, job.ID), job.ID, "processing", "finalizing", nil)
				if data["donePages"] != float64(2) || data["processedPages"] != float64(2) || data["directPages"] != float64(1) || data["multimodalPages"] != float64(1) || data["pendingPages"] != float64(0) || data["failedPages"] != float64(0) {
					t.Fatalf("页统计不完整: %+v", data)
				}
				assertFinalizeQueueCount(t, int64(i+1))
			}
			current, err := store.Get(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			before.Status, before.Stage, before.Error, before.DeadLetteredAt = "processing", "finalizing", nil, nil
			before.ProcessedPages, before.UpdatedAt = 2, current.UpdatedAt
			before.ReplayCount += 2 // 两次显式请求都必须使之前的失败执行失效。
			if !reflect.DeepEqual(before, current) {
				t.Fatalf("除调度字段外任务被修改: before=%+v after=%+v", before, current)
			}
			pages, err := store.Pages(ctx, job.ID)
			if err != nil || len(pages) != len(beforePages) {
				t.Fatalf("pages=%+v err=%v", pages, err)
			}
			for p := range pages {
				beforePages[p].UpdatedAt = pages[p].UpdatedAt
			}
			if !reflect.DeepEqual(beforePages, pages) {
				t.Fatalf("成功页或尝试次数被修改: %+v", pages)
			}
			ids, err := store.RunnableJobIDs(ctx)
			if err != nil || len(ids) != i+1 {
				t.Fatalf("runnable=%v err=%v", ids, err)
			}
		})
	}
}

func TestImportRequestFinalizeHTTPRejectsUnreadyAndUnowned(t *testing.T) {
	store, router := finalizeRequestTestSetup(t)
	ctx := context.Background()
	for _, scenario := range []string{"zeroPages", "preparing", "parsing", "rendering", "pending", "processing", "failed", "dead_letter", "missingPages", "canceled", "unowned"} {
		t.Run(scenario, func(t *testing.T) {
			var pages []JobPageRow
			if scenario != "zeroPages" {
				pages = []JobPageRow{{PageNo: 1, Status: "done", ExtractedBy: "direct"}}
			}
			switch scenario {
			case "pending", "processing", "failed", "dead_letter":
				pages[0].Status, pages[0].ExtractedBy = scenario, "ocr"
			}
			job := safetyImportJob(t, store, pages...)
			before, err := store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
				switch scenario {
				case "preparing", "parsing", "rendering":
					current.Stage = scenario
				case "missingPages":
					current.TotalPages++
				case "canceled":
					current.Status = "canceled"
				case "unowned":
					current.UserID = 8
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			beforePages, err := store.Pages(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			beforeIDs, err := store.RunnableJobIDs(ctx)
			if err != nil {
				t.Fatal(err)
			}
			response := finalizeRequestHTTP(router, job.ID)
			want := http.StatusBadRequest
			if scenario == "unowned" {
				want = http.StatusNotFound
			}
			if response.Code != want {
				t.Fatalf("%d %s", response.Code, response.Body.String())
			}
			current, err := store.Get(ctx, job.ID)
			if err != nil || !reflect.DeepEqual(before, current) {
				t.Fatalf("被拒绝的任务被修改: %+v %v", current, err)
			}
			afterPages, err := store.Pages(ctx, job.ID)
			if err != nil || !reflect.DeepEqual(beforePages, afterPages) {
				t.Fatalf("被拒绝的页被修改: %+v %v", afterPages, err)
			}
			afterIDs, err := store.RunnableJobIDs(ctx)
			if err != nil || !reflect.DeepEqual(beforeIDs, afterIDs) {
				t.Fatalf("被拒绝的任务改变 runnable: %v %v", afterIDs, err)
			}
			assertFinalizeQueueCount(t, 0)
		})
	}
	if response := finalizeRequestHTTP(router, 1); response.Code != http.StatusNotFound {
		t.Fatalf("不存在的任务: %d %s", response.Code, response.Body.String())
	}
}

func TestImportRequestFinalizeHTTPCompletedReadOnly(t *testing.T) {
	store, router := finalizeRequestTestSetup(t)
	ctx := context.Background()
	articleID := int64(42)
	for _, scenario := range []string{"completed", "articleExists", "legacyCompleted"} {
		t.Run(scenario, func(t *testing.T) {
			job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct"})
			before, err := store.UpdateJob(ctx, job.ID, func(current *JobRow) error {
				if scenario != "articleExists" {
					current.Status = "completed"
				}
				if scenario != "legacyCompleted" {
					current.ArticleID = &articleID
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			beforePages, err := store.Pages(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			beforeIDs, err := store.RunnableJobIDs(ctx)
			if err != nil {
				t.Fatal(err)
			}
			// 已成文即使锁尚未释放也只读返回，不能再次入队或回写。
			release, err := store.AcquireJobLock(ctx, job.ID, taskqueue.DocumentImportFinalizeLockTTL)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = release(ctx) }()
			status := "processing"
			if scenario == "completed" {
				status = "completed"
			}
			for repeat := 0; repeat < 2; repeat++ {
				data := assertFinalizeResponse(t, finalizeRequestHTTP(router, job.ID), job.ID, status, "completed", before.ArticleID)
				if data["donePages"] != float64(1) {
					t.Fatalf("缺少完成页统计: %+v", data)
				}
			}
			current, err := store.Get(ctx, job.ID)
			if err != nil || !reflect.DeepEqual(before, current) {
				t.Fatalf("已完成任务被重置: %+v %v", current, err)
			}
			pages, err := store.Pages(ctx, job.ID)
			if err != nil || !reflect.DeepEqual(beforePages, pages) {
				t.Fatalf("已完成任务页被修改: %+v %v", pages, err)
			}
			assertFinalizeQueueCount(t, 0)
			ids, err := store.RunnableJobIDs(ctx)
			if err != nil || !reflect.DeepEqual(beforeIDs, ids) {
				t.Fatalf("只读完成任务改变 runnable: %v %v", ids, err)
			}
		})
	}
}

func TestImportRequestFinalizeHTTPWorkerLockAndConcurrentRequests(t *testing.T) {
	store, router := finalizeRequestTestSetup(t)
	ctx := context.Background()
	job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct"})
	release, err := store.AcquireJobLock(ctx, job.ID, taskqueue.DocumentImportFinalizeLockTTL)
	if err != nil {
		t.Fatal(err)
	}
	response := finalizeRequestHTTP(router, job.ID)
	if response.Code != http.StatusConflict {
		t.Fatalf("持锁期间应立即返回409: %d %s", response.Code, response.Body.String())
	}
	current, err := store.Get(ctx, job.ID)
	if err != nil || !reflect.DeepEqual(job, current) {
		t.Fatalf("持锁任务被修改: %+v %v", current, err)
	}
	assertFinalizeQueueCount(t, 0)
	if err := release(ctx); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	responses := make([]*httptest.ResponseRecorder, 12)
	for i := range responses {
		wg.Add(1)
		go func(i int) { defer wg.Done(); responses[i] = finalizeRequestHTTP(router, job.ID) }(i)
	}
	wg.Wait()
	succeeded := 0
	for _, response := range responses {
		if response.Code == http.StatusOK {
			succeeded++
			assertFinalizeResponse(t, response, job.ID, "processing", "finalizing", nil)
		} else if response.Code != http.StatusConflict {
			t.Fatalf("并发请求: %d %s", response.Code, response.Body.String())
		}
	}
	if succeeded == 0 {
		t.Fatal("释放锁后没有请求成功")
	}
	assertFinalizeQueueCount(t, 1)
	current, err = store.Get(ctx, job.ID)
	if err != nil || current.Stage != "finalizing" || current.ArticleID != nil || current.PendingArticleID != nil {
		t.Fatalf("API 不得生成或预留文章: %+v %v", current, err)
	}
}

func TestImportRequestFinalizeRunnableSurvivesMissingEnqueue(t *testing.T) {
	store, _ := finalizeRequestTestSetup(t)
	ctx := context.Background()
	job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct"})
	if _, err := store.UpdateJob(ctx, job.ID, func(current *JobRow) error { current.Status = "failed"; return nil }); err != nil {
		t.Fatal(err)
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 0 {
		t.Fatalf("失败任务不应自动重试: %v %v", ids, err)
	}
	// 模拟原子恢复后入队丢失；reconcile 仅凭持久化 runnable 即可补偿。
	current, pages, err := requestImportFinalization(ctx, store, 7, job.ID)
	if err != nil || current.Stage != "finalizing" || len(pages) != 1 {
		t.Fatalf("%+v %+v %v", current, pages, err)
	}
	assertFinalizeQueueCount(t, 0)
	ids, err = store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 || ids[0] != job.ID {
		t.Fatalf("恢复与 runnable 未原子提交: %v %v", ids, err)
	}
	if err := EnqueueRunnableDocumentImports(ctx); err != nil {
		t.Fatal(err)
	}
	assertFinalizeQueueCount(t, 1)
}
