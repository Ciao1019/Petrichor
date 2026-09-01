package config

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultRedisPoolSize       = 32
	DefaultRedisMinIdleConns   = 4
	DefaultRedisDialTimeoutMs  = 2000
	DefaultRedisReadTimeoutMs  = 1000
	DefaultRedisWriteTimeoutMs = 1000
)

// RedisConfig 描述 go-redis TCP 连接池和命令超时。
type RedisConfig struct {
	URL          string
	PoolSize     int
	MinIdleConns int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
}

type cacheFileConfig struct {
	Redis redisFileConfig `toml:"redis"`
}

type redisFileConfig struct {
	URL            string `toml:"url"`
	PoolSize       int    `toml:"pool_size"`
	MinIdleConns   int    `toml:"min_idle_conns"`
	DialTimeoutMs  int    `toml:"dial_timeout_ms"`
	ReadTimeoutMs  int    `toml:"read_timeout_ms"`
	WriteTimeoutMs int    `toml:"write_timeout_ms"`
}

func normalizeRedis(raw redisFileConfig) (*RedisConfig, error) {
	redisURL := strings.TrimSpace(raw.URL)
	configured := redisURL != "" || raw.PoolSize != 0 || raw.MinIdleConns != 0 ||
		raw.DialTimeoutMs != 0 || raw.ReadTimeoutMs != 0 || raw.WriteTimeoutMs != 0
	if !configured {
		return nil, nil
	}
	parsed, err := url.Parse(redisURL)
	if err != nil || (parsed.Scheme != "redis" && parsed.Scheme != "rediss") || parsed.Host == "" {
		return nil, fmt.Errorf("cache.redis.url 必须是合法的 redis:// 或 rediss:// URL")
	}
	poolSize := raw.PoolSize
	if poolSize == 0 {
		poolSize = DefaultRedisPoolSize
	}
	minIdleConns := raw.MinIdleConns
	if minIdleConns == 0 {
		minIdleConns = DefaultRedisMinIdleConns
	}
	if poolSize < 1 || minIdleConns < 0 || minIdleConns > poolSize {
		return nil, fmt.Errorf("cache.redis 要求 pool_size >= 1 且 0 <= min_idle_conns <= pool_size")
	}
	dialTimeout, err := millisecondSetting("cache.redis.dial_timeout_ms", raw.DialTimeoutMs, DefaultRedisDialTimeoutMs)
	if err != nil {
		return nil, err
	}
	readTimeout, err := millisecondSetting("cache.redis.read_timeout_ms", raw.ReadTimeoutMs, DefaultRedisReadTimeoutMs)
	if err != nil {
		return nil, err
	}
	writeTimeout, err := millisecondSetting("cache.redis.write_timeout_ms", raw.WriteTimeoutMs, DefaultRedisWriteTimeoutMs)
	if err != nil {
		return nil, err
	}
	return &RedisConfig{
		URL: redisURL, PoolSize: poolSize, MinIdleConns: minIdleConns,
		DialTimeout: dialTimeout, ReadTimeout: readTimeout, WriteTimeout: writeTimeout,
	}, nil
}

func millisecondSetting(name string, value, fallback int) (time.Duration, error) {
	if value < 0 {
		return 0, fmt.Errorf("%s 必须是非负整数", name)
	}
	if value == 0 {
		value = fallback
	}
	return time.Duration(value) * time.Millisecond, nil
}
