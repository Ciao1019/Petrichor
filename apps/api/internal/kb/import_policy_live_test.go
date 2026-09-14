package kb

import (
	"context"
	"os"
	"strings"
	"testing"

	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

// 可选真实 PDF 验收：使用临时存储和内存 Redis，不写用户数据库、不调用外部模型。
func TestImagesOnlyPDFLive(t *testing.T) {
	input := os.Getenv("PETRICHOR_IMPORT_POLICY_PDF")
	if input == "" {
		t.Skip("未指定本地 PDF 样本")
	}
	data, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	store := importSafetyStore(t)
	ctx := context.Background()
	job := preparationTestJob(t, store, 3, taskqueue.ImagePolicyImagesOnly)
	if err := storage.SaveLocalObject(*job.SourceKey, data); err != nil {
		t.Fatal(err)
	}
	old := VisionChatInvoker
	t.Cleanup(func() { VisionChatInvoker = old })
	VisionChatInvoker = func(context.Context, int64, *int64, string, string, VisionImageInput) (string, error) {
		t.Fatal("仅图片策略不应调用模型")
		return "", nil
	}
	ready, err := prepareImportJob(ctx, store, job)
	if err != nil || !ready {
		t.Fatal(ready, err)
	}
	job, err = store.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := store.Pages(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := runImportWorkerPool(ctx, job, pages); err != nil {
		t.Fatal(err)
	}
	if err := validateImportFinalization(job, pages); err != nil {
		t.Fatal(err)
	}
	images := 0
	for _, page := range pages {
		if page.Status != "done" || page.AttemptCount != 0 {
			t.Fatalf("页面不应等待 OCR: %+v", page)
		}
		for _, asset := range page.Assets {
			images++
			if asset.Status != "skipped" || !storage.LocalObjectExists(asset.ImageKey) || !strings.Contains(derefStr(page.Markdown), "s4key:"+asset.ImageKey) {
				t.Fatalf("图片未保留: %+v", asset)
			}
		}
		if strings.Contains(derefStr(page.Markdown), "Why this works") {
			if len(page.Assets) == 0 {
				t.Fatal("样本标题页遗漏了图片")
			}
			t.Logf("第 %d 页：标题与图片共存，识别尝试为 0", page.PageNo)
		}
	}
	if images == 0 {
		t.Fatal("此验收需要包含图片的 PDF")
	}
	t.Logf("%d/%d 页完成，保留 %d 张图片，无图片识别调用", job.ProcessedPages, job.TotalPages, images)
}
