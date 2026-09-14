package kb

import (
	"context"
	"fmt"
	"strings"

	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

func prepareImportAssets(ctx context.Context, job *JobRow, workDir string, page documentparse.Page, total *int, keys *[]string) (JobPageRow, error) {
	row := JobPageRow{PageNo: int32(page.PageNo), Status: "pending", ExtractedBy: "ocr"}
	textOnly := job.ImagePolicy == taskqueue.ImagePolicyTextOnly
	imagesOnly := job.ImagePolicy == taskqueue.ImagePolicyImagesOnly
	if page.Markdown != nil {
		text := *page.Markdown
		if textOnly {
			text = importTextWithoutImages(text)
		}
		row.BaseMarkdown = &text
	}
	if len(page.Assets) > 32 || page.ImagePath == "" {
		return row, taskqueue.ErrDocumentImportPreparePlan
	}
	write := func(path, key string) error {
		data, err := readPreparedImage(ctx, workDir, path)
		if err != nil {
			return err
		}
		*keys = append(*keys, key)
		return storage.WriteObjectBounded(ctx, key, data, "image/png", maxImportImageBytes)
	}
	if !textOnly {
		preview := taskqueue.DocumentImportPreviewKey(job.UserID, job.ID, job.PrepareToken, row.PageNo)
		if err := write(page.ImagePath, preview); err != nil {
			return row, err
		}
		row.ImageKey = &preview
	}
	for i, asset := range page.Assets {
		key := taskqueue.DocumentImportAssetKey(job.UserID, job.ID, job.PrepareToken, row.PageNo, i+1)
		if textOnly {
			key = taskqueue.DocumentImportOCRAssetKey(job.UserID, job.ID, job.PrepareToken, row.PageNo, i+1)
			if i == 0 {
				row.ImageKey = &key
			}
		}
		if err := write(asset.ImagePath, key); err != nil {
			return row, err
		}
		placement := "page"
		if asset.Kind == "region" && uniqueAnchorEnd(derefStr(page.Markdown), asset.Anchor) >= 0 {
			placement = "anchor"
		}
		status := "pending"
		if imagesOnly {
			status = "skipped"
		}
		row.Assets = append(row.Assets, taskqueue.DocumentImportAsset{ID: fmt.Sprintf("image-%d", i+1), ImageKey: key, Kind: asset.Kind, Anchor: asset.Anchor, Bounds: asset.Bounds, Placement: placement, Status: status})
	}
	if imagesOnly {
		row.Status, row.ExtractedBy = "done", "direct"
	}
	text := assembleImportAssets(&row, job.ImagePolicy)
	if len(text) > maxImportPageMarkdownBytes || *total+len(text) > maxImportMarkdownBytes {
		return row, taskqueue.ErrDocumentImportPreparePlan
	}
	*total += len(text)
	row.Markdown = &text
	return row, nil
}

// 只有能唯一匹配完整行时才定位。表格、代码和歧义位置按页保留，不破坏 Markdown 结构。
func uniqueAnchorEnd(markdown, anchor string) int {
	if anchor == "" || strings.Count(markdown, anchor) != 1 {
		return -1
	}
	pos := strings.Index(markdown, anchor)
	start := strings.LastIndex(markdown[:pos], "\n") + 1
	end := strings.Index(markdown[pos:], "\n")
	if end < 0 {
		end = len(markdown)
	} else {
		end += pos
	}
	line := strings.TrimSpace(markdown[start:end])
	if strings.Contains(line, "|") || strings.HasPrefix(line, "```") || strings.Count(markdown[:start], "```")%2 != 0 || strings.TrimLeft(line, "# ") != anchor {
		return -1
	}
	return end
}

func assetMarkdown(page *JobPageRow, a taskqueue.DocumentImportAsset) string {
	label := fmt.Sprintf("第 %d 页图片 %s", page.PageNo, a.ID)
	if a.Kind == "page" {
		label = fmt.Sprintf("第 %d 页原页预览", page.PageNo)
	}
	text := "![" + label + "](s4key:" + a.ImageKey + ")"
	if a.Markdown != "" && page.BaseMarkdown != nil {
		if a.Recognition == "describe" {
			text += "\n\n> 图片说明：" + strings.ReplaceAll(strings.TrimSpace(a.Markdown), "\n", "\n> ")
		} else {
			text += "\n\n" + a.Markdown
		}
	}
	return text
}

func assembleImportAssets(page *JobPageRow, policy string) string {
	base := derefStr(page.BaseMarkdown)
	textOnly := policy == taskqueue.ImagePolicyTextOnly
	// 扫描页的 OCR 正文与原页图片同时存在；纯文字来源始终使用 anydoc 正文。
	if page.BaseMarkdown == nil && len(page.Assets) > 0 {
		base = page.Assets[0].Markdown
	}
	insertions := map[int][]string{}
	var tail []string
	for _, a := range page.Assets {
		text := assetMarkdown(page, a)
		if textOnly {
			// 扫描页正文已来自首张图片；避免再次追加同一份 OCR。
			if page.BaseMarkdown == nil {
				continue
			}
			text = a.Markdown
			if strings.TrimSpace(text) == "" {
				continue
			}
		}
		end := -1
		if a.Placement == "anchor" {
			end = uniqueAnchorEnd(base, a.Anchor)
		}
		if end >= 0 {
			insertions[end] = append(insertions[end], text)
		} else {
			tail = append(tail, text)
		}
	}
	var out strings.Builder
	for i := 0; i <= len(base); i++ {
		if additions := insertions[i]; len(additions) > 0 {
			out.WriteString("\n\n" + strings.Join(additions, "\n\n") + "\n")
		}
		if i < len(base) {
			out.WriteByte(base[i])
		}
	}
	if len(tail) > 0 {
		out.WriteString("\n\n" + strings.Join(tail, "\n\n"))
	}
	// 无法定位的区域按页放置即可；校对用整页预览只在任务详情展示，避免正文重复插图。
	// 扫描页或无法可靠裁切的整页 asset 仍在上面的循环保留，不丢失唯一图像内容。
	if textOnly {
		return importTextWithoutImages(out.String())
	}
	return strings.TrimSpace(out.String())
}
