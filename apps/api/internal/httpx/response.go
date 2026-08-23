// Package httpx 复刻 src/server/http/response.ts 与 pagination.ts 的响应契约。
package httpx

import (
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

// HandleError 统一错误出口（对应 toErrorResponse）。
func HandleError(c *gin.Context, err error) {
	if err == nil {
		return
	}
	if he, ok := err.(*HttpError); ok {
		ErrorJSON(c, he.Status, he.Message)
		return
	}
	// 参数绑定失败等类型错误按 400 处理
	msg := err.Error()
	if strings.Contains(msg, "invalid character") || strings.Contains(msg, "cannot unmarshal") || strings.Contains(msg, "EOF") {
		ErrorJSON(c, http.StatusBadRequest, "请求参数错误")
		return
	}
	gin.DefaultErrorWriter.Write([]byte(err.Error() + "\n"))
	ErrorJSON(c, http.StatusInternalServerError, "系统异常，请稍后重试")
}

// ReadJSON 解析 JSON 请求体（对应 readJson）。
func ReadJSON(c *gin.Context, target any) error {
	if err := c.ShouldBindJSON(target); err != nil {
		return BadRequest("请求体必须是合法 JSON")
	}
	return nil
}
