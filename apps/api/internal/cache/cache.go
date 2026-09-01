// Package cache 提供 Upstash Redis REST 直连和优雅降级。
package cache

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

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

type redisClient struct {
	baseURL string
	token   string
	http    *http.Client
}

var (
	once           sync.Once
	client         *redisClient // nil = 未配置，禁用缓存
	memStore       sync.Map     // 本地兜底缓存（单实例语义）
	loadGroup      singleflight.Group
	lastMemCleanup atomic.Int64
)

func getClient() *redisClient {
	once.Do(func() {
		upstash := config.Get().Upstash
		if upstash == nil {
			return
		}
		client = &redisClient{baseURL: upstash.RESTURL, token: upstash.RESTToken, http: &http.Client{Timeout: 5 * time.Second}}
		slog.Info("[cache] Upstash Redis 缓存已启用")
	})
	return client
}

func (r *redisClient) cmd(args ...string) (json.RawMessage, error) {
	body, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, r.baseURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("upstash: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	if parsed.Error != "" {
		return nil, fmt.Errorf("upstash: %s", parsed.Error)
	}
	return parsed.Result, nil
}

type memEntry struct {
	value    json.RawMessage
	expireAt time.Time
}

func memGet(key string) (json.RawMessage, bool) {
	v, ok := memStore.Load(key)
	if !ok {
		return nil, false
	}
	e := v.(memEntry)
	if !e.expireAt.IsZero() && time.Now().After(e.expireAt) {
		memStore.Delete(key)
		return nil, false
	}
	return e.value, true
}

func memSet(key string, value []byte, ttl time.Duration) {
	cleanupExpiredMemoryEntries(time.Now())
	e := memEntry{value: append([]byte(nil), value...)}
	if ttl > 0 {
		e.expireAt = time.Now().Add(ttl)
	}
	memStore.Store(key, e)
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
		result, err := r.cmd("GET", key)
		if err == nil && len(result) > 0 && string(result) != "null" {
			return result, true
		}
	}
	if v, ok := memGet(key); ok {
		return v, true
	}
	return nil, false
}

// SetRaw 写入原始 JSON 缓存值。
func SetRaw(key string, value []byte, ttlSeconds int) {
	if r := getClient(); r != nil {
		ttlArg := fmt.Sprintf("%d", ttlSeconds)
		if _, err := r.cmd("SET", key, string(value), "EX", ttlArg); err == nil {
			return
		} else {
			slog.Warn("[cache] 写入缓存失败（回退进程内）", "key", key, "err", err)
		}
	}
	memSet(key, value, time.Duration(ttlSeconds)*time.Second)
}

// ReadThrough 读穿透 cache-aside。loader 返回值需可 JSON 序列化。
func ReadThrough[T any](key string, ttlSeconds int, loader func() (T, error)) (T, error) {
	var zero T
	if cached, ok := readCached[T](key); ok {
		return cached, nil
	}
	value, err, _ := loadGroup.Do(key, func() (any, error) {
		// 等待同键加载期间缓存可能已经写入，进入临界区后必须二次检查。
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

// Drop 删除键。
func Drop(keys ...string) {
	if len(keys) == 0 {
		return
	}
	if r := getClient(); r != nil {
		args := append([]string{"DEL"}, keys...)
		if _, err := r.cmd(args...); err == nil {
			for _, k := range keys {
				memStore.Delete(k)
			}
			return
		}
	}
	for _, k := range keys {
		memStore.Delete(k)
	}
}

// DropByPrefix 按前缀删除（SCAN）。
func DropByPrefix(prefix string) {
	if r := getClient(); r != nil {
		cursor := "0"
		for {
			result, err := r.cmd("SCAN", cursor, "MATCH", prefix+"*", "COUNT", "200")
			if err != nil {
				break
			}
			var pair [2]json.RawMessage
			if err := json.Unmarshal(result, &pair); err != nil {
				break
			}
			var keys []string
			_ = json.Unmarshal(pair[1], &keys)
			if len(keys) > 0 {
				args := append([]string{"DEL"}, keys...)
				_, _ = r.cmd(args...)
			}
			cursor = strings.Trim(string(pair[0]), `"`)
			if cursor == "0" {
				break
			}
		}
	}
	// 进程内兜底同步清理
	memStore.Range(func(k, _ any) bool {
		if ks, ok := k.(string); ok && strings.HasPrefix(ks, prefix) {
			memStore.Delete(ks)
		}
		return true
	})
}
