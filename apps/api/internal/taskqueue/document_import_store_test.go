package taskqueue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newDocumentImportTestStore(t *testing.T) *DocumentImportStore {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return &DocumentImportStore{redis: client}
}

func TestDocumentImportStoreLifecycle(t *testing.T) {
	store := newDocumentImportTestStore(t)
	ctx := context.Background()
	sourceKey := "s4://uploads/source.pdf"
	job, err := store.Create(ctx, DocumentImportJob{
		UserID: 7, KnowledgeBaseID: 9, FileName: "source.pdf", SourceKey: &sourceKey,
		Title: "测试文档", Status: "processing",
	})
	if err != nil {
		t.Fatal(err)
	}
	if job.ID <= 0 || job.CreatedAt.IsZero() {
		t.Fatalf("任务 ID 或时间无效: %+v", job)
	}
	imageKey := "s4://uploads/page-1.png"
	if err := store.SavePages(ctx, job.ID, []DocumentImportPage{
		{PageNo: 1, ExtractedBy: "vision", ImageKey: &imageKey},
		{PageNo: 2, ExtractedBy: "pdf", Status: "done"},
	}); err != nil {
		t.Fatal(err)
	}
	page, err := store.Page(ctx, job.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.MaxAttempts != documentImportDefaultTries || page.Status != "pending" {
		t.Fatalf("页面默认值错误: %+v", page)
	}
	markdown := "# 页面"
	if _, err := store.UpdatePage(ctx, job.ID, 1, func(current *DocumentImportPage) error {
		current.Status = "done"
		current.Markdown = &markdown
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	updated, err := store.UpdateJob(ctx, job.ID, func(current *DocumentImportJob) error {
		current.Status = "completed"
		current.ProcessedPages = 2
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != "completed" || updated.ProcessedPages != 2 {
		t.Fatalf("任务更新错误: %+v", updated)
	}
	jobs, total, err := store.List(ctx, 7, nil, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(jobs) != 1 || jobs[0].ID != job.ID {
		t.Fatalf("任务列表错误: total=%d jobs=%+v", total, jobs)
	}
	counts, err := store.UserStatusCounts(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 1 || counts[0].Status != "completed" || counts[0].Count != 1 {
		t.Fatalf("状态聚合错误: %+v", counts)
	}
	deleted, err := store.DeleteOwned(ctx, 7, []int64{job.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0] != job.ID {
		t.Fatalf("删除结果错误: %+v", deleted)
	}
	if _, err := store.Get(ctx, job.ID); !errors.Is(err, ErrDocumentImportNotFound) {
		t.Fatalf("删除后读取错误=%v", err)
	}
}

func TestDocumentImportStoreRunnableAndLock(t *testing.T) {
	store := newDocumentImportTestStore(t)
	ctx := context.Background()
	job, err := store.Create(ctx, DocumentImportJob{
		UserID: 1, KnowledgeBaseID: 2, FileName: "a.pdf", Title: "A",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetRunnable(ctx, job.ID, true); err != nil {
		t.Fatal(err)
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 || ids[0] != job.ID {
		t.Fatalf("runnable=%v err=%v", ids, err)
	}
	release, err := store.AcquireJobLock(ctx, job.ID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcquireJobLock(ctx, job.ID, time.Minute); !errors.Is(err, ErrDocumentImportLockBusy) {
		t.Fatalf("重复加锁错误=%v", err)
	}
	if err := release(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcquireJobLock(ctx, job.ID, time.Minute); err != nil {
		t.Fatalf("释放后加锁失败: %v", err)
	}
}
