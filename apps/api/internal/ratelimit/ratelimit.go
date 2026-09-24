// Package ratelimit 基于 ulule/limiter 的 Redis 固定窗口限流，供前台匿名入口按 IP 与浏览器指纹计数。
//
// 窗口从某个 key 的首次计数开始，到期由 Redis TTL 自动清除，多实例共享同一份计数。
// key 中的取值（IP、指纹）先做 HMAC，Redis 里不保存访客原始标识。
package ratelimit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/ulule/limiter/v3"
	sredis "github.com/ulule/limiter/v3/drivers/store/redis"

	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
)

const keyPrefix = "petrichor:ratelimit"

// ErrNotInitialized 未调用 Initialize 就计数；按失败处理，不放行匿名请求。
var ErrNotInitialized = errors.New("限流存储尚未初始化")

var state struct {
	mu     sync.RWMutex
	client *redis.Client
	store  limiter.Store
	secret []byte
}

// Rule 描述一个计数维度。Name 决定 Redis key 的命名空间：同名规则共享计数，只是上限不同。
type Rule struct {
	Name    string
	Limit   int64
	Period  time.Duration
	Message string // 超限提示前半句，等待时长由 Consume 补齐
}

// Key 一次请求在某个维度上的取值；取值为空时归入 "unknown"，共享同一个桶。
type Key struct {
	Rule  Rule
	Value string
}

// Quota 首个维度计数后的额度快照，用于响应头展示。
type Quota struct {
	Limit     int64
	Remaining int64
	Reset     time.Time
}

// LimitError 超限错误：按 429 渲染，并通过 RetryAfter 让 httpx 写出 Retry-After 响应头。
type LimitError struct {
	*httpx.HttpError
	wait time.Duration
}

func (e *LimitError) Unwrap() error { return e.HttpError }

// RetryAfter 距离当前窗口结束的时长。
func (e *LimitError) RetryAfter() time.Duration { return e.wait }

// Initialize 建立限流专用的 Redis 连接并预加载 Lua 脚本；Redis 是 API 的必需依赖。
func Initialize(ctx context.Context) error {
	cfg := config.Get()
	if cfg.Redis == nil {
		return errors.New("限流需要配置 cache.redis.url")
	}
	options, err := redis.ParseURL(cfg.Redis.URL)
	if err != nil {
		return fmt.Errorf("解析限流 Redis 配置失败: %w", err)
	}
	options.PoolSize = cfg.Redis.PoolSize
	options.MinIdleConns = cfg.Redis.MinIdleConns
	options.DialTimeout = cfg.Redis.DialTimeout
	options.ReadTimeout = cfg.Redis.ReadTimeout
	options.WriteTimeout = cfg.Redis.WriteTimeout
	// 请求取消或超时后不再等待 Redis，避免限流拖住已放弃的请求。
	options.ContextTimeoutEnabled = true
	client := redis.NewClient(options)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return fmt.Errorf("连接限流 Redis 失败: %w", err)
	}
	if err := install(client, cfg.Encryption.Key); err != nil {
		_ = client.Close()
		return err
	}
	return nil
}

// install 绑定 Redis 客户端与 HMAC 密钥，替换并关闭旧连接。
func install(client *redis.Client, secret string) error {
	if strings.TrimSpace(secret) == "" {
		return errors.New("限流需要 encryption.key 作为 key 摘要密钥")
	}
	store, err := sredis.NewStoreWithOptions(client, limiter.StoreOptions{Prefix: keyPrefix})
	if err != nil {
		return fmt.Errorf("加载限流 Lua 脚本失败: %w", err)
	}
	state.mu.Lock()
	previous := state.client
	state.client, state.store, state.secret = client, store, []byte(secret)
	state.mu.Unlock()
	if previous != nil && previous != client {
		_ = previous.Close()
	}
	return nil
}

// Close 关闭限流 Redis 连接。
func Close() {
	state.mu.Lock()
	previous := state.client
	state.client, state.store, state.secret = nil, nil, nil
	state.mu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
}

// Consume 对多个维度同时计数：先只读检查，任一维度已用尽就直接拒绝，其余维度不扣额度；
// 全部有余量时逐个 +1。只读检查与 +1 之间可能被并发请求抢先，+1 后再次超限同样拒绝。
func Consume(ctx context.Context, keys ...Key) (Quota, error) {
	state.mu.RLock()
	store, secret := state.store, state.secret
	state.mu.RUnlock()
	if store == nil {
		return Quota{}, ErrNotInitialized
	}
	if len(keys) == 0 {
		return Quota{}, nil
	}

	storeKeys := make([]string, len(keys))
	rates := make([]limiter.Rate, len(keys))
	for i, key := range keys {
		storeKeys[i] = key.Rule.Name + ":" + digest(secret, key.Value)
		rates[i] = limiter.Rate{Period: key.Rule.Period, Limit: key.Rule.Limit}
		current, err := store.Peek(ctx, storeKeys[i], rates[i])
		if err != nil {
			return Quota{}, fmt.Errorf("读取限流计数失败: %w", err)
		}
		if current.Remaining <= 0 {
			return Quota{}, limitError(key.Rule, current)
		}
	}

	var quota Quota
	for i, key := range keys {
		current, err := store.Increment(ctx, storeKeys[i], 1, rates[i])
		if err != nil {
			return Quota{}, fmt.Errorf("写入限流计数失败: %w", err)
		}
		if current.Reached {
			return Quota{}, limitError(key.Rule, current)
		}
		if i == 0 {
			quota = Quota{Limit: current.Limit, Remaining: current.Remaining, Reset: time.Unix(current.Reset, 0)}
		}
	}
	return quota, nil
}

func digest(secret []byte, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "unknown"
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

func limitError(rule Rule, current limiter.Context) *LimitError {
	wait := time.Until(time.Unix(current.Reset, 0))
	if wait < time.Second {
		wait = time.Second
	}
	minutes := int64(math.Ceil(wait.Minutes()))
	message := fmt.Sprintf("%s，请 %d 分钟后再试", rule.Message, minutes)
	return &LimitError{HttpError: &httpx.HttpError{Status: http.StatusTooManyRequests, Message: message}, wait: wait}
}
