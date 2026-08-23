// helpers.go publicapi 包内小工具：正则与数字格式化。
package publicapi

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	// 分享码/链接码：10-64 位 URL 安全字符（对应 /^[A-Za-z0-9_-]{10,64}$/）。
	shareCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{10,64}$`)
	// 访问密码：6 位数字。
	passwordPattern = regexp.MustCompile(`^\d{6}$`)
	// source-<articleId> 形式的文章级 Wiki 页面键。
	sourcePageKeyPattern = regexp.MustCompile(`^source-(\d+)$`)
)

func formatInt(n int64) string { return strconv.FormatInt(n, 10) }

func formatFloat(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// escapeLikePattern 复刻 share-handlers.ts 的 escapeLikePattern。
func escapeLikePattern(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_")
	return replacer.Replace(value)
}
