// helpers.go 请求体读取与 ID 兼容类型（对应 zod 的 string|number 联合与可选语义）。
package assistantsvc

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
)

// reqFlexID 必填 ID：字符串或数字形式的正整数（对应 assistantIdSchema）。
// 缺失保持 0，由调用方校验；显式 null 或非法值在反序列化时报错。
type reqFlexID int64

func (r *reqFlexID) UnmarshalJSON(data []byte) error {
	n, err := parseFlexID(data)
	if err != nil {
		return err
	}
	*r = reqFlexID(n)
	return nil
}

func (r reqFlexID) Int64() int64 { return int64(r) }

// optFlexID 可选可空 ID（对应 assistantIdSchema.optional().nullable()）。
type optFlexID struct {
	Value   int64
	Present bool
}

func (o *optFlexID) UnmarshalJSON(data []byte) error {
	if isJSONNull(data) {
		return nil
	}
	n, err := parseFlexID(data)
	if err != nil {
		return err
	}
	o.Value = n
	o.Present = true
	return nil
}

func (o *optFlexID) Int64() int64 { return o.Value }

func parseFlexID(data []byte) (int64, error) {
	s := strings.TrimSpace(string(data))
	if s == "null" {
		return 0, httpx.BadRequest("ID 必须是正整数")
	}
	if unquoted, err := strconv.Unquote(s); err == nil {
		s = unquoted
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, httpx.BadRequest("ID 必须是正整数")
	}
	return n, nil
}

// readBodyStrict 对应 readJson + schema.parse：
// 坏体/类型不匹配按 HttpError 抛出，由统一错误出口渲染。
func readBodyStrict(c *gin.Context, target any) error {
	if err := c.ShouldBindJSON(target); err != nil {
		if he, ok := err.(*httpx.HttpError); ok {
			return he
		}
		return httpx.BadRequest("请求体必须是合法 JSON")
	}
	return nil
}

// readBodyLenient 对应 readJson(...).catch(() => ({}))：
// 坏体回落零值继续；好体但字段类型不匹配报「请求参数错误」。
func readBodyLenient(c *gin.Context, target any) error {
	raw, err := c.GetRawData()
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		if he, ok := err.(*httpx.HttpError); ok {
			return he
		}
		return httpx.BadRequest("请求参数错误")
	}
	return nil
}

// toFlatString 任意 JSON 标量转字符串（frontmatter aliases 等）。
func toFlatString(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return value
	case float64:
		if value == float64(int64(value)) {
			return strconv.FormatInt(int64(value), 10)
		}
		return strconv.FormatFloat(value, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(value)
	default:
		return ""
	}
}
