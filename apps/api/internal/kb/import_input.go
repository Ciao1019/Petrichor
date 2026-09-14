package kb

import (
	"path"
	"strconv"
	"strings"

	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

const (
	maxImportPages             = 500
	maxImportPageMarkdownBytes = 2 << 20
	maxImportMarkdownBytes     = 16 << 20
)

func importSourceType(fileName string) (string, error) {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(fileName)), ".")
	switch ext {
	case "markdown":
		return "md", nil
	case "md", "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "xls", "xlsx", "xlsm", "xlsb", "odt", "ods", "odp", "rtf", "epub", "csv", "pdf":
		return ext, nil
	default:
		return "", badReq("不支持的文档格式")
	}
}

// 只接受当前用户的对象键；不解析 URL、不清理路径，避免宽松归一化越权。
func validateImportObjectKey(userID int64, objectKey string) error {
	key := storage.StripS4KeyPrefix(objectKey)
	prefix := "uploads/" + strconv.FormatInt(userID, 10) + "/"
	if userID <= 0 || objectKey != strings.TrimSpace(objectKey) || len(key) > 1024 ||
		!strings.HasPrefix(key, prefix) || len(key) <= len(prefix) ||
		strings.Contains(key, "..") || strings.ContainsAny(key, "\\:%?#\x00\r\n\t") || path.Clean(key) != key {
		return badReq("对象键必须属于当前用户的 uploads 目录")
	}
	return nil
}

func parseImportCreateOptions(raw map[string]any) (key string, err error) {
	// 不允许任何浏览器解析正文进入可信页计划，包括空数组和 null。
	if _, exists := raw["pages"]; exists {
		return "", badReq("pages 不再接受客户端提交，请上传原文件")
	}
	if _, exists := raw["markdown"]; exists {
		return "", badReq("markdown 不接受客户端提交")
	}
	key, _ = raw["idempotencyKey"].(string)
	if !taskqueue.ValidDocumentImportIdempotencyKey(key) {
		return "", badReq("idempotencyKey 必须是稳定 UUID")
	}
	return strings.ToLower(key), nil
}

func parseImportImagePolicy(raw map[string]any) (string, error) {
	value, exists := raw["imagePolicy"]
	if !exists {
		return taskqueue.ImagePolicyKeepAndRecognize, nil
	}
	policy, ok := value.(string)
	if !ok || policy == "" || !taskqueue.ValidDocumentImagePolicy(policy) {
		return "", badReq("imagePolicy 必须是 keep_and_recognize、text_only 或 images_only")
	}
	return policy, nil
}
