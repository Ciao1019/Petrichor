package kb

import (
	"bytes"
	"context"
	"image"
	"io"
	"os"
	"path/filepath"
	"strings"

	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

func prepareImportPage(ctx context.Context, job *JobRow, workDir string, page documentparse.Page, expected int, totalMarkdown *int, imageKeys *[]string) (JobPageRow, error) {
	row := JobPageRow{PageNo: int32(page.PageNo)}
	if err := ctx.Err(); err != nil {
		return row, err
	}
	if page.PageNo != expected || page.PageNo > maxImportPages || (job.SourceType != "pdf" && page.PageNo != 1) {
		return row, taskqueue.ErrDocumentImportPreparePlan
	}
	if job.ImagePolicy == taskqueue.ImagePolicyImagesOnly && page.Markdown == nil && len(page.Assets) == 0 {
		page.Assets = []documentparse.Asset{{ImagePath: page.ImagePath, Kind: "page", Bounds: [4]float64{0, 0, 1, 1}}}
	}
	if len(page.Assets) > 0 {
		return prepareImportAssets(ctx, job, workDir, page, totalMarkdown, imageKeys)
	}
	if page.Markdown != nil {
		if page.ImagePath != "" || len(*page.Markdown) > maxImportPageMarkdownBytes || *totalMarkdown+len(*page.Markdown) > maxImportMarkdownBytes {
			return row, taskqueue.ErrDocumentImportPreparePlan
		}
		text := *page.Markdown // 回调后解析器可以复用其输出对象。
		if job.SourceType == "pdf" && job.ImagePolicy == taskqueue.ImagePolicyTextOnly {
			text = importTextWithoutImages(text)
		}
		*totalMarkdown += len(text)
		row.Status, row.ExtractedBy, row.Markdown = "done", "direct", &text
		return row, nil
	}
	data, err := readPreparedImage(ctx, workDir, page.ImagePath)
	if err != nil {
		return row, err
	}
	key := taskqueue.DocumentImportPageImageKey(job.UserID, job.ID, job.PrepareToken, row.PageNo)
	// PUT 可能已落盘但响应丢失/父取消，发起前即记录本 token 的清理候选。
	*imageKeys = append(*imageKeys, key)
	if err := storage.WriteObjectBounded(ctx, key, data, "image/png", maxImportImageBytes); err != nil {
		return row, err
	}
	row.Status, row.ExtractedBy, row.ImageKey = "pending", "ocr", &key
	return row, nil
}

func readPreparedImage(ctx context.Context, workDir, imagePath string) ([]byte, error) {
	root, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(imagePath)
	if err != nil {
		return nil, taskqueue.ErrDocumentImportPreparePlan
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil, taskqueue.ErrDocumentImportPreparePlan
	}
	file, err := os.Open(resolved)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxImportImageBytes {
		return nil, taskqueue.ErrDocumentImportPreparePlan
	}
	data, err := io.ReadAll(io.LimitReader(importImageReader{ctx, file}, maxImportImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxImportImageBytes {
		return nil, storage.ErrObjectTooLarge
	}
	cfg, kind, err := image.DecodeConfig(importImageReader{ctx, bytes.NewReader(data)})
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil || kind != "png" || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 24_000_000 {
		return nil, taskqueue.ErrDocumentImportPreparePlan
	}
	if _, _, err := image.Decode(importImageReader{ctx, bytes.NewReader(data)}); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, taskqueue.ErrDocumentImportPreparePlan
	}
	return data, ctx.Err()
}
