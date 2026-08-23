// Package agentapi 是 /api/agent/* 开放接口组与 /api/mcp 的 Go 移植，
// 逐端点对照 apps/web/src/server/agent/handlers.ts。
package agentapi

import (
	"bytes"
	"context"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const maxAgentLogTextLength = 100_000

// authContext 简写别名。
type authContext = auth.AgentAuthContext

// querierLike 同时兼容 *pgxpool.Pool 与 pgx.Tx（对照 internal/kb execQuerier）。
type querierLike interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func badReq(msg string) error      { return httpx.BadRequest(msg) }
func notFoundErr(msg string) error { return httpx.NotFound(msg) }

// dbPool 连接池便捷入口。
func dbPool() *pgxpool.Pool { return db.Pool() }

// iso 复刻 JS Date.toISOString()。
func iso(t time.Time) string { return httpx.FormatISO(t) }

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

func idStr(id int64) string { return strconv.FormatInt(id, 10) }

// nullableIDStr bigint ID 字符串化（可空）。
func nullableIDStr(id *int64) any {
	if id == nil {
		return nil
	}
	return idStr(*id)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefPtr(s *string) string { return deref(s) }

func trimSpaceCopy(s string) string { return strings.TrimSpace(s) }

func rawStringOrEmpty(raw map[string]any, key string) string {
	if v, ok := raw[key]; ok && v != nil {
		s, _ := v.(string)
		return s
	}
	return ""
}

func clipLogText(value string, maxLength int) string {
	if value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxLength {
		return value
	}
	return string(runes[:maxLength]) + "\n...[已截断，原始长度 " + strconv.Itoa(len(runes)) + "]"
}

// ===== 输入解析 =====

// reqID 必填正整数 ID（对应 idSchema）。
func reqID(raw any, message string) (int64, error) {
	var s string
	switch v := raw.(type) {
	case string:
		s = strings.TrimSpace(v)
	case float64:
		if v != float64(int64(v)) {
			return 0, badReq(message)
		}
		s = strconv.FormatInt(int64(v), 10)
	default:
		return 0, badReq(message)
	}
	if s == "" {
		return 0, badReq(message)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, badReq(message)
	}
	return n, nil
}

// optID 可选 ID：缺失 / null / "" 返回 valid=false（对应 optionalIdSchema）。
func optID(raw map[string]any, key string) (int64, bool, error) {
	v, ok := raw[key]
	if !ok || v == nil {
		return 0, false, nil
	}
	switch value := v.(type) {
	case string:
		s := strings.TrimSpace(value)
		if s == "" {
			return 0, false, nil
		}
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 {
			return 0, false, badReq("ID 必须是正整数")
		}
		return n, true, nil
	case float64:
		n := int64(value)
		if value <= 0 || float64(n) != value {
			return 0, false, badReq("ID 必须是正整数")
		}
		return n, true, nil
	default:
		return 0, false, badReq("ID 必须是正整数")
	}
}

func trimmedString(raw map[string]any, key string) string {
	if v, ok := raw[key]; ok && v != nil {
		s, _ := v.(string)
		return strings.TrimSpace(s)
	}
	return ""
}

func rawBool(raw map[string]any, key string) bool {
	b, ok := raw[key].(bool)
	return ok && b
}

func boolPtr(raw map[string]any, key string) *bool {
	if b, ok := raw[key].(bool); ok {
		return &b
	}
	return nil
}

func nullableString(raw map[string]any, key string) *string {
	v, ok := raw[key]
	if !ok || v == nil {
		return nil
	}
	s, _ := v.(string)
	if s == "" {
		return nil
	}
	return &s
}

func readBodyMap(c *gin.Context) (map[string]any, error) {
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		return nil, badReq("请求体必须是合法 JSON")
	}
	return raw, nil
}

// ===== 包装器 =====

// userHandler 用户态端点骨架（RequireUser 中间件之后）。
func userHandler(fn func(c *gin.Context) (any, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		data, err := fn(c)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		httpx.OK(c, data)
	}
}

// captureWriter 捕获响应体用于调用日志。
type captureWriter struct {
	gin.ResponseWriter
	buf bytes.Buffer
}

func (w *captureWriter) Write(b []byte) (int, error) {
	w.buf.Write(b)
	return w.ResponseWriter.Write(b)
}

// requireAgentScope 对应 api-key.ts requireAgentScope：scope 缺失返回 403。
func requireAgentScope(actx *auth.AgentAuthContext, required string) error {
	if !auth.HasAgentScope(actx.Scopes, required) {
		return httpx.Forbidden("当前 API Key 缺少 " + required + " 权限")
	}
	return nil
}

// agentHandler Agent 端点骨架：
// 鉴权由路由上的 auth.RequireAgentKey("") 完成（无效 Key 401 时无上下文、不记日志，照 TS 语义）；
// scope 校验在 handler 内进行（403 会进入调用日志），并统一记录 petrichor_agent_call_log。
func agentHandler(fn func(c *gin.Context, actx *auth.AgentAuthContext) (any, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		startedAt := time.Now()
		requestText := requestBodyForLog(c)

		cw := &captureWriter{ResponseWriter: c.Writer}
		c.Writer = cw

		actx := auth.AgentAuth(c)
		var handlerErr error
		if actx == nil {
			handlerErr = httpx.Unauthorized("缺少 Agent API Key")
			httpx.ErrorJSON(c, 401, "缺少 Agent API Key")
		} else {
			data, err := fn(c, actx)
			handlerErr = err
			if err != nil {
				httpx.HandleError(c, err)
			} else {
				httpx.OK(c, data)
			}
		}

		recordAgentCallLog(c, actx, cw.ResponseWriter.Status(), time.Since(startedAt), requestText, cw.buf.String(), handlerErr)
	}
}

// requestBodyForLog 读取请求体文本用于日志，并把 body 放回去供后续绑定。
func requestBodyForLog(c *gin.Context) string {
	if c.Request.Body == nil {
		return ""
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return ""
	}
	_ = c.Request.Body.Close()
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	c.Set(gin.BodyBytesKey, raw)
	return string(raw)
}

// resolveClientIp 对照 handlers.ts resolveClientIp。
func resolveClientIp(c *gin.Context) *string {
	for _, header := range []string{"X-Forwarded-For", "X-Real-Ip", "Cf-Connecting-Ip"} {
		value := c.GetHeader(header)
		if value == "" {
			continue
		}
		part := value
		if idx := strings.IndexByte(part, ','); idx >= 0 {
			part = part[:idx]
		}
		part = strings.TrimSpace(part)
		if part != "" {
			return &part
		}
	}
	return nil
}

// recordAgentCallLog 写入调用日志；失败只告警不影响主流程（对照 recordAgentCallLog）。
func recordAgentCallLog(
	c *gin.Context,
	actx *auth.AgentAuthContext,
	statusCode int,
	duration time.Duration,
	requestText, responseText string,
	handlerErr error,
) {
	if actx == nil {
		return
	}
	userAgent := ""
	if ua := c.GetHeader("User-Agent"); ua != "" {
		userAgent = clipLogText(ua, 1000)
	}
	errorMessage := any(nil)
	if handlerErr != nil {
		errorMessage = clipLogText(handlerErr.Error(), 1000)
	}
	ctx := context.Background()
	_, err := dbPool().Exec(ctx,
		`INSERT INTO petrichor_agent_call_log
		 (user_id, api_key_id, api_key_prefix, method, path, ip, user_agent,
		  request_json, response_json, status_code, duration_ms, error_message)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		actx.UserID, actx.ApiKeyID, actx.KeyPrefix,
		c.Request.Method, c.Request.URL.Path, resolveClientIp(c), userAgent,
		emptyToNil(clipLogText(requestText, maxAgentLogTextLength)),
		emptyToNil(clipLogText(responseText, maxAgentLogTextLength)),
		statusCode, maxInt64(0, duration.Milliseconds()), errorMessage)
	if err != nil {
		gin.DefaultErrorWriter.Write([]byte("[Agent API] 调用日志写入失败: " + err.Error() + "\n"))
	}
}

// recordAgentCallLogRow 供 MCP 工具委托复用（path 使用工具对应的 REST 端点）。
func recordAgentCallLogRow(
	actx *auth.AgentAuthContext,
	method, path string,
	ip, userAgent *string,
	requestText, responseText string,
	statusCode int,
	durationMs int64,
	handlerErr error,
) {
	errorMessage := any(nil)
	if handlerErr != nil {
		errorMessage = clipLogText(handlerErr.Error(), 1000)
	}
	_, err := dbPool().Exec(context.Background(),
		`INSERT INTO petrichor_agent_call_log
		 (user_id, api_key_id, api_key_prefix, method, path, ip, user_agent,
		  request_json, response_json, status_code, duration_ms, error_message)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		actx.UserID, actx.ApiKeyID, actx.KeyPrefix, method, path, ip, userAgent,
		emptyToNil(clipLogText(requestText, maxAgentLogTextLength)),
		emptyToNil(clipLogText(responseText, maxAgentLogTextLength)),
		statusCode, maxInt64(0, durationMs), errorMessage)
	if err != nil {
		gin.DefaultErrorWriter.Write([]byte("[Agent API] 调用日志写入失败: " + err.Error() + "\n"))
	}
}

func emptyToNil(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
