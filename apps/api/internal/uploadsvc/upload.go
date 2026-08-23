// Package uploadsvc 移植 src/server/upload/handlers.ts + local-storage.ts：
// 上传预签名（S3 SigV4 PUT / 本地 ticket 双模式）、下载预签名与本地对象直传/公开读取。
package uploadsvc

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
)

// extMime 与 local-storage.ts 的 EXT_MIME 一致，其余回退 octet-stream。
var extMime = map[string]string{
	".gif":  "image/gif",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".pdf":  "application/pdf",
	".png":  "image/png",
	".webp": "image/webp",
}

func guessMimeFromObjectKey(objectKey string) string {
	ext := strings.ToLower(path.Ext(storage.StripS4KeyPrefix(objectKey)))
	if mime, ok := extMime[ext]; ok {
		return mime
	}
	return "application/octet-stream"
}

// localObjectURL 构造本地对象访问地址：/api/upload/local/<encoded objectKey>。
func localObjectURL(c *gin.Context, objectKey string) string {
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	if proto := c.GetHeader("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	}
	parts := strings.Split(objectKey, "/")
	for i, part := range parts {
		parts[i] = urlPathEscape(part)
	}
	return scheme + "://" + c.Request.Host + "/api/upload/local/" + strings.Join(parts, "/")
}

// urlPathEscape 复刻 encodeURIComponent 的路径段编码。
func urlPathEscape(v string) string {
	escaped := strings.ReplaceAll(url.QueryEscape(v), "+", "%20")
	replacer := strings.NewReplacer("%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*")
	return replacer.Replace(escaped)
}

// resolveLocalObjectKey 校验并归一化本地对象键：拒绝空键、空段与相对段。
// 注意 gin 的 *param 会带前导斜杠，与 Next.js catch-all 拼接行为不同，这里统一剥掉。
func resolveLocalObjectKey(rawKey string) (string, error) {
	key := strings.TrimSpace(storage.StripS4KeyPrefix(strings.TrimPrefix(rawKey, "/")))
	if key == "" {
		return "", httpx.BadRequest("对象键不能为空")
	}
	if strings.HasPrefix(key, "/") {
		return "", httpx.BadRequest("对象键不合法")
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return "", httpx.BadRequest("对象键不合法")
		}
	}
	return key, nil
}

func getS3ConfigOrThrow() (*config.S3Config, error) {
	cfg := config.Get().S3
	if cfg == nil {
		return nil, &httpx.HttpError{Status: http.StatusInternalServerError, Message: "S3 存储未配置"}
	}
	return cfg, nil
}

// PresignPutObject POST /api/upload/presign-put：
// 登录后生成上传预签名。本地存储模式返回内部上传 ticket 地址；否则走 S3 SigV4 PUT。
func PresignPutObject(c *gin.Context) {
	var req struct {
		Filename string `json:"filename"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	filename := strings.TrimSpace(req.Filename)
	if filename == "" {
		httpx.ErrorJSON(c, 400, "filename 不能为空")
		return
	}

	user := auth.CurrentUser(c)
	objectKey := storage.BuildS3ObjectKey(filename, user.ID, "")

	if storage.LocalEnabled() {
		httpx.OK(c, gin.H{
			"objectKey":    objectKey,
			"presignedUrl": localObjectURL(c, objectKey),
		})
		return
	}

	cfg, err := getS3ConfigOrThrow()
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	signedURL, uerr := storage.CreateS3PresignedUrl(cfg, "PUT", objectKey, cfg.UploadExpireSeconds, now())
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	httpx.OK(c, gin.H{"objectKey": objectKey, "presignedUrl": signedURL})
}

// PresignGetObject POST /api/upload/presign-get：
// 私有对象下载预签名（S3 GET / 本地对象 URL）。
func PresignGetObject(c *gin.Context) {
	var req struct {
		ObjectKey string `json:"objectKey"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	objectKey := strings.TrimSpace(req.ObjectKey)
	if objectKey == "" {
		httpx.ErrorJSON(c, 400, "objectKey 不能为空")
		return
	}
	strippedKey := storage.StripS4KeyPrefix(objectKey)

	if storage.LocalEnabled() {
		localKey, kerr := resolveLocalObjectKey(strippedKey)
		if kerr != nil {
			httpx.HandleError(c, kerr)
			return
		}
		httpx.OK(c, gin.H{"url": localObjectURL(c, localKey)})
		return
	}

	cfg, err := getS3ConfigOrThrow()
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	signedURL, uerr := storage.CreateS3PresignedUrl(cfg, "GET", strippedKey, cfg.DownloadExpireSecond, now())
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	httpx.OK(c, gin.H{"url": signedURL})
}

// UploadLocalObject PUT /api/upload/local/*objectKey：
// 需登录；请求体原始字节写入本地对象存储。
func UploadLocalObject(c *gin.Context) {
	rawKey := c.Param("objectKey")
	objectKey, err := resolveLocalObjectKey(rawKey)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	data, rerr := io.ReadAll(c.Request.Body)
	if rerr != nil {
		httpx.HandleError(c, httpx.BadRequest("请求体读取失败"))
		return
	}
	if werr := storage.SaveLocalObject(objectKey, data); werr != nil {
		httpx.HandleError(c, werr)
		return
	}
	c.Status(http.StatusNoContent)
}

// ServeLocalObject GET /api/upload/local/*objectKey：
// 公开读取对象字节流；Content-Type 按扩展名推断，Cache-Control: private。
func ServeLocalObject(c *gin.Context) {
	rawKey := c.Param("objectKey")
	objectKey, err := resolveLocalObjectKey(rawKey)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	data, rerr := storage.ReadLocalObject(objectKey)
	if rerr != nil {
		if errors.Is(rerr, os.ErrNotExist) {
			httpx.ErrorJSON(c, http.StatusNotFound, "文件不存在")
			return
		}
		httpx.HandleError(c, rerr)
		return
	}
	c.Header("Cache-Control", "private, max-age=3600")
	c.Data(http.StatusOK, guessMimeFromObjectKey(objectKey), data)
}

func now() time.Time { return time.Now() }
