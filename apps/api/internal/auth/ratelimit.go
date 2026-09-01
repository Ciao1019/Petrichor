package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const authRateLimitRetention = 48 * time.Hour

var lastAuthRateCleanup atomic.Int64

type credentialRatePolicy struct {
	Window        time.Duration
	IdentityLimit int64
	IPLimit       int64
}

var credentialRatePolicies = map[string]credentialRatePolicy{
	"login":    {Window: 15 * time.Minute, IdentityLimit: 8, IPLimit: 30},
	"register": {Window: time.Hour, IdentityLimit: 3, IPLimit: 10},
}

// LimitSensitiveEndpoint 为不含账号标识的敏感入口提供跨实例 IP 限流。
func LimitSensitiveEndpoint(action string, limit int64, window time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := consumeAuthRateLimit(c.Request.Context(), action, "ip", requestIP(c), limit, window); err != nil {
			httpx.HandleError(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}

func enforceCredentialRateLimit(ctx context.Context, action, identity, ip string) error {
	policy, ok := credentialRatePolicies[action]
	if !ok {
		return fmt.Errorf("未知认证限流策略: %s", action)
	}
	if err := consumeAuthRateLimit(ctx, action, "identity", strings.ToLower(strings.TrimSpace(identity)), policy.IdentityLimit, policy.Window); err != nil {
		return err
	}
	return consumeAuthRateLimit(ctx, action, "ip", ip, policy.IPLimit, policy.Window)
}

func consumeAuthRateLimit(ctx context.Context, action, dimension, value string, limit int64, window time.Duration) error {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "unknown"
	}
	now := time.Now().UTC()
	bucketStart := now.Truncate(window)
	bucketKey := fmt.Sprintf("auth:%s:%s:%s:%d", action, dimension, rateLimitDigest(value), bucketStart.Unix())
	var count int64
	if err := db.Pool().QueryRow(ctx, `
		INSERT INTO petrichor_public_qa_rate_limit (bucket_key, count, window_started_at, updated_at)
		VALUES ($1, 1, $2, $3)
		ON CONFLICT (bucket_key) DO UPDATE SET
		 count = petrichor_public_qa_rate_limit.count + 1,
		 updated_at = EXCLUDED.updated_at
		RETURNING count`, bucketKey, bucketStart, now).Scan(&count); err != nil {
		return err
	}
	cleanupAuthRateLimitsBestEffort(ctx, now)
	if count > limit {
		return httpx.TooManyRequests("尝试次数过多，请稍后再试")
	}
	return nil
}

func clearCredentialIdentityRateLimit(ctx context.Context, action, identity string) {
	policy, ok := credentialRatePolicies[action]
	if !ok {
		return
	}
	bucketStart := time.Now().UTC().Truncate(policy.Window)
	bucketKey := fmt.Sprintf("auth:%s:identity:%s:%d", action, rateLimitDigest(strings.ToLower(strings.TrimSpace(identity))), bucketStart.Unix())
	_, _ = db.Pool().Exec(ctx, `DELETE FROM petrichor_public_qa_rate_limit WHERE bucket_key = $1`, bucketKey)
}

func rateLimitDigest(value string) string {
	key := config.Get().Encryption.Key
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

func cleanupAuthRateLimitsBestEffort(ctx context.Context, now time.Time) {
	last := time.Unix(lastAuthRateCleanup.Load(), 0)
	if now.Sub(last) < time.Hour || !lastAuthRateCleanup.CompareAndSwap(last.Unix(), now.Unix()) {
		return
	}
	_, _ = db.Pool().Exec(ctx, `
		DELETE FROM petrichor_public_qa_rate_limit
		WHERE window_started_at < $1`, now.Add(-authRateLimitRetention))
}
