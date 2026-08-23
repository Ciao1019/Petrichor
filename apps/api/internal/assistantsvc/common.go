// Package assistantsvc 是站内助手组（/api/assistant/*，11 端点）的 Go 移植，
// 对照 apps/web/src/server/assistant/*（thread-handlers / chat-handler /
// agent-run-handlers / wiki-handlers）。租户隔离一律以 user.ID 为准。
package assistantsvc

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const assistantThreadDetailMessageLimit = 200

const defaultThreadTitle = "新对话"

func dbPool() *pgxpool.Pool { return db.Pool() }

func currentUserOf(c *gin.Context) *auth.User {
	return auth.CurrentUser(c)
}

// ===== focus 解析与归属校验（focus-guard.ts）=====

type assistantFocus struct {
	KnowledgeBaseID *string `json:"knowledgeBaseId,omitempty"`
	LibraryID       *string `json:"libraryId,omitempty"`
	ArticleID       *string `json:"articleId,omitempty"`
	DocumentID      *string `json:"documentId,omitempty"`
}

// flexFocusField 契约 4.1：focus 字段为 string | null；宽进（也接受 number）、归一化为字符串。
type flexFocusField struct{ Value *string }

func (f *flexFocusField) UnmarshalJSON(data []byte) error {
	s := strings.TrimSpace(string(data))
	if s == "" || s == "null" {
		f.Value = nil
		return nil
	}
	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		v := str
		f.Value = &v
		return nil
	}
	var num float64
	if err := json.Unmarshal(data, &num); err == nil {
		v := strconv.FormatFloat(num, 'f', -1, 64)
		f.Value = &v
		return nil
	}
	return httpx.BadRequest("请求参数错误")
}

type assistantFocusWire struct {
	KnowledgeBaseID flexFocusField `json:"knowledgeBaseId"`
	LibraryID       flexFocusField `json:"libraryId"`
	ArticleID       flexFocusField `json:"articleId"`
	DocumentID      flexFocusField `json:"documentId"`
}

// parseFocusInput 解析请求体里的 focus 字段：缺省/null → nil；非法形状 → 400。
func parseFocusInput(raw json.RawMessage) (*assistantFocus, error) {
	if len(raw) == 0 || isJSONNull(raw) {
		return nil, nil
	}
	var f assistantFocusWire
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, httpx.BadRequest("请求参数错误")
	}
	return &assistantFocus{
		KnowledgeBaseID: f.KnowledgeBaseID.Value,
		LibraryID:       f.LibraryID.Value,
		ArticleID:       f.ArticleID.Value,
		DocumentID:      f.DocumentID.Value,
	}, nil
}

// parseIntPrefix 复刻 Number.parseInt 的宽松前缀解析（如 "12abc" → 12）。
func parseIntPrefix(s string) (int64, bool) {
	t := strings.TrimLeft(s, " \t\n\r\f\v")
	i := 0
	if i < len(t) && (t[i] == '+' || t[i] == '-') {
		i++
	}
	start := i
	for i < len(t) && t[i] >= '0' && t[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.ParseInt(t[:i], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// assertFocusOwnership 对应 assertAssistantFocusOwnership：
// focus 实体非当前用户所有 → 403；ID 非法 → 400。focus 只约束默认上下文，这里只做归属校验。
func assertFocusOwnership(ctx context.Context, userID int64, focus *assistantFocus) error {
	if focus == nil {
		return nil
	}
	p := dbPool()
	checks := []struct {
		label string
		value *string
		table string
	}{
		{"knowledgeBaseId", focus.KnowledgeBaseID, "petrichor_kb_knowledge_base"},
		{"libraryId", focus.LibraryID, "petrichor_doc_library"},
		{"articleId", focus.ArticleID, "petrichor_kb_article"},
		{"documentId", focus.DocumentID, "petrichor_doc_document"},
	}
	for _, check := range checks {
		if check.value == nil {
			continue
		}
		id, ok := parseIntPrefix(*check.value)
		if !ok || id <= 0 {
			return httpx.BadRequest("focus." + check.label + " 不合法")
		}
		var one int32
		err := p.QueryRow(ctx,
			`SELECT 1 FROM `+check.table+` WHERE id = $1 AND user_id = $2 LIMIT 1`, id, userID).Scan(&one)
		if err == pgx.ErrNoRows {
			return httpx.Forbidden("无权访问 focus." + check.label + " 指向的实体")
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// ===== 标题摘要（thread-logic.ts summarizeThreadTitle）=====

// summarizeThreadTitle 折叠空白；空文本回落「新对话」；超长按 rune 截断加省略号。
func summarizeThreadTitle(text string, maxLength ...int) string {
	limit := 40
	if len(maxLength) > 0 && maxLength[0] > 0 {
		limit = maxLength[0]
	}
	normalized := strings.Join(strings.Fields(text), " ")
	if normalized == "" {
		return defaultThreadTitle
	}
	runes := []rune(normalized)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return normalized
}

// ===== JSON 工具 =====

func isJSONNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

func isJSONArray(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	for _, b := range raw {
		if b == ' ' || b == '\t' || b == '\n' || b == '\r' {
			continue
		}
		return b == '['
	}
	return false
}

func isJSONString(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	for _, b := range raw {
		if b == ' ' || b == '\t' || b == '\n' || b == '\r' {
			continue
		}
		return b == '"'
	}
	return false
}

func marshalJSONString(v any) *string {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	s := string(raw)
	return &s
}

func parseJSONValue(raw *string) any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var v any
	if err := json.Unmarshal([]byte(*raw), &v); err != nil {
		return nil
	}
	return v
}

func idStr(id int64) string { return strconv.FormatInt(id, 10) }

func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func runeLen(s string) int { return len([]rune(s)) }

func dedupeInt64(in []int64) []int64 {
	seen := make(map[int64]bool, len(in))
	out := make([]int64, 0, len(in))
	for _, v := range in {
		if seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}
