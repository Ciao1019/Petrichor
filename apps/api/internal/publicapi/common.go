// Package publicapi 复刻公开侧 API（/api/public/**）：
// 站点内容读取、公开文章列表/搜索/分享详情、阅后即焚、公开 Wiki、下载预签名。
// 前台问答 chat 流式端点本轮不做流式，注册为 503「AI 服务未就绪」。
package publicapi

import (
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
)

func badReq(msg string) error { return httpx.BadRequest(msg) }

func notFoundErr(msg string) error { return httpx.NotFound(msg) }

func forbiddenErr(msg string) error { return httpx.Forbidden(msg) }

// readBody 解析 JSON 请求体为通用 map（对应 readJson）。
func readBody(c *gin.Context) (map[string]any, error) {
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		return nil, badReq("请求体必须是合法 JSON")
	}
	return raw, nil
}

func toStr(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return value
	case float64:
		if value == float64(int64(value)) {
			return formatInt(int64(value))
		}
		return strings.TrimSpace(formatFloat(value))
	case bool:
		if value {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func rawString(raw map[string]any, key string) string {
	if v, ok := raw[key]; ok && v != nil {
		return toStr(v)
	}
	return ""
}

// parseJSONObject 对应 parseJsonOrNull（对象形态）：解析失败返回 nil。
func parseJSONObject(raw *string) map[string]any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

// validateShareCode 复刻 validatePublicShareDetailInput 的分享码规则。
func validateShareCode(shareCode string) (string, error) {
	code := strings.TrimSpace(shareCode)
	if code == "" {
		return "", badReq("分享码不能为空")
	}
	if !shareCodePattern.MatchString(code) {
		return "", badReq("分享码非法")
	}
	return code, nil
}

// validateAccessPassword 复刻 validateSharePassword：空放行，非 6 位数字报错。
func validateAccessPassword(accessPassword string) error {
	password := strings.TrimSpace(accessPassword)
	if password != "" && !passwordPattern.MatchString(password) {
		return badReq("访问密码格式非法")
	}
	return nil
}

// validateBurnLinkCode 校验公开访问的链接码（meta GET 与 consume POST 共用）。
func validateBurnLinkCode(raw string) (string, error) {
	code := strings.TrimSpace(raw)
	if code == "" {
		return "", badReq("链接码不能为空")
	}
	if !shareCodePattern.MatchString(code) {
		return "", badReq("链接码非法")
	}
	return code, nil
}
