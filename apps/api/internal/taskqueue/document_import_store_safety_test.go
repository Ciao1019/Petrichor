package taskqueue

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

func createSafetyJob(t *testing.T, store *DocumentImportStore, pages ...DocumentImportPage) *DocumentImportJob {
	t.Helper()
	job, err := store.Create(context.Background(), DocumentImportJob{UserID: 7, KnowledgeBaseID: 9, FileName: "a.pdf", Title: "A"}, pages...)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestDocumentImportCancelDeleteShareFinalizeLock(t *testing.T) {
	ctx := context.Background()
	store := newDocumentImportTestStore(t)
	job := createSafetyJob(t, store)
	release, err := store.AcquireJobLock(ctx, job.ID, DocumentImportFinalizeLockTTL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CancelOwned(ctx, 7, job.ID); !errors.Is(err, ErrDocumentImportLockBusy) {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := store.DeleteOwned(ctx, 7, []int64{job.ID}); !errors.Is(err, ErrDocumentImportLockBusy) {
		t.Fatalf("delete: %v", err)
	}
	if err := release(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CancelOwned(ctx, 8, job.ID); !errors.Is(err, ErrDocumentImportNotFound) {
		t.Fatalf("owner: %v", err)
	}
	id := int64(42)
	if _, err := store.UpdateJob(ctx, job.ID, func(j *DocumentImportJob) error { j.PendingArticleID = &id; return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CancelOwned(ctx, 7, job.ID); !errors.Is(err, ErrDocumentImportFinalizing) {
		t.Fatalf("pending cancel: %v", err)
	}
	if _, err := store.DeleteOwned(ctx, 7, []int64{job.ID}); !errors.Is(err, ErrDocumentImportFinalizing) {
		t.Fatalf("pending delete: %v", err)
	}
	if _, err := store.UpdateJob(ctx, job.ID, func(j *DocumentImportJob) error {
		j.Status, j.ArticleID, j.PendingArticleID = "completed", &id, nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CancelOwned(ctx, 7, job.ID); !errors.Is(err, ErrDocumentImportEnded) {
		t.Fatalf("completed cancel: %v", err)
	}
}

func TestDocumentImportTerminalMutationsAndWatchFence(t *testing.T) {
	ctx := context.Background()
	for _, status := range []string{"canceled", "completed", "failed", "dead_letter"} {
		t.Run(status, func(t *testing.T) {
			store := newDocumentImportTestStore(t)
			job := createSafetyJob(t, store, DocumentImportPage{PageNo: 1, Status: "pending", ExtractedBy: "ocr"})
			if _, err := store.UpdateJob(ctx, job.ID, func(j *DocumentImportJob) error { j.Status = status; return nil }); err != nil {
				t.Fatal(err)
			}
			if _, err := store.UpdateJob(ctx, job.ID, func(j *DocumentImportJob) error { j.Status = "processing"; return nil }); !errors.Is(err, ErrDocumentImportEnded) {
				t.Fatalf("job: %v", err)
			}
			if _, err := store.UpdatePage(ctx, job.ID, 1, func(p *DocumentImportPage) error { p.Status = "done"; return nil }); !errors.Is(err, ErrDocumentImportEnded) {
				t.Fatalf("page: %v", err)
			}
			if _, err := store.UpdatePages(ctx, job.ID, func(p []*DocumentImportPage) error { p[0].Status = "done"; return nil }); !errors.Is(err, ErrDocumentImportEnded) {
				t.Fatalf("pages: %v", err)
			}
			_ = store.SetRunnable(ctx, job.ID, true)
			ids, err := store.RunnableJobIDs(ctx)
			if err != nil || len(ids) != 0 {
				t.Fatalf("runnable=%v %v", ids, err)
			}
		})
	}
	for _, single := range []bool{false, true} {
		store := newDocumentImportTestStore(t)
		job := createSafetyJob(t, store, DocumentImportPage{PageNo: 1, Status: "pending", ExtractedBy: "ocr"})
		once := false
		cancel := func() {
			if !once {
				once = true
				if _, err := store.CancelOwned(ctx, 7, job.ID); err != nil {
					t.Fatal(err)
				}
			}
		}
		var err error
		if single {
			_, err = store.UpdatePage(ctx, job.ID, 1, func(p *DocumentImportPage) error { cancel(); p.Status = "done"; return nil })
		} else {
			_, err = store.UpdatePages(ctx, job.ID, func(p []*DocumentImportPage) error { cancel(); p[0].Status = "done"; return nil })
		}
		if !errors.Is(err, ErrDocumentImportEnded) {
			t.Fatalf("WATCH cancel: %v", err)
		}
		p, err := store.Page(ctx, job.ID, 1)
		if err != nil || p.Status != "pending" {
			t.Fatalf("旧结果覆盖取消: %+v %v", p, err)
		}
	}
}

func TestDocumentImportOCRTotalLimitIsAtomicAndIdempotent(t *testing.T) {
	ctx := context.Background()
	store := newDocumentImportTestStore(t)
	text, image := strings.Repeat("x", 2<<20), "uploads/7/a.png"
	var pages []DocumentImportPage
	for no := int32(1); no <= 7; no++ {
		pages = append(pages, DocumentImportPage{PageNo: no, Status: "done", ExtractedBy: "direct", Markdown: &text})
	}
	for no := int32(8); no <= 9; no++ {
		pages = append(pages, DocumentImportPage{PageNo: no, Status: "processing", ExtractedBy: "ocr", ImageKey: &image})
	}
	job := createSafetyJob(t, store, pages...)
	write := func(no int64) error {
		_, err := store.UpdatePage(ctx, job.ID, no, func(p *DocumentImportPage) error { p.Markdown, p.Status = &text, "done"; return nil })
		return err
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for no := int64(8); no <= 9; no++ {
		wg.Go(func() { errs <- write(no) })
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for repeat := 0; repeat < 2; repeat++ {
		pages, err := store.Pages(ctx, job.ID)
		if err != nil {
			t.Fatal(err)
		}
		total, failed := 0, 0
		for _, p := range pages {
			if p.Markdown != nil {
				total += len(*p.Markdown)
			}
			if p.Status == "failed" {
				failed++
				if p.Markdown != nil || p.Error == nil || !strings.Contains(*p.Error, "16MiB") {
					t.Fatalf("超限须明确失败: %+v", p)
				}
			}
		}
		if total != 16<<20 || failed != 1 {
			t.Fatalf("total=%d failed=%d", total, failed)
		}
		// 重复结果和显式重试均不得重复累计，也不得突破总量。
		if err := write(8); err != nil {
			t.Fatal(err)
		}
		if err := write(9); err != nil {
			t.Fatal(err)
		}
	}
}
