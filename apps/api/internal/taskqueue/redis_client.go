package taskqueue

import "github.com/redis/go-redis/v9"

// 请求 deadline 必须约束已开始的 Redis I/O，不能只依赖可配置的较长读写超时。
func newQueueRedisClient(options *redis.Options) *redis.Client {
	options.ContextTimeoutEnabled = true
	return redis.NewClient(options)
}
