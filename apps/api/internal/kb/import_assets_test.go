package kb

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

func TestImportAssetsKeepHeadingImageAndIndependentFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "description", true: "recognition-failed"}[fail], func(t *testing.T) {
			store := importSafetyStore(t)
			ctx := context.Background()
			job := preparationTestJob(t, store, 5)
			claim, err := store.ClaimPreparation(ctx, job.ID, documentparse.DefaultConfig().Timeout)
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			path := filepath.Join(dir, "page.png")
			if err := os.WriteFile(path, safetyPNG(t), 0600); err != nil {
				t.Fatal(err)
			}
			base := "## Why this works 为什么这有效\n"
			var keys []string
			total := 0
			row, err := prepareImportPage(ctx, claim, dir, documentparse.Page{PageNo: 1, Markdown: &base, ImagePath: path, Assets: []documentparse.Asset{{ImagePath: path, Kind: "region", Anchor: "Why this works 为什么这有效", Bounds: [4]float64{0.1, 0.2, 0.8, 0.7}}}}, 1, &total, &keys)
			if err != nil {
				t.Fatal(err)
			}
			if len(keys) != 2 || row.Status != "pending" || !strings.Contains(*row.Markdown, "s4key:") || row.Assets[0].Placement != "anchor" {
				t.Fatalf("%+v", row)
			}
			if err := store.CommitPreparation(ctx, job.ID, claim.PrepareToken, []JobPageRow{row}); err != nil {
				t.Fatal(err)
			}
			// 提交响应丢失后的清理必须保护已引用的图片和预览。
			cleanupImportPreparationImages(ctx, store, claim, keys)
			cleanupImportPreparationImages(ctx, store, claim, keys[1:])
			for _, key := range keys {
				if !storage.LocalObjectExists(key) {
					t.Fatal("图片被误删")
				}
			}
			old := classifyImportImage
			t.Cleanup(func() { classifyImportImage = old })
			calls := 0
			classifyImportImage = func(context.Context, *JobRow, taskqueue.DocumentImportAsset) (imageClassification, error) {
				calls++
				if fail {
					return imageClassification{}, errors.New("provider secret must not be persisted")
				}
				return imageClassification{ContentType: "photo", Description: "一袋酸奶的照片。"}, nil
			}
			if err := transcribePageBackground(ctx, job, 1, *row.ImageKey); err != nil {
				t.Fatal(err)
			}
			page, err := store.Page(ctx, job.ID, 1)
			if err != nil || page.Status != "done" || page.BaseMarkdown == nil || !strings.Contains(*page.Markdown, "Why this works") || !strings.Contains(*page.Markdown, "s4key:"+page.Assets[0].ImageKey) {
				t.Fatalf("%+v %v", page, err)
			}
			if fail && (page.Assets[0].Status != "failed" || strings.Contains(page.Assets[0].Error, "secret")) {
				t.Fatal(page.Assets)
			}
			if !fail && (!strings.Contains(*page.Markdown, "一袋酸奶") || page.Assets[0].Recognition != "describe") {
				t.Fatal(page.Assets)
			}
			if err := transcribePageBackground(ctx, job, 1, *row.ImageKey); err != nil || calls != 1 {
				t.Fatalf("成功页重复调用: %d %v", calls, err)
			}
		})
	}
}

func TestScreenshotUsesMultimodalAndResumesCompletedAssets(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	key := "uploads/7/screenshot.png"
	if err := storage.SaveLocalObject(key, safetyPNG(t)); err != nil {
		t.Fatal(err)
	}
	base := "# 正文"
	assets := []taskqueue.DocumentImportAsset{
		{ID: "image-1", ImageKey: key, Kind: "region", Placement: "page", Status: "done", Recognition: "describe", Markdown: "已有描述", Method: "multimodal"},
		{ID: "image-2", ImageKey: key, Kind: "region", Placement: "page", Status: "pending"},
	}
	job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "pending", ExtractedBy: "ocr", BaseMarkdown: &base, ImageKey: &key, Assets: assets})
	multiCalls, classifyCalls := 0, 0
	oldInvoker, oldClassifier := VisionChatInvoker, classifyImportImage
	t.Cleanup(func() { VisionChatInvoker = oldInvoker; classifyImportImage = oldClassifier })
	VisionChatInvoker = func(context.Context, int64, *int64, string, string, VisionImageInput) (string, error) {
		multiCalls++
		return "截图里的文字", nil
	}
	classifyImportImage = func(context.Context, *JobRow, taskqueue.DocumentImportAsset) (imageClassification, error) {
		classifyCalls++
		return imageClassification{ContentType: "screenshot"}, nil
	}
	if err := transcribePageBackground(ctx, job, 1, key); err != nil {
		t.Fatal(err)
	}
	page, _ := store.Page(ctx, job.ID, 1)
	if page.Status != "done" || multiCalls != 1 || classifyCalls != 1 || page.Assets[1].Method != "multimodal" || !strings.Contains(*page.Markdown, "已有描述") || !strings.Contains(*page.Markdown, "截图里的文字") || strings.Count(*page.Markdown, "s4key:"+key) != 2 {
		t.Fatalf("page=%+v multimodal=%d classify=%d", page, multiCalls, classifyCalls)
	}
}

