package response

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// HTTPError 业务可预期错误。
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string {
	return e.Message
}

func BadRequest(msg string) error {
	return &HTTPError{Status: http.StatusBadRequest, Message: msg}
}

func Unauthorized(msg string) error {
	if msg == "" {
		msg = "请先登录"
	}
	return &HTTPError{Status: http.StatusUnauthorized, Message: msg}
}

func Forbidden(msg string) error {
	if msg == "" {
		msg = "无权限访问"
	}
	return &HTTPError{Status: http.StatusForbidden, Message: msg}
}

func NotFound(msg string) error {
	if msg == "" {
		msg = "数据不存在"
	}
	return &HTTPError{Status: http.StatusNotFound, Message: msg}
}

func Conflict(msg string) error {
	return &HTTPError{Status: http.StatusConflict, Message: msg}
}

func Gone(msg string) error {
	return &HTTPError{Status: http.StatusGone, Message: msg}
}

func TooManyRequests(msg string) error {
	if msg == "" {
		msg = "请求过于频繁，请稍后再试"
	}
	return &HTTPError{Status: http.StatusTooManyRequests, Message: msg}
}

func OK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, data)
}

func TableData(c *gin.Context, rows any, total int) {
	c.JSON(http.StatusOK, gin.H{
		"total": total,
		"rows":  rows,
		"code":  200,
		"msg":   "查询成功",
	})
}

func Fail(c *gin.Context, err error) {
	path := c.Request.URL.Path
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		writeError(c, httpErr.Status, httpErr.Message, path)
		return
	}
	// Gin 的访问日志在请求结束后从 Context 读取原始错误。
	// 对外响应仍隐藏内部细节，但不能把数据库、上游模型或 context 错误静默丢弃。
	if err != nil {
		_ = c.Error(err)
	}
	writeError(c, http.StatusInternalServerError, "系统异常，请稍后重试", path)
}

func writeError(c *gin.Context, status int, msg, path string) {
	c.AbortWithStatusJSON(status, gin.H{
		"code":      status,
		"msg":       msg,
		"path":      path,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})
}
