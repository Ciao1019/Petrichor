package kb

import (
	"context"
	"errors"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
	"strings"
	"testing"
	"time"
)

func TestImportOCROnlyOneModelAttempt(t *testing.T) {
	for _, tc := range []struct {
		name, answer, code string
		err                error
		retryable          bool
	}{
		{name: "success", answer: "```markdown\n# 正文\n```"},
		{name: "unconfigured", code: "not_configured", err: &importRecognitionError{Code: "not_configured"}},
		{name: "unauthorized", code: "unauthorized", err: &httpx.HttpError{Status: 401, Message: "secret"}},
		{name: "credits", code: "quota_exceeded", err: &httpx.HttpError{Status: 502, Message: `模型调用失败(401)：{"error":{"type":"CreditsError","message":"secret"}}`}},
		{name: "rate_limit", code: "rate_limited", err: &httpx.HttpError{Status: 429, Message: "secret"}, retryable: true},
		{name: "network", code: "upstream_error", err: errors.New("secret"), retryable: true},
		{name: "empty", code: "empty_result", answer: " \n", retryable: true},
		{name: "large", code: "result_too_large", answer: strings.Repeat("a", maxImportPageMarkdownBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			result, err := recognizeImportOCR(context.Background(), time.Second, false, func(context.Context) (string, error) { calls++; return tc.answer, tc.err })
			if calls != 1 {
				t.Fatalf("一次页尝试调用了 %d 次模型", calls)
			}
			if tc.code == "" {
				if err != nil || result.Method != "multimodal" || result.Markdown != "# 正文" {
					t.Fatal(result, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.code) || strings.Contains(err.Error(), "secret") || result.Method != "ocr" || workerErrorRetryable(err) != tc.retryable {
				t.Fatal(result, err)
			}
			code, retryable := safeImportOCRError(err)
			if code != tc.code || retryable != tc.retryable {
				t.Fatal(code, retryable)
			}
		})
	}
}

func TestImportOCRCancellationTimeoutAndNoVisibleText(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	_, err := recognizeImportOCR(ctx, time.Second, false, func(context.Context) (string, error) { calls++; return "正文", nil })
	if !errors.Is(err, context.Canceled) || calls != 0 {
		t.Fatal(calls, err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	_, err = recognizeImportOCR(ctx, time.Second, false, func(context.Context) (string, error) { cancel(); return "正文", nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	_, err = recognizeImportOCR(context.Background(), time.Millisecond, false, func(ctx context.Context) (string, error) { <-ctx.Done(); return "正文", nil })
	if err == nil || !strings.Contains(err.Error(), "timeout") || !workerErrorRetryable(err) {
		t.Fatal(err)
	}
	result, err := recognizeImportOCR(context.Background(), time.Second, true, func(context.Context) (string, error) { return "[NO_VISIBLE_TEXT]", nil })
	if err != nil || result.Markdown != "" || result.Method != "multimodal" {
		t.Fatal(result, err)
	}
}

func TestImportOCRInvokerAndDirectPageBoundary(t *testing.T) {
	store := importSafetyStore(t)
	key := "uploads/7/ocr.png"
	if err := storage.SaveLocalObject(key, safetyPNG(t)); err != nil {
		t.Fatal(err)
	}
	body := "# 原生正文"
	job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &body})
	old := VisionChatInvoker
	t.Cleanup(func() { VisionChatInvoker = old })
	calls := 0
	VisionChatInvoker = func(_ context.Context, userID int64, _ *int64, system, _ string, image VisionImageInput) (string, error) {
		calls++
		if userID != 7 || system != documentVisionSystemPrompt || image.MIMEType != "image/png" || len(image.Data) == 0 {
			t.Fatal("模型输入错误")
		}
		return "# 图片正文", nil
	}
	if err := transcribePageBackground(context.Background(), job, 1, key); err != nil || calls != 0 {
		t.Fatal(calls, err)
	}
	result, err := convertImportPage(context.Background(), job, key)
	if err != nil || calls != 1 || result.Method != "multimodal" {
		t.Fatal(calls, result, err)
	}
	VisionChatInvoker = nil
	_, err = convertImportPage(context.Background(), job, key)
	if err == nil || !strings.Contains(err.Error(), "not_configured") || workerErrorRetryable(err) {
		t.Fatal(err)
	}
}

func TestImportStatsAndRetryPreserveSuccessfulMethods(t *testing.T) {
	pages := []JobPageRow{{PageNo: 1, Status: "done", ExtractedBy: "direct"}, {PageNo: 2, Status: "done", ExtractedBy: "multimodal"}, {PageNo: 3, Status: "failed", ExtractedBy: "ocr"}}
	stats := buildPageStats(pages)
	if stats.donePages != 2 || stats.directPages != 1 || stats.multimodalPages != 1 {
		t.Fatal(stats)
	}
	resetDocumentImportPage(&pages[0])
	resetDocumentImportPage(&pages[2])
	applyImportOCRResult(&pages[2], importOCRResult{Method: "multimodal"})
	pages[2].Status = "done"
	stats = buildPageStats(pages)
	if stats.donePages != 3 || stats.directPages+stats.multimodalPages != stats.donePages {
		t.Fatal(stats)
	}
	if deriveJobStatus(pages) != "processing" {
		t.Fatal("成文前不能 completed")
	}
	job := &JobRow{Status: deriveJobStatus(pages), PendingArticleID: new(int64)}
	if documentImportJobTerminal(job) {
		t.Fatal("预留文章 ID 不代表成文")
	}
	articleID := int64(7)
	job.ArticleID = &articleID
	job.Status = "completed"
	if !documentImportJobTerminal(job) {
		t.Fatal("文章成功后应结束")
	}
}
