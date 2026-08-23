// Package cache 复刻 src/server/cache：Upstash Redis REST 直连 + 优雅降级。
package cache

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
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
	once     sync.Once
	client   *redisClient // nil = 未配置，禁用缓存
	memStore sync.Map     // 本地兜底缓存（单实例语义）
)

func getClient() *redisClient {
	once.Do(func() {
		u := strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_URL"))
		t := strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_TOKEN"))
		if u == "" || t == "" {
			return
		}
		client = &redisClient{baseURL: strings.TrimRight(u, "/"), token: t, http: &http.Client{Timeout: 5 * time.Second}}
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
	data, err := io.ReadAll(resp.Body)
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
	e := memEntry{value: append([]byte(nil), value...)}
	if ttl > 0 {
		e.expireAt = time.Now().Add(ttl)
	}
	memStore.Store(key, e)
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
	if raw, ok := GetRaw(key); ok {
		var v T
		if err := json.Unmarshal(raw, &v); err == nil {
			return v, nil
		}
	}
	fresh, err := loader()
	if err != nil {
		return zero, err
	}
	if raw, jerr := json.Marshal(fresh); jerr == nil {
		SetRaw(key, raw, ttlSeconds)
	}
	return fresh, nil
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

var _ = url.QueryEscape // 保持 import 对齐
