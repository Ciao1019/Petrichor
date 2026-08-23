// flex_optional.go 两种可选 ID 反序列化：
// - OptionalID：对应 zod optionalIdSchema（doc-library 风格）——非法静默归 null；
// - StrictOptionalID：对应 idSchema.optional().nullable()——非法直接报错。
package adminpanel

import (
	"strconv"
	"strings"

	httpx "petrichor/api/internal/httpx"
)

// OptionalID 宽松可选 ID。
type OptionalID struct {
	Value *int64
}

// StrictOptionalID 严格可选 ID（非法输入返回 400）。
type StrictOptionalID struct {
	Value *int64
}

func isDigitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func parseOptionalDigits(raw string) (*int64, bool) {
	t := strings.TrimSpace(raw)
	if t == "" || !isDigitsOnly(t) {
		return nil, true
	}
	n, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		return nil, true
	}
	return &n, true
}

func decodeOptionalID(data []byte) (*int64, bool, error) {
	s := strings.TrimSpace(string(data))
	switch {
	case s == "" || s == "null":
		return nil, true, nil
	case strings.HasPrefix(s, `"`):
		unquoted, err := strconv.Unquote(s)
		if err != nil {
			return nil, false, httpx.BadRequest("ID 必须是正整数")
		}
		value, ok := parseOptionalDigits(unquoted)
		return value, ok, nil
	case s[0] == '-' || (s[0] >= '0' && s[0] <= '9'):
		value, ok := parseOptionalDigits(s)
		return value, ok, nil
	default:
		return nil, false, httpx.BadRequest("ID 必须是正整数")
	}
}

func (f *OptionalID) UnmarshalJSON(data []byte) error {
	value, _, err := decodeOptionalID(data)
	f.Value = value
	return err
}

func (f *StrictOptionalID) UnmarshalJSON(data []byte) error {
	value, ok, err := decodeOptionalID(data)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.BadRequest("ID 必须是正整数")
	}
	f.Value = value
	return nil
}
