package kb

import (
	"context"
	"testing"
	"time"

	"petrichor/api/internal/storage"
)

func TestImportClaimImageAndAttemptFence(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	imageKey := "uploads/7/current.png"
	if err := storage.SaveLocalObject(imageKey, safetyPNG(t)); err != nil {
		t.Fatal(err)
	}
	job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "pending", ExtractedBy: "ocr", ImageKey: &imageKey})
	old := VisionChatInvoker
	defer func() { VisionChatInvoker = old }()
	calls := 0
	newAttempt := time.Now().Add(time.Hour).UTC()
	VisionChatInvoker = func(context.Context, int64, *int64, string, string, VisionImageInput) (string, error) {
		calls++
		// 模拟用户重试后另一 Worker 已领取新一轮，计数仍为 1，时间 fence 必须生效。
		if _, err := mutateImportRetry(ctx, store, job.ID, true, func(pages []*JobPageRow) error { resetDocumentImportPage(pages[0]); return nil }); err != nil {
			t.Fatal(err)
		}
		if _, err := store.UpdatePage(ctx, job.ID, 1, func(p *JobPageRow) error {
			p.Status, p.AttemptCount, p.NextAttemptAt = "processing", 1, newAttempt
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return "过期结果", nil
	}
	if err := transcribePageBackground(ctx, job, 1, "uploads/7/stale.png"); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("旧图片不得领取并调用模型")
	}
	if err := transcribePageBackground(ctx, job, 1, imageKey); err != nil {
		t.Fatal(err)
	}
	page, err := store.Page(ctx, job.ID, 1)
	if err != nil || calls != 1 || page.Status != "processing" || page.Markdown != nil || !page.NextAttemptAt.Equal(newAttempt) {
		t.Fatalf("旧结果越过 attempt fence: %+v calls=%d err=%v", page, calls, err)
	}
}
