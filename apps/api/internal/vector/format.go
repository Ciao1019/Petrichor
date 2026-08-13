package vector

import (
	"fmt"
	"strconv"
	"strings"
)

const Dimensions = 1024

// FormatPGVector 将 float32 切片格式化为 pgvector 字面量 `[1,2,...]`。
func FormatPGVector(vec []float32) string {
	if len(vec) == 0 {
		return "[]"
	}
	parts := make([]string, len(vec))
	for i, v := range vec {
		parts[i] = strconv.FormatFloat(float64(v), 'f', -1, 32)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// ParsePGVector 解析 pgvector 字面量（用于单测）。
func ParsePGVector(raw string) ([]float32, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "[]" {
		return nil, nil
	}
	if !strings.HasPrefix(raw, "[") || !strings.HasSuffix(raw, "]") {
		return nil, fmt.Errorf("pgvector 格式无效")
	}
	inner := strings.TrimSpace(raw[1 : len(raw)-1])
	if inner == "" {
		return nil, nil
	}
	parts := strings.Split(inner, ",")
	out := make([]float32, 0, len(parts))
	for _, part := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(part), 32)
		if err != nil {
			return nil, fmt.Errorf("解析 pgvector 分量失败: %w", err)
		}
		out = append(out, float32(v))
	}
	return out, nil
}
