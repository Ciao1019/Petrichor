// Package uploadsvc 提供上传、下载和本地对象访问：
// 同源上传、下载预签名与本地对象读取。
package uploadsvc

import (
	"errors"
	"net/http"
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
// 保留接口字段名；只返回 Go 上传地址，S3 凭证与签名不交给浏览器。
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

	if !storage.LocalEnabled() {
		if _, err := getS3ConfigOrThrow(); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}
	uploadURL := strings.Replace(storage.LocalObjectURL(objectKey), "/upload/local/", "/upload/object/", 1)
	httpx.OK(c, gin.H{"objectKey": objectKey, "presignedUrl": uploadURL})
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
		httpx.OK(c, gin.H{"url": storage.LocalObjectURL(localKey)})
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
	UploadObject(c)
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
