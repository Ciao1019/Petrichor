package kb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	httpx "petrichor/api/internal/httpx"
)

const knowledgeBuildModelMaxAttempts = 3

func knowledgeBuildModelMaxTokens(operation string) int64 {
	switch operation {
	case "kb.build.questions", "kb.build.summary":
		return 2_048
	case "kb.build.extraction":
		return 8_192
	case "kb.build.taxonomy":
		return 4_096
	case "kb.build.pages":
		return 16_384
	default:
		return 0
	}
}

var (
	knowledgeBuildModelRetryDelay = func(failedAttempt int) time.Duration {
		return time.Duration(1<<max(failedAttempt-1, 0)) * time.Second
	}
	knowledgeBuildUpstreamStatusPattern = regexp.MustCompile(`\((\d{3})\)`)
	errKnowledgeBuildInvalidJSON        = errors.New("模型结果不是有效 JSON")
)

type knowledgeBuildModelCallError struct {
	cause     error
	attempts  int
	retryable bool
}

func (err *knowledgeBuildModelCallError) Error() string { return err.cause.Error() }
func (err *knowledgeBuildModelCallError) Unwrap() error { return err.cause }

// invokeKnowledgeBuildChat 使用全局信号量共享模型额度，并只重试临时错误。
func invokeKnowledgeBuildChat(ctx context.Context, request ChatRequest) (string, error) {
	answer, _, err := invokeKnowledgeBuildModel(ctx, request, false)
	return answer, err
}

// invokeKnowledgeBuildJSON 启用供应商原生 JSON 模式；传输错误或偶发非法 JSON 仍会局部重试。
func invokeKnowledgeBuildJSON(ctx context.Context, request ChatRequest) (map[string]any, error) {
	request.RequireJSON = true
	_, parsed, err := invokeKnowledgeBuildModel(ctx, request, true)
	return parsed, err
}

func invokeKnowledgeBuildModel(ctx context.Context, request ChatRequest, requireJSON bool) (string, map[string]any, error) {
	if err := requireChat(); err != nil {
		return "", nil, err
	}
	if request.MaxTokens <= 0 {
		request.MaxTokens = knowledgeBuildModelMaxTokens(request.Op)
	}
	var lastErr error
	for attempt := 1; attempt <= knowledgeBuildModelMaxAttempts; attempt++ {
		answer, err := invokeKnowledgeBuildModelOnce(ctx, request)
		var parsed map[string]any
		if err == nil && requireJSON {
			parsed = extractJSONObjects(answer)
			if parsed == nil {
				slog.Warn("知识构建模型返回非 JSON",
					"operation", request.Op,
					"attempt", attempt,
					"outputRunes", utf8.RuneCountInString(answer),
					"hasOpeningBrace", strings.Contains(answer, "{"),
					"hasClosingBrace", strings.Contains(answer, "}"),
				)
				err = errKnowledgeBuildInvalidJSON
			}
		}
		if err == nil {
			return answer, parsed, nil
		}
		lastErr = err
		retryable := retryableKnowledgeBuildModelError(err)
		if !retryable || attempt == knowledgeBuildModelMaxAttempts {
			slog.Warn("知识构建模型阶段调用失败",
				"operation", request.Op,
				"attempts", attempt,
				"retryable", retryable,
				"err", err,
			)
			return "", nil, &knowledgeBuildModelCallError{
				cause: err, attempts: attempt, retryable: retryable,
			}
		}
		retriesUsed := attempt
		retriesTotal := knowledgeBuildModelMaxAttempts - 1
		retryMessage := fmt.Sprintf(
			"%s暂时异常，正在重试（%d/%d）", knowledgeBuildOperationLabel(request.Op), retriesUsed, retriesTotal,
		)
		reportKnowledgeBuildProgressNote(ctx, retryMessage)
		reportKnowledgeBuildEvent(ctx, "model.retry", retryMessage)
		slog.Warn("知识构建模型阶段触发重试",
			"operation", request.Op,
			"attempt", attempt,
			"maxAttempts", knowledgeBuildModelMaxAttempts,
			"err", err,
		)
		timer := time.NewTimer(knowledgeBuildModelRetryDelay(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", nil, ctx.Err()
		case <-timer.C:
		}
	}
	return "", nil, lastErr
}

func invokeKnowledgeBuildModelOnce(ctx context.Context, request ChatRequest) (string, error) {
	select {
	case knowledgeBuildModelSlots <- struct{}{}:
		defer func() { <-knowledgeBuildModelSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	return ChatInvoker(ctx, request)
}

func retryableKnowledgeBuildModelError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, errKnowledgeBuildInvalidJSON) {
		return true
	}
	var httpErr *httpx.HttpError
	if errors.As(err, &httpErr) {
		if status, ok := knowledgeBuildUpstreamStatus(httpErr.Message); ok {
			return status == 408 || status == 409 || status == 425 || status == 429 || status >= 500
		}
		return httpErr.Status == 408 || httpErr.Status == 429 || httpErr.Status == 502 || httpErr.Status == 503 || httpErr.Status == 504
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) {
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

func knowledgeBuildUpstreamStatus(message string) (int, bool) {
	match := knowledgeBuildUpstreamStatusPattern.FindStringSubmatch(message)
	if len(match) != 2 {
		return 0, false
	}
	status, err := strconv.Atoi(match[1])
	return status, err == nil
}

func knowledgeBuildFallbackWarning(stage, fallback string, err error) string {
	var callErr *knowledgeBuildModelCallError
	if errors.As(err, &callErr) && callErr.attempts > 1 {
		return fmt.Sprintf("%s连续 %d 次调用失败，%s：%s",
			stage, callErr.attempts, fallback, friendlyKnowledgeBuildModelError(callErr.cause))
	}
	if errors.Is(err, errKnowledgeBuildInvalidJSON) {
		return stage + "返回格式无效，" + fallback
	}
	return stage + "失败，" + fallback + "：" + friendlyKnowledgeBuildModelError(err)
}

func friendlyKnowledgeBuildModelError(err error) string {
	var httpErr *httpx.HttpError
	if errors.As(err, &httpErr) {
		if status, ok := knowledgeBuildUpstreamStatus(httpErr.Message); ok {
			return fmt.Sprintf("模型服务返回 %d", status)
		}
		return truncateRunes(strings.TrimSpace(httpErr.Message), 120)
	}
	var networkErr net.Error
	if errors.As(err, &networkErr) {
		return "模型服务网络连接异常"
	}
	if errors.Is(err, errKnowledgeBuildInvalidJSON) {
		return "模型结果不是有效 JSON"
	}
	return truncateRunes(strings.TrimSpace(err.Error()), 120)
}

func knowledgeBuildOperationLabel(operation string) string {
	switch operation {
	case "kb.build.questions":
		return "推荐问题生成"
	case "kb.build.extraction":
		return "知识候选分析"
	case "kb.build.summary":
		return "长文档摘要合并"
	case "kb.build.taxonomy":
		return "知识目录规划"
	case "kb.build.pages":
		return "Wiki 页面生成"
	default:
		return "模型调用"
	}
}
