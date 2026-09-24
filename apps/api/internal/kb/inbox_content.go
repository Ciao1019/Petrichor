package kb

import (
	"encoding/json"
	"strings"
)

// 同时保留文章编辑器的结构和批注，旧 Markdown 请求允许省略这两个字段。
func parseInboxRichContent(raw map[string]any) (*string, *string, error) {
	content, err := normalizeInboxJSON(raw["contentJson"], false, 2*1024*1024)
	if err != nil {
		return nil, nil, err
	}
	meta, err := normalizeInboxJSON(raw["contentMetaJson"], true, 256*1024)
	return content, meta, err
}

func normalizeInboxJSON(raw any, meta bool, maxBytes int) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	text, ok := raw.(string)
	if !ok || len(text) > maxBytes {
		return nil, badReq("随笔富文本数据格式无效或过大")
	}
	if strings.TrimSpace(text) == "" {
		return nil, nil
	}
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, badReq("随笔富文本数据必须是有效 JSON")
	}
	_, array := value.([]any)
	object, isObject := value.(map[string]any)
	_, wrappedArray := object["value"].([]any)
	if (meta && !isObject) || (!meta && !array && !wrappedArray) {
		return nil, badReq("随笔富文本数据结构无效")
	}
	// 规范化键序与空白，网络重试比较的是内容而非 JSON 排版。
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, badReq("随笔富文本数据格式无效")
	}
	normalized := string(encoded)
	return &normalized, nil
}

func equalInboxJSON(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
