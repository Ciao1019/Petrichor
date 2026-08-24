package runtime

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	httpx "petrichor/api/internal/httpx"
)

// ===== 统一 Agent 错误（对照 errors.ts）=====

// AgentError 所有工具/技能/子代理失败都归一到这里，便于 Observation 转换、重试判定与 Trace 记录。
type AgentError struct {
	Code      AgentToolErrorCode
	Message   string
	Retryable bool
}

func (e *AgentError) Error() string { return e.Message }

func (e *AgentError) ToShape() AgentToolErrorShape {
	return AgentToolErrorShape{Code: e.Code, Message: e.Message, Retryable: e.Retryable}
}

var defaultRetryable = map[AgentToolErrorCode]bool{
	CodeToolTimeout:     true,
	CodeExecutionError:  true,
	CodeRetrievalFailed: true,
	CodeRerankFailed:    true,
}

// NewAgentError 构造（retryable 缺省按错误码判断）。
func NewAgentError(code AgentToolErrorCode, message string, retryable *bool) *AgentError {
	r, ok := defaultRetryable[code]
	if !ok {
		r = false
	}
	if retryable != nil {
		r = *retryable
	}
	return &AgentError{Code: code, Message: message, Retryable: r}
}

// ValidationError 参数校验失败：不重试同参数，但允许模型修正参数后再调用。
func ValidationError(message string) *AgentError {
	f := false
	return NewAgentError(CodeValidationError, message, &f)
}

// PermissionDenied 权限拒绝：永不重试。
func PermissionDenied(message string) *AgentError {
	f := false
	return NewAgentError(CodePermissionDenied, message, &f)
}

// ToolTimeoutErr 工具超时：可重试。
func ToolTimeoutErr(toolID string, timeoutMs int64) *AgentError {
	t := true
	return NewAgentError(CodeToolTimeout, "工具 "+toolID+" 执行超时", &t)
}

// ToolAborted 工具被取消。
func ToolAborted(toolID string) *AgentError {
	f := false
	return NewAgentError(CodeToolAborted, "工具 "+toolID+" 已被取消", &f)
}

var timeoutPattern = regexp.MustCompile(`(?i)timeout|timed out|deadline exceeded`)

// NormalizeAgentError 把任意 error 归一成 *AgentError。
func NormalizeAgentError(err error) *AgentError {
	if err == nil {
		return nil
	}
	if ae, ok := err.(*AgentError); ok {
		return ae
	}
	if err == context.Canceled || strings.Contains(strings.ToLower(err.Error()), "canceled") || strings.Contains(strings.ToLower(err.Error()), "abort") {
		f := false
		return NewAgentError(CodeToolAborted, "执行已取消", &f)
	}
	message := err.Error()
	if errors.Is(err, context.Canceled) {
		f := false
		return NewAgentError(CodeToolAborted, "执行已取消", &f)
	}
	var he *httpx.HttpError
	if errors.As(err, &he) {
		switch {
		case he.Status == http.StatusUnauthorized || he.Status == http.StatusForbidden:
			f := false
			return NewAgentError(CodePermissionDenied, message, &f)
		case he.Status >= 400 && he.Status < 500:
			f := false
			return NewAgentError(CodeValidationError, message, &f)
		}
	}
	if timeoutPattern.MatchString(message) {
		t := true
		return NewAgentError(CodeToolTimeout, message, &t)
	}
	return NewAgentError(CodeExecutionError, message, nil)
}
