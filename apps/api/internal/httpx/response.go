// Package httpx 提供统一 HTTP 响应和分页契约。
package httpx

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// HttpError 业务错误，由统一错误处理渲染为 {code,msg,path,timestamp}。
type HttpError struct {
	Status  int
	Message string
}

func (e *HttpError) Error() string { return e.Message }

func BadRequest(msg string) *HttpError { return &HttpError{http.StatusBadRequest, msg} }
func Unauthorized(msg ...string) *HttpError {
	m := "请先登录"
	if len(msg) > 0 && msg[0] != "" {
		m = msg[0]
	}
	return &HttpError{http.StatusUnauthorized, m}
}
func Forbidden(msg ...string) *HttpError {
	m := "无权限访问"
	if len(msg) > 0 && msg[0] != "" {
		m = msg[0]
	}
	return &HttpError{http.StatusForbidden, m}
}
func NotFound(msg ...string) *HttpError {
	m := "数据不存在"
	if len(msg) > 0 && msg[0] != "" {
		m = msg[0]
	}
	return &HttpError{http.StatusNotFound, m}
}
func Conflict(msg string) *HttpError { return &HttpError{http.StatusConflict, msg} }
func TooManyRequests(msg ...string) *HttpError {
	m := "请求过于频繁，请稍后再试"
	if len(msg) > 0 && msg[0] != "" {
		m = msg[0]
	}
	return &HttpError{http.StatusTooManyRequests, m}
}

// FormatISO 复刻 JS Date.toISOString()：UTC + 毫秒精度。
func FormatISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// OK 输出成功 JSON（对应 ok()）。
func OK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, data)
}

// TableData 输出 RuoYi 风格列表响应。
func TableData(c *gin.Context, rows any, total int64) {
	c.JSON(http.StatusOK, gin.H{
		"total": total,
		"rows":  rows,
		"code":  200,
		"msg":   "查询成功",
	})
}

// ErrorJSON 输出错误体。
func ErrorJSON(c *gin.Context, status int, msg string) {
	path := c.Request.URL.Path
	c.AbortWithStatusJSON(status, gin.H{
		"code":      status,
		"msg":       msg,
		"path":      path,
		"timestamp": FormatISO(time.Now()),
	})
}

// ErrorLogger 在请求结束后统一记录 HandleError 收敛的错误，并为没有显式
// error cause 的 5xx 响应提供兜底日志。SSE 已经写出 200 后仍可能失败，因此
// 不能只按 HTTP status 判断，还必须检查 gin.Context.Errors。
func ErrorLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		startedAt := time.Now()
		c.Next()

		status := c.Writer.Status()
		fields := []any{
			"requestId", RequestIDValue(c),
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", status,
			"durationMs", time.Since(startedAt).Milliseconds(),
		}
		if last := c.Errors.Last(); last != nil {
			fields = append(fields, "err", last.Err)
			if status >= http.StatusInternalServerError || status < http.StatusBadRequest {
				slog.Error("HTTP 请求处理失败", fields...)
			} else {
				slog.Warn("HTTP 请求未完成", fields...)
			}
			return
		}
		if status >= http.StatusInternalServerError {
			slog.Error("HTTP 请求返回服务端错误", fields...)
		}
	}
}

// HandleError 统一错误出口（对应 toErrorResponse）。
func HandleError(c *gin.Context, err error) {
	if err == nil {
		return
	}
	// 交给 ErrorLogger 在请求结束后统一输出，避免各 handler 重复、遗漏或只打印
	// 一行没有 method/path/status 的裸错误。
	_ = c.Error(err)
	var he *HttpError
	if errors.As(err, &he) {
		ErrorJSON(c, he.Status, he.Message)
		return
	}
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) {
		ErrorJSON(c, http.StatusRequestEntityTooLarge, "请求体超过允许大小")
		return
	}
	// 参数绑定失败等类型错误按 400 处理
	msg := err.Error()
	if strings.Contains(msg, "invalid character") || strings.Contains(msg, "cannot unmarshal") || strings.Contains(msg, "EOF") {
		ErrorJSON(c, http.StatusBadRequest, "请求参数错误")
		return
	}
	ErrorJSON(c, http.StatusInternalServerError, "系统异常，请稍后重试")
}

// ReadJSON 解析 JSON 请求体（对应 readJson）。
func ReadJSON(c *gin.Context, target any) error {
	if err := c.ShouldBindJSON(target); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return &HttpError{Status: http.StatusRequestEntityTooLarge, Message: "请求体超过允许大小"}
		}
		return BadRequest("请求体必须是合法 JSON")
	}
	return nil
}
