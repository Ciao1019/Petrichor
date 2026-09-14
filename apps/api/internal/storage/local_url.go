package storage

import (
	"net/url"
	"strings"
)

// LocalObjectURL 使用站内路径，避免反向代理的内部 Host 泄露到浏览器，
// 确保本地上传保持同源并携带登录 Cookie。
func LocalObjectURL(objectKey string) string {
	parts := strings.Split(objectKey, "/")
	replacer := strings.NewReplacer("%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*")
	for i, part := range parts {
		parts[i] = replacer.Replace(strings.ReplaceAll(url.QueryEscape(part), "+", "%20"))
	}
	return "/api/upload/local/" + strings.Join(parts, "/")
}
