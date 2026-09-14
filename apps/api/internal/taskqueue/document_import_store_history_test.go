package taskqueue

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestDocumentImportHistoricalSizeUsesActualPages(t *testing.T) {
	ctx := context.Background()
	store := newDocumentImportTestStore(t)
	text, imageKey := strings.Repeat("x", 2<<20), "uploads/7/a.png"
	var pages []DocumentImportPage
	for no := int32(1); no <= 8; no++ {
		pages = append(pages, DocumentImportPage{PageNo: no, Status: "done", ExtractedBy: "direct", Markdown: &text})
	}
	pages = append(pages, DocumentImportPage{PageNo: 9, Status: "pending", ExtractedBy: "ocr", ImageKey: &imageKey})
	job := createSafetyJob(t, store, pages...)
	// 模拟历史记录，没有额外计数字段，且已有正文超过现行上限。
	page, err := store.Page(ctx, job.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	legacy := text + "x"
	page.Markdown = &legacy
	raw, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.redis.HSet(ctx, documentImportPagesKey(job.ID), "1", raw).Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdatePage(ctx, job.ID, 9, func(p *DocumentImportPage) error { p.Status = "processing"; return nil }); err != nil {
		t.Fatal(err)
	}
	answer := "new"
	updated, err := store.UpdatePage(ctx, job.ID, 9, func(p *DocumentImportPage) error { p.Status, p.Markdown = "done", &answer; return nil })
	if err != nil || updated.Status != "failed" || updated.Markdown != nil {
		t.Fatalf("%+v %v", updated, err)
	}
	if _, err := store.UpdatePage(ctx, job.ID, 1, func(p *DocumentImportPage) error { p.Markdown = nil; return nil }); err != nil {
		t.Fatal(err)
	}
	page, err = store.Page(ctx, job.ID, 1)
	if err != nil || page.Markdown == nil || len(*page.Markdown) != len(legacy) {
		t.Fatal("历史成功正文不得静默截断")
	}
	// 旧的 missing-image/terminal 快照不能删除刚附图/显式重试产生的 runnable。
	if err := store.SetRunnable(ctx, job.ID, false); err != nil {
		t.Fatal(err)
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 {
		t.Fatalf("runnable=%v %v", ids, err)
	}
}
