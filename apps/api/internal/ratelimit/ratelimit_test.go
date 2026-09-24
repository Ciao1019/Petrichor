package ratelimit

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	httpx "petrichor/api/internal/httpx"
)

var (
	primaryRule  = Rule{Name: "test:fingerprint", Limit: 2, Period: time.Hour, Message: "提问次数已达上限"}
	backstopRule = Rule{Name: "test:ip", Limit: 3, Period: time.Hour, Message: "当前网络过于频繁"}
)

func setupStore(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	server := miniredis.RunT(t)
	if err := install(redis.NewClient(&redis.Options{Addr: server.Addr()}), "test-secret"); err != nil {
		t.Fatalf("初始化限流存储失败: %v", err)
	}
	t.Cleanup(Close)
	return server
}

func consume(t *testing.T, fingerprint, ip string) (Quota, error) {
	t.Helper()
	return Consume(context.Background(),
		Key{Rule: primaryRule, Value: fingerprint},
		Key{Rule: backstopRule, Value: ip},
	)
}

func requireLimitError(t *testing.T, err error, message string) *LimitError {
	t.Helper()
	var limitErr *LimitError
	if !errors.As(err, &limitErr) {
		t.Fatalf("期望限流错误，得到 %v", err)
	}
	if limitErr.Status != http.StatusTooManyRequests || !strings.HasPrefix(limitErr.Message, message) {
		t.Fatalf("限流错误内容不符: %d %q", limitErr.Status, limitErr.Message)
	}
	if wait := limitErr.RetryAfter(); wait <= 0 || wait > time.Hour {
		t.Fatalf("RetryAfter 应落在窗口内，得到 %s", wait)
	}
	return limitErr
}

func TestConsumeCountsPrimaryQuota(t *testing.T) {
	setupStore(t)
	for want := int64(1); want >= 0; want-- {
		quota, err := consume(t, "fp-a", "203.0.113.7")
		if err != nil {
			t.Fatalf("额度内请求被拒绝: %v", err)
		}
		if quota.Limit != 2 || quota.Remaining != want || !quota.Reset.After(time.Now()) {
			t.Fatalf("额度快照不符: %+v，期望剩余 %d", quota, want)
		}
	}
	_, err := consume(t, "fp-a", "203.0.113.7")
	requireLimitError(t, err, "提问次数已达上限，请 ")
}

func TestConsumeRejectsWithoutChargingOtherKeys(t *testing.T) {
	setupStore(t)
	for _, fingerprint := range []string{"fp-a", "fp-b", "fp-c"} {
		if _, err := consume(t, fingerprint, "203.0.113.7"); err != nil {
			t.Fatalf("IP 额度内请求被拒绝: %v", err)
		}
	}
	// IP 已用满：新指纹被兜底拒绝，且这次拒绝不能扣掉该指纹自己的额度。
	_, err := consume(t, "fp-d", "203.0.113.7")
	requireLimitError(t, err, "当前网络过于频繁")
	for range 2 {
		if _, err := consume(t, "fp-d", "198.51.100.9"); err != nil {
			t.Fatalf("被兜底拒绝的指纹不应被扣额度: %v", err)
		}
	}
}

func TestConsumeResetsAfterWindow(t *testing.T) {
	server := setupStore(t)
	for range 2 {
		if _, err := consume(t, "fp-a", "203.0.113.7"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := consume(t, "fp-a", "203.0.113.7"); err == nil {
		t.Fatal("超出额度应被拒绝")
	}
	server.FastForward(time.Hour + time.Second)
	if _, err := consume(t, "fp-a", "203.0.113.7"); err != nil {
		t.Fatalf("窗口过期后应恢复额度: %v", err)
	}
}

func TestConsumeSharesCounterBetweenRulesWithSameName(t *testing.T) {
	setupStore(t)
	strict := Rule{Name: backstopRule.Name, Limit: 1, Period: time.Hour, Message: "匿名访客已达上限"}
	if _, err := Consume(context.Background(), Key{Rule: strict, Value: "203.0.113.7"}); err != nil {
		t.Fatal(err)
	}
	_, err := Consume(context.Background(), Key{Rule: strict, Value: "203.0.113.7"})
	requireLimitError(t, err, "匿名访客已达上限")
	// 同名规则共享计数：宽松规则看到的是同一个桶，已用 1 次还剩 2 次。
	quota, err := Consume(context.Background(), Key{Rule: backstopRule, Value: "203.0.113.7"})
	if err != nil || quota.Remaining != 1 {
		t.Fatalf("同名规则应共享计数: %+v %v", quota, err)
	}
}

func TestConsumeStoresOnlyDigests(t *testing.T) {
	server := setupStore(t)
	if _, err := consume(t, "0123456789abcdef0123456789abcdef", "203.0.113.7"); err != nil {
		t.Fatal(err)
	}
	keys := server.Keys()
	if len(keys) != 2 {
		t.Fatalf("应写入两个计数 key，得到 %v", keys)
	}
	for _, key := range keys {
		if strings.Contains(key, "203.0.113.7") || strings.Contains(key, "0123456789abcdef") {
			t.Fatalf("Redis key 泄露了原始标识: %s", key)
		}
		if !strings.HasPrefix(key, keyPrefix+":test:") {
			t.Fatalf("Redis key 前缀不符: %s", key)
		}
	}
}

func TestConsumeEmptyValueSharesUnknownBucket(t *testing.T) {
	setupStore(t)
	strict := Rule{Name: "test:empty", Limit: 1, Period: time.Hour, Message: "未知来源已达上限"}
	if _, err := Consume(context.Background(), Key{Rule: strict, Value: ""}); err != nil {
		t.Fatal(err)
	}
	_, err := Consume(context.Background(), Key{Rule: strict, Value: "   "})
	requireLimitError(t, err, "未知来源已达上限")
}

func TestConsumeRequiresInitialize(t *testing.T) {
	Close()
	if _, err := consume(t, "fp-a", "203.0.113.7"); !errors.Is(err, ErrNotInitialized) {
		t.Fatalf("未初始化时应返回 ErrNotInitialized，得到 %v", err)
	}
}

func TestLimitErrorRendersRetryAfter(t *testing.T) {
	setupStore(t)
	for range 2 {
		if _, err := consume(t, "fp-a", "203.0.113.7"); err != nil {
			t.Fatal(err)
		}
	}
	_, err := consume(t, "fp-a", "203.0.113.7")

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/public/qa/chat", nil)
	httpx.HandleError(c, err)

	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("状态码应为 429，得到 %d", recorder.Code)
	}
	seconds, parseErr := strconv.Atoi(recorder.Header().Get("Retry-After"))
	if parseErr != nil || seconds <= 0 || seconds > 3600 {
		t.Fatalf("Retry-After 不符: %q", recorder.Header().Get("Retry-After"))
	}
	var body struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body.Code != http.StatusTooManyRequests {
		t.Fatalf("错误体不符: %s", recorder.Body.String())
	}
	if !strings.HasPrefix(body.Msg, "提问次数已达上限，请 ") || !strings.HasSuffix(body.Msg, "分钟后再试") {
		t.Fatalf("错误提示不符: %q", body.Msg)
	}
}
