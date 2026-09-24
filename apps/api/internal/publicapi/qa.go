// qa.go 前台公开问答的访客标识、限流配额与站点所有者；问答编排见 assistantsvc/public_chat.go。
package publicapi

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/ratelimit"
)

// FingerprintHeader 前台问答携带 FingerprintJS visitorId 的请求头。
const FingerprintHeader = "X-Petrichor-Fingerprint"

var (
	// 单浏览器指纹每小时提问上限——面向真实访客的主限流键。
	publicQaFingerprintRule = ratelimit.Rule{
		Name: "public-qa:fingerprint", Limit: 10, Period: time.Hour,
		Message: "提问次数已达每小时 10 次的上限",
	}
	// 单 IP 每小时提问兜底上限——防止伪造或轮换指纹后无限刷量。
	publicQaIPRule = ratelimit.Rule{
		Name: "public-qa:ip", Limit: 60, Period: time.Hour,
		Message: "当前网络提问过于频繁",
	}
	// 没有指纹时与 IP 兜底共用同一个计数，但按单浏览器额度收紧，省略请求头换不来更高上限。
	publicQaAnonymousIPRule = ratelimit.Rule{
		Name: publicQaIPRule.Name, Limit: publicQaFingerprintRule.Limit, Period: time.Hour,
		Message: publicQaFingerprintRule.Message,
	}
)

// FingerprintJS visitorId 为 128 位 MurmurHash 的 32 位小写十六进制。
var fingerprintPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ResolveClientIp 只接受 Gin 根据 server.trusted_proxies 解析后的地址。
func ResolveClientIp(c *gin.Context) string {
	return strings.TrimSpace(c.ClientIP())
}

// ResolveFingerprint 读取并校验浏览器指纹；缺失或格式非法返回空串。
func ResolveFingerprint(c *gin.Context) string {
	raw := strings.ToLower(strings.TrimSpace(c.GetHeader(FingerprintHeader)))
	if !fingerprintPattern.MatchString(raw) {
		return ""
	}
	return raw
}

// ConsumePublicQaQuota 指纹主键（10/h）+ IP 兜底（60/h），任一维度用尽返回 429；
// 没有指纹时只按 IP 计数，上限同单浏览器。
func ConsumePublicQaQuota(ctx context.Context, fingerprint, ip string) (ratelimit.Quota, error) {
	if fingerprint == "" {
		return ratelimit.Consume(ctx, ratelimit.Key{Rule: publicQaAnonymousIPRule, Value: ip})
	}
	return ratelimit.Consume(ctx,
		ratelimit.Key{Rule: publicQaFingerprintRule, Value: fingerprint},
		ratelimit.Key{Rule: publicQaIPRule, Value: ip},
	)
}

// loadSiteOwnerUserID 对应 getSiteOwnerUserId：首个 SUPER_ADMIN 即站点所有者。
func loadSiteOwnerUserID(ctx context.Context) (int64, error) {
	var id int64
	err := pool().QueryRow(ctx,
		`SELECT id FROM petrichor_user WHERE system_role = 'SUPER_ADMIN' ORDER BY id ASC LIMIT 1`).
		Scan(&id)
	if err != nil {
		return 0, badReq("公开问答暂不可用：站点尚未初始化站长账号")
	}
	return id, nil
}
