package kb

import (
	"context"
	"errors"
	"hash/fnv"
	"math"
	"time"

	httpx "petrichor/api/internal/httpx"
)

const (
	workerRetryBaseDelay = 5 * time.Second
	workerRetryMaxDelay  = 5 * time.Minute
	workerLeaseDuration  = 90 * time.Second
	workerHeartbeatEvery = 20 * time.Second
)

// workerRetryDelay 使用有上限的指数退避，并按任务 ID 加入稳定抖动，避免批量失败后同时重试。
func workerRetryDelay(attempt int, jobKey string) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	exponent := min(attempt-1, 10)
	base := float64(workerRetryBaseDelay) * math.Pow(2, float64(exponent))
	if base > float64(workerRetryMaxDelay) {
		base = float64(workerRetryMaxDelay)
	}
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(jobKey))
	// 0.85—1.15 的稳定抖动；同一任务可预测，不依赖全局随机数。
	jitter := 0.85 + float64(hash.Sum32()%301)/1000
	delay := time.Duration(base * jitter)
	if delay > workerRetryMaxDelay {
		return workerRetryMaxDelay
	}
	return delay
}

// workerErrorRetryable 只自动重试取消、超时、限流、服务端和未知基础设施错误；
// 明确的业务 4xx 不重试，避免无效任务反复消耗模型与数据库资源。
func workerErrorRetryable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var httpErr *httpx.HttpError
	if errors.As(err, &httpErr) {
		return httpErr.Status == 408 || httpErr.Status == 429 || httpErr.Status >= 500
	}
	return true
}

func workerFailureStatus(err error, attempt, maxAttempts int32) string {
	if !workerErrorRetryable(err) {
		return "failed"
	}
	if attempt < maxAttempts {
		return "pending"
	}
	return "dead_letter"
}
