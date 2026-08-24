package runtime

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ===== ID 生成（对照 ids.ts）=====

// NewID 统一 id 生成，便于测试注入与 trace 关联。
func NewID(prefix string) string {
	return prefix + "_" + randomHex(10)
}

// NewRunID Run 级 id。
func NewRunID() string { return NewID("run") }

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%x", strings.Repeat("0", n))
	}
	return hex.EncodeToString(buf)[:n*2]
}

// ===== 稳定哈希（对照 loop-detector.ts stableHash/stableStringify）=====

// StableHash 稳定序列化后哈希：对象 key 排序，保证同义参数得到同一指纹。
func StableHash(value any) string {
	sum := sha1.Sum([]byte(stableStringify(value)))
	return hex.EncodeToString(sum[:])[:16]
}

func stableStringify(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		b, _ := jsonMarshal(v)
		return string(b)
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64, float32, int, int64, int32:
		return fmt.Sprintf("%v", normalizeNumber(v))
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return `"` + fmt.Sprintf("%v", v) + `"`
		}
		var generic any
		if json.Unmarshal(raw, &generic) != nil {
			return string(raw)
		}
		return canonicalJSON(generic)
	}
}

func normalizeNumber(v any) float64 {
	switch n := v.(type) {
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case int32:
		return float64(n)
	case float32:
		return float64(n)
	case float64:
		return n
	}
	return 0
}

// canonicalJSON 递归排序 key，等价 TS stableStringify。
func canonicalJSON(value any) string {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var sb strings.Builder
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			sb.Write(kb)
			sb.WriteByte(':')
			sb.WriteString(canonicalJSON(v[k]))
		}
		sb.WriteByte('}')
		return sb.String()
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			parts = append(parts, canonicalJSON(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return "null"
		}
		return string(b)
	}
}

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}
