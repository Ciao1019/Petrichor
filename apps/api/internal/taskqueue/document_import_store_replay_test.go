package taskqueue

import (
	"context"
	"testing"
)

func TestDocumentImportAttachAndReplayPreserveCompletedPages(t *testing.T) {
	ctx := context.Background()
	store := newDocumentImportTestStore(t)
	markdown := "正文"
	job, err := store.Create(ctx, DocumentImportJob{UserID: 7, KnowledgeBaseID: 9, FileName: "a.pdf", Title: "A"},
		DocumentImportPage{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &markdown},
		DocumentImportPage{PageNo: 2, Status: "pending", ExtractedBy: "ocr"})
	if err != nil {
		t.Fatal(err)
	}
	image := "uploads/7/page.png"
	if _, err := store.UpdatePages(ctx, job.ID, func(pages []*DocumentImportPage) error {
		pages[1].ImageKey = &image
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 || ids[0] != job.ID {
		t.Fatalf("附图必须同时提交补偿索引: %v %v", ids, err)
	}
	if _, err := store.UpdatePage(ctx, job.ID, 2, func(page *DocumentImportPage) error {
		page.Status = "dead_letter"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdatePages(ctx, job.ID, func(pages []*DocumentImportPage) error {
		for _, page := range pages {
			if page.Status == "dead_letter" {
				page.Status, page.AttemptCount = "pending", 0
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	pages, err := store.Pages(ctx, job.ID)
	if err != nil || pages[0].Status != "done" || *pages[0].Markdown != markdown || pages[1].Status != "pending" {
		t.Fatalf("重放不得抹去成功页: %+v %v", pages, err)
	}
	articleID := int64(42)
	for i := 0; i < 2; i++ {
		if _, err := store.UpdateJob(ctx, job.ID, func(current *DocumentImportJob) error {
			current.Status, current.ArticleID = "completed", &articleID
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	updated, err := store.Get(ctx, job.ID)
	if err != nil || *updated.ArticleID != articleID {
		t.Fatalf("成文结果丢失: %+v %v", updated, err)
	}
	ids, err = store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 0 {
		t.Fatalf("成文后必须移出补偿索引: %v %v", ids, err)
	}
}
