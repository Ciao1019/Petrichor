package kb

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

func TestImportImagePoliciesAcrossPreparationAndWorker(t *testing.T) {
	for _, policy := range []string{taskqueue.ImagePolicyImagesOnly, taskqueue.ImagePolicyTextOnly} {
		for _, scan := range []bool{false, true} {
			t.Run(policy+map[bool]string{false: "/mixed", true: "/scan"}[scan], func(t *testing.T) {
				store := importSafetyStore(t)
				ctx := context.Background()
				job := preparationTestJob(t, store, 3, policy)
				claim, err := store.ClaimPreparation(ctx, job.ID, time.Minute)
				if err != nil {
					t.Fatal(err)
				}
				dir := t.TempDir()
				path := filepath.Join(dir, "page.png")
				if err := os.WriteFile(path, safetyPNG(t), 0600); err != nil {
					t.Fatal(err)
				}
				base := "## Why this works 为什么这有效\n\n原生正文"
				page := documentparse.Page{PageNo: 1, Markdown: &base, ImagePath: path,
					Assets: []documentparse.Asset{{ImagePath: path, Kind: "region", Anchor: "Why this works 为什么这有效"}}}
				if scan {
					page.Markdown = nil
					page.Assets[0].Kind = "page"
				}
				var keys []string
				total := 0
				row, err := prepareImportPage(ctx, claim, dir, page, 1, &total, &keys)
				if err != nil {
					t.Fatal(err)
				}
				if err := store.CommitPreparation(ctx, job.ID, claim.PrepareToken, []JobPageRow{row}); err != nil {
					t.Fatal(err)
				}
				oldVision, oldClassifier := VisionChatInvoker, classifyImportImage
				t.Cleanup(func() { VisionChatInvoker = oldVision; classifyImportImage = oldClassifier })
				calls := 0
				classifyImportImage = func(context.Context, *JobRow, taskqueue.DocumentImportAsset) (imageClassification, error) {
					t.Fatal("此策略不得做图片分类或描述")
					return imageClassification{}, nil
				}
				VisionChatInvoker = func(_ context.Context, _ int64, _ *int64, system, _ string, _ VisionImageInput) (string, error) {
					calls++
					if policy == taskqueue.ImagePolicyImagesOnly || system != documentTextOnlySystemPrompt {
						t.Fatal("错误调用识别服务")
					}
					return "图片可见文字", nil
				}
				if err := transcribePageBackground(ctx, job, 1, *row.ImageKey); err != nil {
					t.Fatal(err)
				}
				saved, err := store.Page(ctx, job.ID, 1)
				if err != nil || saved.Status != "done" {
					t.Fatalf("%+v %v", saved, err)
				}
				if !scan && !strings.Contains(*saved.Markdown, "原生正文") {
					t.Fatal("原生正文丢失")
				}
				if policy == taskqueue.ImagePolicyImagesOnly {
					if calls != 0 || saved.AttemptCount != 0 || saved.Assets[0].Status != "skipped" || !strings.Contains(*saved.Markdown, "s4key:") {
						t.Fatalf("%+v calls=%d", saved, calls)
					}
				} else {
					if calls != 1 || len(keys) != 1 || !strings.Contains(keys[0], "/document-import/") || strings.Contains(*saved.Markdown, "s4key:") || !strings.Contains(*saved.Markdown, "图片可见文字") {
						t.Fatalf("%+v calls=%d keys=%v", saved, calls, keys)
					}
					if storage.LocalObjectExists(keys[0]) {
						t.Fatal("仅文字页完成后未清理临时图片")
					}
				}
				if err := transcribePageBackground(ctx, job, 1, *row.ImageKey); err != nil {
					t.Fatal(err)
				}
				if calls > 1 {
					t.Fatal("已完成页重复识别")
				}
			})
		}
	}
}

func TestTextOnlyEmptyImageAndFailedOCR(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "no-visible-text", true: "failed"}[fail], func(t *testing.T) {
			store := importSafetyStore(t)
			ctx := context.Background()
			key := "uploads/7/image.png"
			if err := storage.SaveLocalObject(key, safetyPNG(t)); err != nil {
				t.Fatal(err)
			}
			base := "原生正文"
			job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "pending", ExtractedBy: "ocr", ImageKey: &key, BaseMarkdown: &base,
				Assets: []taskqueue.DocumentImportAsset{{ID: "image-1", ImageKey: key, Kind: "region", Status: "pending"}}})
			job.ImagePolicy = taskqueue.ImagePolicyTextOnly
			old := VisionChatInvoker
			t.Cleanup(func() { VisionChatInvoker = old })
			VisionChatInvoker = func(context.Context, int64, *int64, string, string, VisionImageInput) (string, error) {
				if fail {
					return "", errors.New("recognition unavailable")
				}
				return "[NO_VISIBLE_TEXT]", nil
			}
			if err := transcribePageBackground(ctx, job, 1, key); err != nil {
				t.Fatal(err)
			}
			page, _ := store.Page(ctx, job.ID, 1)
			if (page.Status == "done") == fail || strings.Contains(derefStr(page.Markdown), "s4key:") {
				t.Fatalf("%+v", page)
			}
			if !fail && derefStr(page.Markdown) != base {
				t.Fatal(page.Markdown)
			}
		})
	}
}

func TestImportImagePolicyInput(t *testing.T) {
	for _, policy := range []string{"keep_and_recognize", "text_only", "images_only"} {
		value, err := parseImportImagePolicy(map[string]any{"imagePolicy": policy})
		if err != nil || value != policy {
			t.Fatal(value, err)
		}
	}
	if value, err := parseImportImagePolicy(nil); err != nil || value != "keep_and_recognize" {
		t.Fatal(value, err)
	}
	for _, invalid := range []any{"", "other", nil, 1} {
		if _, err := parseImportImagePolicy(map[string]any{"imagePolicy": invalid}); err == nil {
			t.Fatal(invalid)
		}
	}
}

func TestTextOnlyRemovesReturnedImages(t *testing.T) {
	text := importTextWithoutImages("正文\n![可见文字](https://example.test/a.png)\n![引用][ref]\n<img src='a.png'>\n| A | B |")
	if strings.Contains(text, "![") || strings.Contains(text, "<img") || !strings.Contains(text, "| A | B |") {
		t.Fatal(text)
	}
}
