package kb

import (
	"strings"
	"testing"
)

func TestImportFinalizationMarkdownTotalBoundary(t *testing.T) {
	text := strings.Repeat("x", maxImportPageMarkdownBytes)
	var pages []JobPageRow
	for no := int32(1); no <= 8; no++ {
		pages = append(pages, JobPageRow{PageNo: no, Status: "done", Markdown: &text})
	}
	job := &JobRow{TotalPages: 8}
	if err := validateImportFinalization(job, pages); err != nil {
		t.Fatal(err)
	}
	extra := "x"
	pages = append(pages, JobPageRow{PageNo: 9, Status: "done", Markdown: &extra})
	job.TotalPages++
	if err := validateImportFinalization(job, pages); err == nil {
		t.Fatal("最终合并仍须拒绝历史超限正文")
	}
}

func TestImportFinalizationRequiresCompleteSuccessfulPages(t *testing.T) {
	job := &JobRow{TotalPages: 2, Status: "processing"}
	for _, pages := range [][]JobPageRow{
		nil,
		{{PageNo: 1, Status: "done"}},
		{{PageNo: 1, Status: "done"}, {PageNo: 2, Status: "pending"}},
		{{PageNo: 1, Status: "done"}, {PageNo: 2, Status: "failed"}},
		{{PageNo: 1, Status: "done"}, {PageNo: 3, Status: "done"}},
	} {
		if err := validateImportFinalization(job, pages); err == nil {
			t.Fatalf("不完整任务不得成文: %+v", pages)
		}
	}
	pages := []JobPageRow{{PageNo: 1, Status: "done"}, {PageNo: 2, Status: "done"}}
	if err := validateImportFinalization(job, pages); err != nil {
		t.Fatal(err)
	}
	job.Status = deriveJobStatus(pages)
	reservedID := int64(42)
	job.PendingArticleID = &reservedID
	if documentImportJobTerminal(job) {
		t.Fatal("预留 ID 或页完成不能提前终结任务")
	}
	// 历史 completed 只能由显式 finalize 幂等修复，后台进度不能回退终态。
	job.Status = "completed"
	if !documentImportJobTerminal(job) {
		t.Fatal("后台不得回退历史 completed")
	}
	job.ArticleID = &reservedID
	if !documentImportJobTerminal(job) {
		t.Fatal("文章成功创建后任务应结束")
	}
}
