package taskqueue

import (
	"context"
	"errors"
	"testing"
)

func TestDocumentImportAtomicCreateAndLegacyDecode(t *testing.T) {
	store := newDocumentImportTestStore(t)
	ctx := context.Background()
	markdown := ""
	job, err := store.Create(ctx, DocumentImportJob{UserID: 7, KnowledgeBaseID: 9, FileName: "a.docx", SourceType: "docx", Title: "A"}, DocumentImportPage{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &markdown})
	if err != nil {
		t.Fatal(err)
	}
	pages, err := store.Pages(ctx, job.ID)
	if err != nil || len(pages) != 1 || job.TotalPages != 1 || job.ProcessedPages != 1 || job.Status != "processing" || job.PageUnit != "document" || job.SourceType != "docx" {
		t.Fatalf("job=%+v pages=%+v err=%v", job, pages, err)
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 || ids[0] != job.ID {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	if _, err := store.GetOwned(ctx, 8, job.ID); !errors.Is(err, ErrDocumentImportNotFound) {
		t.Fatalf("owner err=%v", err)
	}
	mixed, err := store.Create(ctx, DocumentImportJob{UserID: 7, KnowledgeBaseID: 9, FileName: "a.pdf", Title: "B"}, DocumentImportPage{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &markdown}, DocumentImportPage{PageNo: 2, Status: "pending", ExtractedBy: "ocr"})
	if err != nil {
		t.Fatal(err)
	}
	ids, err = store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 {
		t.Fatalf("缺图任务不得入队 ids=%v err=%v", ids, err)
	}
	if err := store.SavePages(ctx, mixed.ID, []DocumentImportPage{{PageNo: 1}}); err == nil {
		t.Fatal("不得覆盖已有页")
	}
	if _, err := store.Create(ctx, DocumentImportJob{UserID: 7, KnowledgeBaseID: 9, FileName: "bad.pdf", Title: "C"}, DocumentImportPage{PageNo: 2}); err == nil {
		t.Fatal("页码非法")
	}
	_, total, err := store.List(ctx, 7, nil, 0, 10)
	if err != nil || total != 2 {
		t.Fatalf("非法 create 不得留下半成品 total=%d err=%v", total, err)
	}
	legacy, err := decodeDocumentImportJob([]byte(`{"id":1,"userId":7,"knowledgeBaseId":9,"sourceType":"pdf"}`))
	if err != nil || legacy.PageUnit != "page" {
		t.Fatalf("%+v %v", legacy, err)
	}
	for _, tc := range []struct{ raw, want string }{
		{`{"jobId":1,"pageNo":1,"extractedBy":"pdf","status":"done"}`, "direct"},
		{`{"jobId":1,"pageNo":1,"extractedBy":"vision","status":"done"}`, "multimodal"},
		{`{"jobId":1,"pageNo":1,"extractedBy":"vision","status":"failed"}`, "ocr"},
	} {
		page, err := decodeDocumentImportPage([]byte(tc.raw))
		if err != nil || page.ExtractedBy != tc.want || page.MaxAttempts != 5 {
			t.Fatalf("%+v %v", page, err)
		}
	}
}

func TestDocumentImportSavePagesTotalsAndReadiness(t *testing.T) {
	ctx := context.Background()
	store := newDocumentImportTestStore(t)
	job, err := store.Create(ctx, DocumentImportJob{UserID: 1, KnowledgeBaseID: 2, FileName: "a.pdf", Title: "A"})
	if err != nil {
		t.Fatal(err)
	}
	pages := []DocumentImportPage{{PageNo: 1, Status: "done", ExtractedBy: "direct"}}
	if err := store.SavePages(ctx, job.ID, pages); err != nil {
		t.Fatal(err)
	}
	job, err = store.Get(ctx, job.ID)
	if err != nil || job.TotalPages != 1 || job.ProcessedPages != 1 || job.ArticleID != nil || job.Status == "completed" {
		t.Fatalf("%+v %v", job, err)
	}
	if DocumentImportPagesReady(nil) || DocumentImportPagesReady([]DocumentImportPage{{Status: "pending", ExtractedBy: "ocr"}}) || !DocumentImportPagesReady(pages) {
		t.Fatal("runnable 判定错误")
	}
	image := "uploads/1/1.png"
	if !DocumentImportPagesReady([]DocumentImportPage{{Status: "pending", ExtractedBy: "ocr", ImageKey: &image}}) {
		t.Fatal("附图后应可运行")
	}
}
