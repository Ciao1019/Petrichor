package taskqueue

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

func validateDocumentImportPages(pages []DocumentImportPage) error {
	if len(pages) < 1 || len(pages) > 1000 {
		return errors.New("导入页数必须在 1 到 1000 之间")
	}
	total := 0
	for i, page := range pages {
		if page.PageNo != int32(i+1) {
			return errors.New("导入页码必须从 1 开始连续递增")
		}
		if page.Markdown != nil {
			if len(*page.Markdown) > 2<<20 {
				return errors.New("单页 Markdown 超过 2MB")
			}
			total += len(*page.Markdown)
		}
	}
	if total > 16<<20 {
		return errors.New("Markdown 总量超过 16MB")
	}
	return nil
}

func documentImportPageFields(jobID int64, pages []DocumentImportPage, now time.Time) ([]any, error) {
	fields := make([]any, 0, len(pages)*2)
	for _, page := range pages {
		page.ID, page.JobID = int64(page.PageNo), jobID
		if page.Status == "" {
			page.Status = "pending"
		}
		if page.MaxAttempts <= 0 {
			page.MaxAttempts = documentImportDefaultTries
		}
		if page.NextAttemptAt.IsZero() {
			page.NextAttemptAt = now
		}
		if page.CreatedAt.IsZero() {
			page.CreatedAt = now
		}
		page.UpdatedAt = now
		normalizeDocumentImportPage(&page)
		data, err := json.Marshal(page)
		if err != nil {
			return nil, err
		}
		fields = append(fields, strconv.Itoa(int(page.PageNo)), data)
	}
	return fields, nil
}

// DocumentImportPagesReady：直接解析可立即成文；混合任务须等所有待识别页附图。
func DocumentImportPagesReady(pages []DocumentImportPage) bool {
	if len(pages) == 0 {
		return false
	}
	for _, page := range pages {
		if page.Status != "done" && (page.ExtractedBy == "direct" || page.ImageKey == nil || strings.TrimSpace(*page.ImageKey) == "") {
			return false
		}
	}
	return true
}

func normalizeDocumentImportPage(page *DocumentImportPage) {
	switch page.ExtractedBy {
	case "pdf":
		page.ExtractedBy = "direct"
	case "vision":
		page.ExtractedBy = "ocr"
		if page.Status == "done" {
			page.ExtractedBy = "multimodal"
		}
	}
	if page.MaxAttempts <= 0 {
		page.MaxAttempts = documentImportDefaultTries
	}
}
