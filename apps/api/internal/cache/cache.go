package cache

import (
	"context"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

// Client 是可选 Redis 缓存；未配置时全部 no-op。
type Client interface {
	Get(ctx context.Context, key string) (string, bool, error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	Del(ctx context.Context, keys ...string) error
}

type noopClient struct{}

func (noopClient) Get(context.Context, string) (string, bool, error) { return "", false, nil }
func (noopClient) Set(context.Context, string, string, time.Duration) error { return nil }
func (noopClient) Del(context.Context, ...string) error                     { return nil }

func New(cfg *config.Config) Client {
	if cfg.RedisURL == "" || cfg.RedisToken == "" {
		return noopClient{}
	}
	return newUpstash(cfg.RedisURL, cfg.RedisToken)
}
