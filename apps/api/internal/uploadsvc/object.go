package uploadsvc

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/config"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
)

// UploadObject 接收同源文件，Go 完成对象存储写入后才确认上传成功。
func UploadObject(c *gin.Context) {
	key, err := resolveLocalObjectKey(c.Param("objectKey"))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := auth.CurrentUser(c)
	if user == nil {
		httpx.ErrorJSON(c, http.StatusUnauthorized, "请先登录")
		return
	}
	if !strings.HasPrefix(key, fmt.Sprintf("uploads/%d/", user.ID)) {
		httpx.ErrorJSON(c, http.StatusForbidden, "不能上传到其他用户的目录")
		return
	}
	// 普通 API 的读取超时较短；上传独立允许五分钟接收，仍受大小上限约束。
	_ = http.NewResponseController(c.Writer).SetReadDeadline(time.Now().Add(5 * time.Minute))
	err = storage.WriteObjectStream(c.Request.Context(), key, c.Request.Body,
		guessMimeFromObjectKey(key), config.Get().RequestLimits.UploadBytes)
	if err == nil {
		c.Status(http.StatusNoContent)
		return
	}
	var sizeError *http.MaxBytesError
	var upstreamError *storage.ObjectHTTPError
	switch {
	case errors.Is(err, storage.ErrObjectTooLarge), errors.As(err, &sizeError):
		httpx.ErrorJSON(c, http.StatusRequestEntityTooLarge, "文件超过允许上传大小")
	case errors.As(err, &upstreamError):
		httpx.ErrorJSON(c, http.StatusBadGateway, fmt.Sprintf("对象存储保存失败（HTTP %d），请稍后重试上传", upstreamError.Status))
	default:
		httpx.ErrorJSON(c, http.StatusBadGateway, "文件接收或保存失败，请重试上传")
	}
}
