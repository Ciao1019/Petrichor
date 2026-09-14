package taskqueue

import "fmt"

// 图片在准备阶段即持久保存；识别失败和任务过期均不删除正文资源。
type DocumentImportAsset struct {
	ID          string     `json:"id"`
	ImageKey    string     `json:"imageKey"`
	Kind        string     `json:"kind"`
	Bounds      [4]float64 `json:"bounds"`
	Anchor      string     `json:"anchor,omitempty"`
	Placement   string     `json:"placement"`
	Status      string     `json:"status"`
	ContentType string     `json:"contentType,omitempty"`
	Recognition string     `json:"recognition,omitempty"`
	Markdown    string     `json:"markdown,omitempty"`
	Method      string     `json:"method,omitempty"`
	Error       string     `json:"error,omitempty"`
}

func DocumentImportAssetKey(userID, jobID int64, token string, pageNo int32, index int) string {
	return fmt.Sprintf("uploads/%d/document-assets/%d/%s/page-%d-image-%d.png", userID, jobID, token, pageNo, index)
}

func DocumentImportPreviewKey(userID, jobID int64, token string, pageNo int32) string {
	return fmt.Sprintf("uploads/%d/document-assets/%d/%s/page-%d-preview.png", userID, jobID, token, pageNo)
}

func DocumentImportOwnsImage(page *DocumentImportPage, keys map[string]bool) bool {
	if page.ImageKey != nil && keys[*page.ImageKey] {
		return true
	}
	for _, asset := range page.Assets {
		if keys[asset.ImageKey] {
			return true
		}
	}
	return false
}

func validatePreparedAssets(job *DocumentImportJob, token string, page DocumentImportPage) error {
	if len(page.Assets) == 0 {
		return nil
	}
	status, method, assetStatus := "pending", "ocr", "pending"
	keyForAsset := DocumentImportAssetKey
	preview := DocumentImportPreviewKey(job.UserID, job.ID, token, page.PageNo)
	if job.ImagePolicy == ImagePolicyImagesOnly {
		status, method, assetStatus = "done", "direct", "skipped"
	} else if job.ImagePolicy == ImagePolicyTextOnly {
		keyForAsset = DocumentImportOCRAssetKey
		preview = keyForAsset(job.UserID, job.ID, token, page.PageNo, 1)
	}
	if len(page.Assets) > 32 || page.Status != status || page.ExtractedBy != method || page.ImageKey == nil || *page.ImageKey != preview || page.Markdown == nil {
		return ErrDocumentImportPreparePlan
	}
	if page.BaseMarkdown == nil && (len(page.Assets) != 1 || page.Assets[0].Kind != "page") {
		return ErrDocumentImportPreparePlan
	}
	for i, a := range page.Assets {
		if a.ID != fmt.Sprintf("image-%d", i+1) || a.ImageKey != keyForAsset(job.UserID, job.ID, token, page.PageNo, i+1) || (a.Kind != "region" && a.Kind != "page") || a.Status != assetStatus || a.Markdown != "" || a.Method != "" || a.Error != "" {
			return ErrDocumentImportPreparePlan
		}
	}
	return nil
}
