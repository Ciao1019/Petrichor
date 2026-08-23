// helpers.go adminpanel 内部共用的弱类型取值工具：
// TS 侧大量 String(raw ?? "") / Number(raw) 式松散转换，这里统一收口。
package adminpanel

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	httpx "petrichor/api/internal/httpx"
)

// toStringValue 复刻 String(value ?? "")：null/undefined → ""，
// 字符串原样，数字按 Go 浮点格式化，布尔转 true/false，其余 JSON 序列化。
func toStringValue(raw any) string {
	switch v := raw.(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	case bool:
		return strconv.FormatBool(v)
	case int:
		return strconv.Itoa(v)
	case int32:
		return strconv.FormatInt(int64(v), 10)
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(raw)
	}
}

// toFloatValue 复刻 Number(value)：无法解析返回 NaN。
func toFloatValue(raw any) float64 {
	switch v := raw.(type) {
	case nil:
		return nan()
	case float64:
		return v
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return nan()
		}
		return f
	case string:
		t := strings.TrimSpace(v)
		if t == "" {
			return 0 // JS Number("") === 0
		}
		f, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return nan()
		}
		return f
	case bool:
		if v {
			return 1
		}
		return 0
	default:
		return nan()
	}
}

func toBoolValue(raw any) bool {
	switch v := raw.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true")
	case float64:
		return v != 0
	default:
		return false
	}
}

func orValue(a, b any) any {
	if a == nil {
		return b
	}
	return a
}

func orValue3(a, b, c any) any {
	if a != nil {
		return a
	}
	if b != nil {
		return b
	}
	return c
}

// orValueDefault 区分「字段缺失」与「值为 null」：null 视为缺失并回退默认。
func orValueDefault(raw, fallback any) any {
	if raw == nil {
		return fallback
	}
	return raw
}

func appendAny(base []any, items ...any) []any {
	return append(base, items...)
}

// nan 复刻 JS NaN 哨兵。
var nanValue = math.NaN()

func nan() float64 { return nanValue }

// sortStrings 就地排序（用于稳定遍历 map）。
func sortStrings(items []string) {
	sort.Strings(items)
}

// formatISO 统一 ISO 时间输出（复刻 Date.toISOString）。
func formatISO(t time.Time) string {
	return httpx.FormatISO(t)
}

// splitLines 复刻 String(raw).split(/\r?\n/)。
func splitLines(value string) []string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.Split(value, "\n")
}

// runeLen 按 rune 计数（近似 JS String.length 的 BMP 场景）。
func runeLen(s string) int { return len([]rune(s)) }

// strconvItoa 简化引用。
func strconvItoa(v int) string { return strconv.Itoa(v) }

// normalizeOneLineValue 单行文本：折叠换行/空白为一个空格并裁剪首尾。
func normalizeOneLineValue(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	parts := make([]string, 0)
	for _, line := range strings.Split(value, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

// marshalJSONCompact 序列化为紧凑 JSON 字符串。
func marshalJSONCompact(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// isUndefinedTableErr 判断是否 42P01（表不存在，迁移未执行）。
func isUndefinedTableErr(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "42P01"
	}
	return false
}

// normalizeListForRead 去重去空的字符串列表；全空时回退 fallback。
func normalizeListForRead(raw []any, fallback []string) []string {
	seen := map[string]struct{}{}
	values := []string{}
	for _, item := range raw {
		value := strings.TrimSpace(toStringValue(item))
		if value == "" {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	if len(values) == 0 && fallback != nil {
		return append([]string{}, fallback...)
	}
	return values
}
