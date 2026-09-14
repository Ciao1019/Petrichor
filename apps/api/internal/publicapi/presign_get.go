// presign_get.go 复刻 publicPresignGetObject 与阅后即焚封面图解析：
// 本地对象存储返回站内 URL，S3 返回公开下载预签名。
package publicapi

import (
	"errors"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
)

func getS3ConfigOrThrow() (*config.S3Config, error) {
	cfg := config.Get().S3
	if cfg == nil {
		return nil, &httpx.HttpError{Status: 500, Message: "S3 存储未配置"}
	}
	return cfg, nil
}

// resolveObjectURL 公开读取地址：本地存储 → 站内 URL；否则 S3 GET 预签名。
func resolveObjectURL(c *gin.Context, objectKey string) (string, error) {
	if storage.LocalEnabled() {
		return storage.LocalObjectURL(objectKey), nil
	}
	cfg, err := getS3ConfigOrThrow()
	if err != nil {
		return "", err
	}
	return storage.CreateS3PresignedUrl(cfg, "GET", objectKey, cfg.DownloadExpireSecond, timeNow())
}

// s4ObjectKeyPattern 对应 S4_OBJECT_KEY_PATTERN：/uploads/<id>/... 形式（大小写不敏感）。
var s4ObjectKeyPattern = regexp.MustCompile(`(?i)^/?uploads/\d+/.+$`)

// normalizeS4ObjectKey 复刻 lib/s4-url.ts 的 normalizeS4ObjectKey：
// 剥掉 s4key: 前缀与首部斜杠、截断查询串；不符合对象键模式返回空。
func normalizeS4ObjectKey(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	withoutPrefix := strings.TrimPrefix(value, "s4key:")
	for strings.HasPrefix(withoutPrefix, "/") {
		withoutPrefix = withoutPrefix[1:]
	}
	if idx := strings.IndexAny(withoutPrefix, "?#"); idx >= 0 {
		withoutPrefix = withoutPrefix[:idx]
	}
	if !s4ObjectKeyPattern.MatchString(withoutPrefix) {
		return ""
	}
	return withoutPrefix
}

// resolvePublicCoverImageUrl 把正文里的首图引用解析成浏览器可直接加载的 URL：
// - 站内图片是 `s4key:uploads/...` 对象键引用 → 现签一个公开 GET 预签名 URL；
// - 外部 http(s) 图片 → 原样返回；
// - 其它 / 解析失败 → 空（确认页不显示图片）。
func resolvePublicCoverImageUrl(c *gin.Context, rawURL string) any {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return nil
	}
	objectKey := normalizeS4ObjectKey(rawURL)
	if objectKey == "" {
		if httpURLCheckRe.MatchString(rawURL) {
			return rawURL
		}
		return nil
	}
	url, err := resolveObjectURL(c, objectKey)
	if err != nil {
		return nil
	}
	return url
}

// PresignGetObject POST /api/public/upload/presign-get：公开下载预签名。
func PresignGetObject(c *gin.Context) {
	raw, err := readBody(c)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	objectKey := normalizeS4ObjectKey(rawString(raw, "objectKey"))
	if objectKey == "" {
		httpx.ErrorJSON(c, 400, "objectKey 非法")
		return
	}
	allowed, aerr := canReadPublicObject(c.Request.Context(), objectKey, rawString(raw, "mediaAccessToken"))
	if errors.Is(aerr, errMediaAccessDenied) || (aerr == nil && !allowed) {
		httpx.HandleError(c, forbiddenErr("该媒体对象不在当前公开范围内"))
		return
	}
	if aerr != nil {
		httpx.HandleError(c, aerr)
		return
	}
	url, uerr := resolveObjectURL(c, storage.StripS4KeyPrefix(objectKey))
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	httpx.OK(c, map[string]any{"url": url})
}
