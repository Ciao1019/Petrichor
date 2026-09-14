package taskqueue

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/hibiken/asynq"
)

func preparingTestJob() DocumentImportJob {
	key := "uploads/7/a.pdf"
	return DocumentImportJob{UserID: 7, KnowledgeBaseID: 9, FileName: "a.pdf", Title: "A", SourceType: "pdf",
		SourceKey: &key, Stage: "preparing", Concurrency: 4, IdempotencyKey: "9a7f520a-442a-4718-9805-498981f68cc9"}
}

func TestDocumentImportConcurrentIdempotencyAndFrozenParameters(t *testing.T) {
	store := newDocumentImportTestStore(t)
	ctx := context.Background()
	const n = 32
	jobs, errs := make([]*DocumentImportJob, n), make([]error, n)
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		go func(i int) { defer wg.Done(); jobs[i], errs[i] = store.Create(ctx, preparingTestJob()) }(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
		if jobs[i].ID != jobs[0].ID || jobs[i].Fingerprint == "" {
			t.Fatalf("并发重复: %+v", jobs[i])
		}
	}
	_, count, err := store.List(ctx, 7, nil, 0, 100)
	if err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	for _, mutate := range []func(*DocumentImportJob){
		func(j *DocumentImportJob) { j.KnowledgeBaseID++ }, func(j *DocumentImportJob) { id := int64(1); j.ParentNodeID = &id },
		func(j *DocumentImportJob) { j.FileName = "other.pdf" }, func(j *DocumentImportJob) { j.Title = "B" },
		func(j *DocumentImportJob) { k := "uploads/7/b.pdf"; j.SourceKey = &k },
		func(j *DocumentImportJob) { id := int64(2); j.ModelConfigID = &id }, func(j *DocumentImportJob) { j.Concurrency++ },
		func(j *DocumentImportJob) { j.ImagePolicy = ImagePolicyTextOnly },
		func(j *DocumentImportJob) { j.ImagePolicy = ImagePolicyImagesOnly },
	} {
		input := preparingTestJob()
		mutate(&input)
		if _, err := store.Create(ctx, input); !errors.Is(err, ErrDocumentImportIdempotencyConflict) {
			t.Fatalf("不同参数未冲突: %v", err)
		}
		if _, err := store.UpdateJob(ctx, jobs[0].ID, func(j *DocumentImportJob) error { mutate(j); return nil }); !errors.Is(err, ErrDocumentImportIdempotencyConflict) {
			t.Fatalf("参数未冻结: %v", err)
		}
	}
	other := preparingTestJob()
	other.UserID++
	if j, err := store.Create(ctx, other); err != nil || j.ID == jobs[0].ID {
		t.Fatalf("不同用户幂等空间串联: %v", err)
	}
	if _, err := store.DeleteOwned(ctx, 7, []int64{jobs[0].ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(ctx, preparingTestJob()); !errors.Is(err, ErrDocumentImportIdempotencyConflict) {
		t.Fatal("删除后复活了幂等任务")
	}
}

func TestDocumentImportPreparationFenceAndCompletePlan(t *testing.T) {
	store := newDocumentImportTestStore(t)
	ctx := context.Background()
	job, err := store.Create(ctx, preparingTestJob())
	if err != nil {
		t.Fatal(err)
	}
	if DocumentImportPagesReady(nil) || !DocumentImportRunnable(job, nil) || job.TotalPages != 0 {
		t.Fatal("零页调度契约错误")
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 {
		t.Fatalf("%v %v", ids, err)
	}
	claim, err := store.ClaimPreparation(ctx, job.ID, time.Minute)
	if err != nil || claim.PrepareAttempt != 1 {
		t.Fatalf("%+v %v", claim, err)
	}
	if _, err := store.ClaimPreparation(ctx, job.ID, time.Minute); !errors.Is(err, ErrDocumentImportPrepareStale) {
		t.Fatal(err)
	}
	if err := store.SetPreparationStage(ctx, job.ID, claim.PrepareToken, "rendering"); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePages(ctx, job.ID, []DocumentImportPage{{PageNo: 1}}); err == nil {
		t.Fatal("SavePages绕过围栏")
	}
	_, err = store.UpdateJob(ctx, job.ID, func(j *DocumentImportJob) error { j.PrepareLeaseUntil = time.Now().Add(-time.Second); return nil })
	if err != nil {
		t.Fatal(err)
	}
	newClaim, err := store.ClaimPreparation(ctx, job.ID, time.Minute)
	if err != nil || newClaim.PrepareAttempt != 2 || newClaim.PrepareToken == claim.PrepareToken {
		t.Fatalf("%+v %v", newClaim, err)
	}
	text := ""
	plan := []DocumentImportPage{{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &text}}
	if err := store.CommitPreparation(ctx, job.ID, claim.PrepareToken, plan); !errors.Is(err, ErrDocumentImportPrepareStale) {
		t.Fatal(err)
	}
	if err := store.FailPreparation(ctx, job.ID, claim.PrepareToken, "failed", "old", time.Now()); !errors.Is(err, ErrDocumentImportPrepareStale) {
		t.Fatal(err)
	}
	imageKey := DocumentImportPageImageKey(job.UserID, job.ID, newClaim.PrepareToken, 2)
	plan = append(plan, DocumentImportPage{PageNo: 2, Status: "pending", ExtractedBy: "ocr", ImageKey: &imageKey})
	if err := store.CommitPreparation(ctx, job.ID, newClaim.PrepareToken, plan); err != nil {
		t.Fatal(err)
	}
	current, _ := store.Get(ctx, job.ID)
	pages, err := store.Pages(ctx, job.ID)
	if err != nil || len(pages) != 2 || current.TotalPages != 2 || current.ProcessedPages != 1 || current.Stage != "ocr" || current.PrepareToken != "" || !DocumentImportRunnable(current, pages) {
		t.Fatalf("%+v %+v %v", current, pages, err)
	}
	if err := store.CommitPreparation(ctx, job.ID, newClaim.PrepareToken, plan); !errors.Is(err, ErrDocumentImportPrepareStale) {
		t.Fatal("重跑覆盖成功页", err)
	}
}

func TestDocumentImportPreparationCancelAndRetryFence(t *testing.T) {
	for _, operation := range []string{"cancel", "retry"} {
		t.Run(operation, func(t *testing.T) {
			store := newDocumentImportTestStore(t)
			ctx := context.Background()
			job, _ := store.Create(ctx, preparingTestJob())
			claim, err := store.ClaimPreparation(ctx, job.ID, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			if operation == "cancel" {
				if _, err := store.CancelOwned(ctx, job.UserID, job.ID); err != nil {
					t.Fatal("准备阶段不能取消", err)
				}
			} else {
				if err := store.FailPreparation(ctx, job.ID, claim.PrepareToken, "failed", "bad", time.Now()); err != nil {
					t.Fatal(err)
				}
				_, err := store.UpdateJobPages(ctx, job.ID, func(j *DocumentImportJob, _ []*DocumentImportPage) error {
					ResetDocumentImportTaskRetry(j)
					j.Status = "processing"
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			text := "旧结果"
			if err := store.CommitPreparation(ctx, job.ID, claim.PrepareToken, []DocumentImportPage{{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &text}}); !errors.Is(err, ErrDocumentImportPrepareStale) {
				t.Fatal(err)
			}
			pages, _ := store.Pages(ctx, job.ID)
			if len(pages) != 0 {
				t.Fatal("旧token污染页")
			}
		})
	}
}

func TestDocumentImportPreparationCrashExhaustionAndInvalidPlan(t *testing.T) {
	store := newDocumentImportTestStore(t)
	ctx := context.Background()
	input := preparingTestJob()
	input.PrepareMaxAttempts = 1
	job, _ := store.Create(ctx, input)
	claim, _ := store.ClaimPreparation(ctx, job.ID, time.Minute)
	badKey := "uploads/7/client.png"
	if err := store.CommitPreparation(ctx, job.ID, claim.PrepareToken, []DocumentImportPage{{PageNo: 1, Status: "pending", ExtractedBy: "ocr", ImageKey: &badKey}}); !errors.Is(err, ErrDocumentImportPreparePlan) {
		t.Fatal(err)
	}
	if err := store.CommitPreparation(ctx, job.ID, claim.PrepareToken, nil); !errors.Is(err, ErrDocumentImportPreparePlan) {
		t.Fatal(err)
	}
	_, err := store.UpdateJob(ctx, job.ID, func(j *DocumentImportJob) error { j.PrepareLeaseUntil = time.Now().Add(-time.Second); return nil })
	if err != nil {
		t.Fatal(err)
	}
	ended, err := store.ClaimPreparation(ctx, job.ID, time.Minute)
	if err != nil || ended.Status != "dead_letter" || ended.PrepareAttempt != 1 || ended.DeadLetteredAt == nil {
		t.Fatalf("%+v %v", ended, err)
	}
	ids, _ := store.RunnableJobIDs(ctx)
	if len(ids) != 0 {
		t.Fatal(ids)
	}
}

func TestDocumentImportEnqueueCompensationAndPreparationBackoff(t *testing.T) {
	installTestRuntime(t)
	ctx := context.Background()
	store, _ := DocumentImports()
	job, err := store.Create(ctx, preparingTestJob())
	if err != nil {
		t.Fatal(err)
	}
	// 模拟已持久化但 Asynq 数据损坏导致首次入队失败；业务 runnable 不受影响。
	queueKey := "asynq:{document_import}:pending"
	if err := runtime.redis.Set(ctx, queueKey, "wrong-type", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if err := EnqueueDocumentImport(ctx, job.ID); err == nil {
		t.Fatal("预期入队失败")
	}
	ids, _ := store.RunnableJobIDs(ctx)
	if len(ids) != 1 {
		t.Fatal(ids)
	}
	// 清理仅限测试队列键，再次幂等创建并补偿。
	_ = runtime.redis.Del(ctx, queueKey, fmt.Sprintf("asynq:{document_import}:t:%s", documentImportTaskID(job.ID))).Err()
	again, err := store.Create(ctx, preparingTestJob())
	if err != nil || again.ID != job.ID {
		t.Fatalf("%+v %v", again, err)
	}
	claim, _ := store.ClaimPreparation(ctx, job.ID, time.Minute)
	if err := store.FailPreparation(ctx, job.ID, claim.PrepareToken, "pending", "temporary", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := EnqueueDocumentImport(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	info, err := runtime.inspector.GetTaskInfo(QueueDocumentImport, documentImportTaskID(job.ID))
	if err != nil || info.State != asynq.TaskStateScheduled {
		t.Fatalf("%+v %v", info, err)
	}
}

func TestDocumentImportLegacyStageIsNotPrepared(t *testing.T) {
	for _, tc := range []struct {
		total        int32
		status, want string
	}{{0, "processing", ""}, {1, "processing", "ocr"}, {1, "completed", "completed"}} {
		raw := []byte(fmt.Sprintf(`{"id":1,"userId":7,"knowledgeBaseId":9,"totalPages":%d,"status":%q}`, tc.total, tc.status))
		job, err := decodeDocumentImportJob(raw)
		if err != nil || job.Stage != tc.want || DocumentImportNeedsPreparation(job) {
			t.Fatalf("%+v %v", job, err)
		}
	}
}
