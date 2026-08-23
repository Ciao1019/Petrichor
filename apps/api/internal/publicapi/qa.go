// qa.go 前台公开问答：
// 本轮不做流式，POST /api/public/qa/chat 注册为 503「AI 服务未就绪」（后续统一接 AI 层）；
// 限流表 petrichor_public_qa_rate_limit 的读写逻辑照 TS public-qa-rate-limit.ts 移植供后续使用。
package publicapi

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/sitecontent"
)

// 单浏览器（visitor-id）每小时提问上限——面向真实用户的主限流键。
const PublicQaVisitorHourlyLimit = 10

// 单 IP 每小时提问兜底上限——防止清除 visitor-id 后无限刷量。
const PublicQaIPHourlyLimit = 60

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ResolveClientIp 从常见反代头里取访客 IP（与 agent/handlers.ts 同款顺序）。
func ResolveClientIp(c *gin.Context) string {
	if v := firstHop(c.GetHeader("X-Forwarded-For")); v != "" {
		return v
	}
	if v := strings.TrimSpace(c.GetHeader("X-Real-Ip")); v != "" {
		return v
	}
	if v := strings.TrimSpace(c.GetHeader("Cf-Connecting-Ip")); v != "" {
		return v
	}
	return ""
}

func firstHop(header string) string {
	for _, part := range strings.Split(header, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// ResolveVisitorId 读取并校验客户端 visitor-id（localStorage 里的 UUID）；非法返回空串。
func ResolveVisitorId(c *gin.Context) string {
	raw := strings.TrimSpace(c.GetHeader("X-Petrichor-Visitor-Id"))
	if raw == "" || !uuidPattern.MatchString(raw) {
		return ""
	}
	return strings.ToLower(raw)
}

// hourBucket 当前小时的窗口标识（UTC），形如 2026061013。
func hourBucket(now time.Time) string {
	t := now.UTC()
	year := strconv.Itoa(t.Year())
	month := pad2(int(t.Month()))
	day := pad2(t.Day())
	hour := pad2(t.Hour())
	return year + month + day + hour
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// bumpBucket 原子自增某个计数桶并返回自增后的计数。
func bumpBucket(ctx context.Context, bucketKey string, now time.Time) (int64, error) {
	var count int64
	err := pool().QueryRow(ctx,
		`INSERT INTO petrichor_public_qa_rate_limit (bucket_key, count, window_started_at, updated_at)
		 VALUES ($1, 1, $2, $2)
		 ON CONFLICT (bucket_key) DO UPDATE SET count = petrichor_public_qa_rate_limit.count + 1,
		   updated_at = $2
		 RETURNING count`, bucketKey, now).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

type publicQaQuotaResult struct {
	Remaining int64
	Limit     int64
}

// ConsumePublicQaQuota 复合键限流：visitor-id 主键（10/h）+ IP 兜底（60/h）。
// 任一桶超限抛 429。无 visitor-id 时退化为「以 IP 作主键、按 10/h」。
func ConsumePublicQaQuota(ctx context.Context, visitorID, ip string) (*publicQaQuotaResult, error) {
	now := timeNow()
	bucket := hourBucket(now)
	var ipKey string
	if ip != "" {
		ipKey = "ip:" + ip + ":" + bucket
	}

	primaryKey := ipKey
	if visitorID != "" {
		primaryKey = "visitor:" + visitorID + ":" + bucket
	}
	primaryLimit := int64(PublicQaVisitorHourlyLimit)

	// 兜底：仅在主键是 visitor 时，额外按 IP 设更高上限（两者是不同维度）。
	backstopKey := ""
	if visitorID != "" {
		backstopKey = ipKey
	}

	remaining := primaryLimit
	if primaryKey != "" {
		primaryCount, err := bumpBucket(ctx, primaryKey, now)
		if err != nil {
			return nil, err
		}
		remaining = primaryLimit - primaryCount
		if remaining < 0 {
			remaining = 0
		}
		if primaryCount > primaryLimit {
			return nil, httpx.TooManyRequests(
				"本小时提问已达上限（" + strconvItoa(int(primaryLimit)) + " 次），请稍后再试")
		}
	}
	if backstopKey != "" {
		ipCount, err := bumpBucket(ctx, backstopKey, now)
		if err != nil {
			return nil, err
		}
		if ipCount > int64(PublicQaIPHourlyLimit) {
			return nil, httpx.TooManyRequests("当前网络访问过于频繁，请稍后再试")
		}
	}

	return &publicQaQuotaResult{Remaining: remaining, Limit: primaryLimit}, nil
}

// QaChat POST /api/public/qa/chat → 暂 503「AI 服务未就绪」。
// 开关校验与限流表读写逻辑已就绪（见 IsPublicQaEnabled / ConsumePublicQaQuota），
// 待 AI 层接入后在此恢复完整链路。
func QaChat(c *gin.Context) {
	ctx := c.Request.Context()

	// 站长关闭前台问答时按 TS 契约返回 403。
	if !sitecontent.IsPublicQaEnabled(ctx) {
		httpx.ErrorJSON(c, http.StatusForbidden, "站长已关闭前台问答功能")
		return
	}

	httpx.ErrorJSON(c, http.StatusServiceUnavailable, "AI 服务未就绪")
}
