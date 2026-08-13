package upload

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Handler struct {
	cfg *config.Config
}

func NewHandler(cfg *config.Config) *Handler {
	return &Handler{cfg: cfg}
}

type presignPutRequest struct {
	Filename    string `json:"filename" binding:"required"`
	ContentType string `json:"contentType"`
}

type presignGetRequest struct {
	ObjectKey string `json:"objectKey" binding:"required"`
}

func (h *Handler) PresignPut(c *gin.Context) {
	var req presignPutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := auth.MustUser(c)
	objectKey := BuildObjectKey(u.ID, req.Filename)
	if strings.TrimSpace(h.cfg.LocalStorageDir) != "" {
		response.OK(c, gin.H{
			"objectKey":    objectKey,
			"presignedUrl": buildLocalObjectURL(c, objectKey),
		})
		return
	}
	if h.cfg.S3 == nil {
		response.Fail(c, errors.New("未配置 S3 或本地对象存储"))
		return
	}
	url, err := CreatePresignedURL(PresignInput{
		Method:         "PUT",
		ObjectKey:      objectKey,
		ExpiresSeconds: h.cfg.S3.UploadExpireSeconds,
		S3:             *h.cfg.S3,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"objectKey":    objectKey,
		"presignedUrl": url,
	})
}

func (h *Handler) PresignGet(c *gin.Context) {
	var req presignGetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	objectKey := StripS4KeyPrefix(req.ObjectKey)
	if objectKey == "" || strings.Contains(objectKey, "..") {
		response.Fail(c, response.BadRequest("objectKey 非法"))
		return
	}
	if strings.TrimSpace(h.cfg.LocalStorageDir) != "" {
		response.OK(c, gin.H{"url": buildLocalObjectURL(c, objectKey)})
		return
	}
	if h.cfg.S3 == nil {
		response.Fail(c, errors.New("未配置 S3 或本地对象存储"))
		return
	}
	url, err := CreatePresignedURL(PresignInput{
		Method:         "GET",
		ObjectKey:      objectKey,
		ExpiresSeconds: h.cfg.S3.DownloadExpireSeconds,
		S3:             *h.cfg.S3,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"url": url})
}

func (h *Handler) PublicPresignGet(c *gin.Context) {
	h.PresignGet(c)
}

func buildLocalObjectURL(c *gin.Context, objectKey string) string {
	scheme := strings.TrimSpace(strings.Split(c.GetHeader("X-Forwarded-Proto"), ",")[0])
	if scheme == "" {
		if c.Request.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := strings.TrimSpace(strings.Split(c.GetHeader("X-Forwarded-Host"), ",")[0])
	if host == "" {
		host = c.Request.Host
	}
	parts := strings.Split(StripS4KeyPrefix(objectKey), "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return scheme + "://" + host + "/api/upload/local/" + strings.Join(parts, "/")
}

func (h *Handler) LocalPut(c *gin.Context) {
	objectKey, filePath, err := h.resolveLocalObjectPath(c.Param("objectKey"))
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if !strings.HasPrefix(objectKey, BuildUserObjectPrefix(u.ID)) {
		response.Fail(c, response.Forbidden("无权写入该对象"))
		return
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		response.Fail(c, err)
		return
	}
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		response.Fail(c, err)
		return
	}
	_, copyErr := io.Copy(file, c.Request.Body)
	closeErr := file.Close()
	if copyErr != nil {
		response.Fail(c, copyErr)
		return
	}
	if closeErr != nil {
		response.Fail(c, closeErr)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Handler) LocalGet(c *gin.Context) {
	objectKey, filePath, err := h.resolveLocalObjectPath(c.Param("objectKey"))
	if err != nil {
		response.Fail(c, err)
		return
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			response.Fail(c, response.NotFound("文件不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(objectKey)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Header("Cache-Control", "private, max-age=3600")
	c.Data(http.StatusOK, contentType, data)
}

func (h *Handler) resolveLocalObjectPath(raw string) (string, string, error) {
	if strings.TrimSpace(h.cfg.LocalStorageDir) == "" {
		return "", "", errors.New("本地对象存储未配置")
	}
	objectKey := StripS4KeyPrefix(strings.TrimPrefix(raw, "/"))
	parts := strings.Split(objectKey, "/")
	if objectKey == "" || strings.HasPrefix(objectKey, "/") {
		return "", "", response.BadRequest("对象键不合法")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", "", response.BadRequest("对象键不合法")
		}
	}
	root, err := filepath.Abs(h.cfg.LocalStorageDir)
	if err != nil {
		return "", "", err
	}
	filePath, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(objectKey)))
	if err != nil {
		return "", "", err
	}
	if filePath == root || !strings.HasPrefix(filePath, root+string(filepath.Separator)) {
		return "", "", response.BadRequest("对象键越界")
	}
	return objectKey, filePath, nil
}