func TestImportAssetScanKeepsOriginalAndDoesNotClassify(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	key := "uploads/7/scan.png"
	if err := storage.SaveLocalObject(key, safetyPNG(t)); err != nil {
		t.Fatal(err)
	}
	asset := taskqueue.DocumentImportAsset{ID: "image-1", ImageKey: key, Kind: "page", Status: "pending", Placement: "page"}
	job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "pending", ExtractedBy: "ocr", ImageKey: &key, Assets: []taskqueue.DocumentImportAsset{asset}})
	old := VisionChatInvoker
	t.Cleanup(func() { VisionChatInvoker = old })
	VisionChatInvoker = func(_ context.Context, _ int64, _ *int64, system, _ string, _ VisionImageInput) (string, error) {
		if system != documentVisionSystemPrompt {
			t.Fatal("扫描页不应先做图片分类")
		}
		return "# 扫描正文", nil
	}
	if err := transcribePageBackground(ctx, job, 1, key); err != nil {
		t.Fatal(err)
	}
	page, _ := store.Page(ctx, job.ID, 1)
	if page.Status != "done" || page.Assets[0].Recognition != "ocr" || !strings.Contains(*page.Markdown, "# 扫描正文") || !strings.Contains(*page.Markdown, "s4key:"+key) {
		t.Fatalf("%+v", page)
	}
}

func TestImportAssetAnchorsKeepOrderWithoutDuplicatePagePreview(t *testing.T) {
	base := "# 标题\n\n段落\n\n结尾"
	preview := "uploads/7/preview.png"
	page := JobPageRow{PageNo: 8, BaseMarkdown: &base, ImageKey: &preview, Assets: []taskqueue.DocumentImportAsset{
		{ID: "image-1", Kind: "region", Placement: "anchor", Anchor: "标题", ImageKey: "uploads/7/a.png"},
		{ID: "image-2", Kind: "region", Placement: "anchor", Anchor: "标题", ImageKey: "uploads/7/b.png"},
		{ID: "image-3", Kind: "region", Placement: "page", ImageKey: "uploads/7/c.png"},
	}}
	for _, policy := range []string{taskqueue.ImagePolicyKeepAndRecognize, taskqueue.ImagePolicyImagesOnly} {
		text := assembleImportAssets(&page, policy)
		if strings.Index(text, "a.png") > strings.Index(text, "b.png") || strings.Index(text, "b.png") > strings.Index(text, "段落") || strings.Contains(text, "原页预览") || strings.Contains(text, "preview.png") || strings.Count(text, "![") != 3 {
			t.Fatal(text)
		}
		if page.ImageKey == nil || *page.ImageKey != preview {
			t.Fatal("校对预览应继续保存在任务详情")
		}
	}
	for _, text := range []string{"# 重复\n重复", "| 重复 |", "```\n重复\n```"} {
		if uniqueAnchorEnd(text, "重复") >= 0 {
			t.Fatalf("错误锚点: %q", text)
		}
	}
}

func TestImageClassificationRejectsInventedTypesAndEmptyDescriptions(t *testing.T) {
	for _, raw := range []string{`{"contentType":"photo","description":""}`, `{"contentType":"other","description":"x"}`, `not json`} {
		if _, err := parseImageClassification(raw); err == nil {
			t.Fatal(raw)
		}
	}
	if value, err := parseImageClassification("```json\n{\"contentType\":\"screenshot\",\"description\":\"\"}\n```"); err != nil || value.ContentType != "screenshot" {
		t.Fatal(value, err)
	}
}

func TestImageRecognitionQuotaErrorIsSafeAndNotRetryable(t *testing.T) {
	err := &httpx.HttpError{Status: 502, Message: `模型调用失败(401)：{"error":{"type":"CreditsError","message":"Insufficient balance. private billing URL"}}`}
	code, retry := safeImportOCRError(err)
	if code != "quota_exceeded" || retry {
		t.Fatal(code, retry)
	}
}
