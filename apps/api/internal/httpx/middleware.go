package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

const requestIDContextKey = "petrichor.request-id"

var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

// RequestID 接受格式安全的上游请求 ID，否则生成新的随机 ID，并写回响应头。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := strings.TrimSpace(c.GetHeader("X-Request-ID"))
		if !validRequestID.MatchString(requestID) {
			requestID = newRequestID()
		}
		c.Set(requestIDContextKey, requestID)
		c.Header("X-Request-ID", requestID)
		c.Next()
	}
}

func newRequestID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return hex.EncodeToString(raw[:])
	}
	return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
}

// RequestIDValue 返回当前请求的关联 ID。
func RequestIDValue(c *gin.Context) string {
	value, _ := c.Get(requestIDContextKey)
	requestID, _ := value.(string)
	return requestID
}

// RequestBodyLimit 对 JSON/普通请求体与上传请求体实施不同硬上限。
func RequestBodyLimit(jsonLimit, uploadLimit int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body == nil || c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead {
			c.Next()
			return
		}
		limit := jsonLimit
		contentType := strings.ToLower(c.GetHeader("Content-Type"))
		if strings.HasPrefix(c.Request.URL.Path, "/api/upload/local/") || strings.HasPrefix(contentType, "multipart/form-data") {
			limit = uploadLimit
		}
		if c.Request.ContentLength > limit {
			ErrorJSON(c, http.StatusRequestEntityTooLarge, "请求体超过允许大小")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		c.Next()
	}
}

// SecurityHeaders 为 API 响应补充不依赖页面 CSP 的通用安全头。
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "SAMEORIGIN")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		c.Next()
	}
}

type runtimeRequestMetrics struct {
	requests     atomic.Int64
	active       atomic.Int64
	clientErrors atomic.Int64
	serverErrors atomic.Int64
	durationMs   atomic.Int64
}

var requestMetrics runtimeRequestMetrics

// RequestMetricsSnapshot 是进程内聚合指标；不包含路径、参数或用户信息。
type RequestMetricsSnapshot struct {
	Requests        int64   `json:"requests"`
	Active          int64   `json:"active"`
	ClientErrors    int64   `json:"clientErrors"`
	ServerErrors    int64   `json:"serverErrors"`
	AverageDuration float64 `json:"averageDurationMs"`
}

func SnapshotRequestMetrics() RequestMetricsSnapshot {
	requests := requestMetrics.requests.Load()
	average := float64(0)
	if requests > 0 {
		average = float64(requestMetrics.durationMs.Load()) / float64(requests)
	}
	return RequestMetricsSnapshot{
		Requests:        requests,
		Active:          requestMetrics.active.Load(),
		ClientErrors:    requestMetrics.clientErrors.Load(),
		ServerErrors:    requestMetrics.serverErrors.Load(),
		AverageDuration: average,
	}
}

// AccessLogger 同时记录结构化访问日志并维护轻量进程指标；健康探针成功时不刷日志。
func AccessLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		startedAt := time.Now()
		requestMetrics.requests.Add(1)
		requestMetrics.active.Add(1)
		defer requestMetrics.active.Add(-1)
		c.Next()
		status := c.Writer.Status()
		requestMetrics.durationMs.Add(time.Since(startedAt).Milliseconds())
		if status >= http.StatusInternalServerError {
			requestMetrics.serverErrors.Add(1)
		} else if status >= http.StatusBadRequest {
			requestMetrics.clientErrors.Add(1)
		}
		if status < http.StatusBadRequest && (c.Request.URL.Path == "/healthz" || c.Request.URL.Path == "/readyz") {
			return
		}
		slog.Info("HTTP 请求完成",
			"requestId", RequestIDValue(c),
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", status,
			"durationMs", time.Since(startedAt).Milliseconds(),
			"responseBytes", c.Writer.Size(),
			"clientIp", c.ClientIP(),
		)
	}
}
