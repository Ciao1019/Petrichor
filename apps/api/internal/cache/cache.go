// Package cache 提供基于 go-redis 的 Redis 缓存和进程内降级。
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"

	"petrichor/api/internal/config"
)

const namespace = "petrichor"

// OneDaySeconds 统一 1 天 TTL 兜底（写操作主动失效）。
const OneDaySeconds = 60 * 60 * 24

// CacheKey 带命名空间缓存键。
func CacheKey(parts ...string) string {
	return namespace + ":" + strings.Join(parts, ":")
}

var (
	clientMu       sync.RWMutex
	client         *redis.Client // nil = 未配置或已关闭，使用进程内降级
	memStore       sync.Map
	loadGroup      singleflight.Group
	lastMemCleanup atomic.Int64
)

// Initialize 创建 Redis TCP 连接池并在启动阶段完成探测。
func Initialize(ctx context.Context) error {
	cfg := config.Get().Redis
	if cfg == nil {
		slog.Info("[cache] Redis 未配置，使用进程内缓存")
		return nil
	}

	options, err := redis.ParseURL(cfg.URL)
	if err != nil {
		return err
	}
	options.PoolSize = cfg.PoolSize
	options.MinIdleConns = cfg.MinIdleConns
	options.DialTimeout = cfg.DialTimeout
	options.ReadTimeout = cfg.ReadTimeout
	options.WriteTimeout = cfg.WriteTimeout
	candidate := redis.NewClient(options)
	if err := candidate.Ping(ctx).Err(); err != nil {
		_ = candidate.Close()
		return err
	}

	clientMu.Lock()
	previous := client
	client = candidate
	clientMu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	slog.Info("[cache] Redis TCP 缓存已启用", "poolSize", cfg.PoolSize, "minIdleConns", cfg.MinIdleConns)
	return nil
}

// Ping 验证已配置 Redis 的可用性；未配置时视为可用。
func Ping(ctx context.Context) error {
	if r := getClient(); r != nil {
		return r.Ping(ctx).Err()
	}
	return nil
}

// Close 释放 Redis 连接池。
func Close() {
	clientMu.Lock()
	previous := client
	client = nil
	clientMu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
}

func getClient() *redis.Client {
	clientMu.RLock()
	defer clientMu.RUnlock()
	return client
}

type memEntry struct {
	value    json.RawMessage
	expireAt time.Time
}

func memGet(key string) (json.RawMessage, bool) {
	value, ok := memStore.Load(key)
	if !ok {
		return nil, false
	}
	entry, ok := value.(memEntry)
	if !ok {
		memStore.Delete(key)
		return nil, false
	}
	if !entry.expireAt.IsZero() && time.Now().After(entry.expireAt) {
		memStore.Delete(key)
		return nil, false
	}
	return entry.value, true
}

func memSet(key string, value []byte, ttl time.Duration) {
	cleanupExpiredMemoryEntries(time.Now())
	entry := memEntry{value: append([]byte(nil), value...)}
	if ttl > 0 {
		entry.expireAt = time.Now().Add(ttl)
	}
	memStore.Store(key, entry)
}

func cleanupExpiredMemoryEntries(now time.Time) {
	last := time.Unix(lastMemCleanup.Load(), 0)
	if now.Sub(last) < time.Minute || !lastMemCleanup.CompareAndSwap(last.Unix(), now.Unix()) {
		return
	}
	memStore.Range(func(key, value any) bool {
		entry, ok := value.(memEntry)
		if ok && !entry.expireAt.IsZero() && now.After(entry.expireAt) {
			memStore.Delete(key)
		}
		return true
	})
}

// GetRaw 读取原始 JSON 缓存值。
func GetRaw(key string) ([]byte, bool) {
	if r := getClient(); r != nil {
		result, err := r.Get(context.Background(), key).Bytes()
		if err == nil {
			memStore.Delete(key)
			return result, true
		}
		if !errors.Is(err, redis.Nil) {
			slog.Warn("[cache] 读取 Redis 失败（回退进程内）", "key", key, "err", err)
		}
	}
	if value, ok := memGet(key); ok {
		return value, true
	}
	return nil, false
}

// SetRaw 写入原始 JSON 缓存值。
func SetRaw(key string, value []byte, ttlSeconds int) {
	ttl := time.Duration(ttlSeconds) * time.Second
	if r := getClient(); r != nil {
		if err := r.Set(context.Background(), key, value, ttl).Err(); err == nil {
			memStore.Delete(key)
			return
		} else {
			slog.Warn("[cache] 写入 Redis 失败（回退进程内）", "key", key, "err", err)
		}
	}
	memSet(key, value, ttl)
}

// ReadThrough 读穿透 cache-aside。loader 返回值需可 JSON 序列化。
func ReadThrough[T any](key string, ttlSeconds int, loader func() (T, error)) (T, error) {
	var zero T
	if cached, ok := readCached[T](key); ok {
		return cached, nil
	}
	value, err, _ := loadGroup.Do(key, func() (any, error) {
		if cached, ok := readCached[T](key); ok {
			return cached, nil
		}
		fresh, loadErr := loader()
		if loadErr != nil {
			return nil, loadErr
		}
		if raw, marshalErr := json.Marshal(fresh); marshalErr == nil {
			SetRaw(key, raw, ttlSeconds)
		}
		return fresh, nil
	})
	if err != nil {
		return zero, err
	}
	fresh, ok := value.(T)
	if !ok {
		return zero, fmt.Errorf("缓存加载结果类型不匹配: %s", key)
	}
	return fresh, nil
}

func readCached[T any](key string) (T, bool) {
	var zero T
	raw, ok := GetRaw(key)
	if !ok {
		return zero, false
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return zero, false
	}
	return value, true
}

// Drop 删除键。UNLINK 在 Redis 主线程外释放值，避免大对象阻塞。
func Drop(keys ...string) {
	if len(keys) == 0 {
		return
	}
	if r := getClient(); r != nil {
		if err := r.Unlink(context.Background(), keys...).Err(); err != nil {
			slog.Warn("[cache] 删除 Redis 缓存失败", "count", len(keys), "err", err)
		}
	}
	for _, key := range keys {
		memStore.Delete(key)
	}
}

// DropByPrefix 使用增量 SCAN + UNLINK 删除前缀，避免阻塞 Redis。
func DropByPrefix(prefix string) {
	if r := getClient(); r != nil {
		ctx := context.Background()
		var cursor uint64
		for {
			keys, next, err := r.Scan(ctx, cursor, prefix+"*", 200).Result()
			if err != nil {
				slog.Warn("[cache] 扫描 Redis 缓存失败", "prefix", prefix, "err", err)
				break
			}
			if len(keys) > 0 {
				if err := r.Unlink(ctx, keys...).Err(); err != nil {
					slog.Warn("[cache] 批量删除 Redis 缓存失败", "prefix", prefix, "count", len(keys), "err", err)
					break
				}
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	memStore.Range(func(key, _ any) bool {
		if value, ok := key.(string); ok && strings.HasPrefix(value, prefix) {
			memStore.Delete(value)
		}
		return true
	})
}
