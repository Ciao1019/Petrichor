// about.go 移植 src/server/about/logic.ts + handlers.ts 的公开侧读取：
// 单例资料缺失/字段为空时逐项回退默认值，缺表（迁移未执行）时回退默认响应。
package sitecontent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/cache"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// AboutProfileID 「关于我」单例行 ID。
const AboutProfileID = 1

var accentStyles = []string{"red", "orange", "green", "teal", "blue", "purple", "pink", "yellow"}

// AboutAccent 正文注记样式：red/orange/green/teal/blue/purple/pink 为手绘波浪下划线，yellow 为荧光笔高亮。
type AboutAccent struct {
	Phrase string `json:"phrase"`
	Style  string `json:"style"`
	Note   string `json:"note,omitempty"`
}

var defaultAboutExpertise = []string{"Frontend Architecture", "AI 应用开发", "Knowledge Systems", "Creative Coding"}
var defaultAboutToolkit = []string{"TypeScript", "React", "Next.js", "AI", "PostgreSQL", "Minecraft"}
var defaultAboutAccents = []AboutAccent{
	{Phrase: "CiZai", Style: "red", Note: "yep, that's me"},
	{Phrase: "程序员", Style: "green", Note: "just a dev"},
	{Phrase: "金山办公", Style: "blue", Note: "where I work"},
	{Phrase: "Coding / AI", Style: "green", Note: "my playground"},
	{Phrase: "Minecraft", Style: "blue", Note: "★ my comfort game"},
}

const (
	defaultAboutDisplayName  = "CiZai"
	defaultAboutRoleTitle    = "Creative Dev & Visual Artist"
	defaultAboutIntro        = "我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。"
	defaultAboutQuote        = "Code is just another medium for painting dreams."
	defaultAboutContactText  = "想聊点什么？随时"
	defaultAboutContactLabel = "message me"
	defaultAboutContactHref  = "mailto:zang@linux.do"
)

type aboutProfileRecord struct {
	DisplayName   string
	RoleTitle     string
	Intro         string
	ExpertiseJSON *string
	ToolkitJSON   *string
	Quote         string
	AccentsJSON   *string
	ContactText   *string
	ContactLabel  *string
	ContactHref   *string
	CreatedAt     *time.Time
	UpdatedAt     *time.Time
}

func isAccentStyle(v string) bool {
	for _, item := range accentStyles {
		if item == v {
			return true
		}
	}
	return false
}

func cloneAccents(values []AboutAccent) []AboutAccent {
	out := make([]AboutAccent, len(values))
	copy(out, values)
	return out
}

// accentsToResponse 空注记省略 note 字段，与 TS 对象形状一致。
func accentsToResponse(values []AboutAccent) []map[string]any {
	out := make([]map[string]any, 0, len(values))
	for _, accent := range values {
		item := map[string]any{"phrase": accent.Phrase, "style": accent.Style}
		if accent.Note != "" {
			item["note"] = accent.Note
		}
		out = append(out, item)
	}
	return out
}

func normalizeAccents(raw []any) []AboutAccent {
	seen := map[string]struct{}{}
	values := []AboutAccent{}
	for _, item := range raw {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		phrase := strings.TrimSpace(anyToString(record["phrase"]))
		if phrase == "" {
			continue
		}
		if _, dup := seen[phrase]; dup {
			continue
		}
		styleRaw := strings.TrimSpace(anyToString(record["style"]))
		style := styleRaw
		if !isAccentStyle(styleRaw) {
			style = "red"
		}
		note := strings.TrimSpace(anyToString(record["note"]))
		seen[phrase] = struct{}{}
		values = append(values, AboutAccent{Phrase: phrase, Style: style, Note: note})
	}
	return values
}

// parseAccentsJSON 缺失/损坏回退默认；合法但为空数组（用户主动清空）则尊重为空。
func parseAccentsJSON(raw *string) []AboutAccent {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return cloneAccents(defaultAboutAccents)
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return cloneAccents(defaultAboutAccents)
	}
	arr, ok := parsed.([]any)
	if !ok {
		return cloneAccents(defaultAboutAccents)
	}
	return normalizeAccents(arr)
}

func parseProfileListJSON(raw *string, fallback []string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return append([]string{}, fallback...)
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return append([]string{}, fallback...)
	}
	arr, ok := parsed.([]any)
	if !ok {
		return append([]string{}, fallback...)
	}
	values := normalizeListForRead(arr)
	if len(values) == 0 {
		return append([]string{}, fallback...)
	}
	return values
}

func normalizeListForRead(raw []any) []string {
	seen := map[string]struct{}{}
	values := []string{}
	for _, item := range raw {
		value := strings.TrimSpace(anyToString(item))
		if value == "" {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func anyToString(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return value
	case float64:
		if value == float64(int64(value)) {
			return jsonNumber(int64(value))
		}
		return trimFloat(value)
	case bool:
		if value {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func jsonNumber(n int64) string {
	return strings.TrimSpace(strconvFormatInt(n))
}

// BuildAboutProfileResponse 记录为空时整体回退默认；字段为空逐项回退。
func BuildAboutProfileResponse(record *aboutProfileRecord) map[string]any {
	if record == nil {
		return map[string]any{
			"displayName":  defaultAboutDisplayName,
			"roleTitle":    defaultAboutRoleTitle,
			"intro":        defaultAboutIntro,
			"expertise":    append([]string{}, defaultAboutExpertise...),
			"toolkit":      append([]string{}, defaultAboutToolkit...),
			"quote":        defaultAboutQuote,
			"accents":      accentsToResponse(cloneAccents(defaultAboutAccents)),
			"contactText":  defaultAboutContactText,
			"contactLabel": defaultAboutContactLabel,
			"contactHref":  defaultAboutContactHref,
			"createdAt":    nil,
			"updatedAt":    nil,
		}
	}

	safeText := func(value string, fallback string) string {
		if strings.TrimSpace(value) == "" {
			return fallback
		}
		return value
	}
	derefOr := func(v *string, fallback string) string {
		if v == nil {
			return fallback
		}
		return *v
	}
	formatTime := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return httpx.FormatISO(*t)
	}

	return map[string]any{
		"displayName": safeText(record.DisplayName, defaultAboutDisplayName),
		"roleTitle":   safeText(record.RoleTitle, defaultAboutRoleTitle),
		"intro":       safeText(record.Intro, defaultAboutIntro),
		"expertise":   parseProfileListJSON(record.ExpertiseJSON, defaultAboutExpertise),
		"toolkit":     parseProfileListJSON(record.ToolkitJSON, defaultAboutToolkit),
		"quote":       safeText(record.Quote, defaultAboutQuote),
		"accents":     accentsToResponse(parseAccentsJSON(record.AccentsJSON)),
		// 联系方式三项允许为空（用户可清空以隐藏），故不走 safeText 回退默认。
		"contactText":  derefOr(record.ContactText, defaultAboutContactText),
		"contactLabel": derefOr(record.ContactLabel, defaultAboutContactLabel),
		"contactHref":  derefOr(record.ContactHref, defaultAboutContactHref),
		"createdAt":    formatTime(record.CreatedAt),
		"updatedAt":    formatTime(record.UpdatedAt),
	}
}

// loadAboutProfileOrNull 读取单例；缺表（42P01）或无记录回退 nil。
func loadAboutProfileOrNull(ctx context.Context) (*aboutProfileRecord, error) {
	row := db.Pool().QueryRow(ctx,
		`SELECT display_name, role_title, intro, expertise_json, toolkit_json, quote, accents_json,
		        contact_text, contact_label, contact_href, created_at, updated_at
		 FROM petrichor_site_about_profile WHERE id = $1 LIMIT 1`, AboutProfileID)
	var r aboutProfileRecord
	err := row.Scan(&r.DisplayName, &r.RoleTitle, &r.Intro, &r.ExpertiseJSON, &r.ToolkitJSON,
		&r.Quote, &r.AccentsJSON, &r.ContactText, &r.ContactLabel, &r.ContactHref,
		&r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil && isUndefinedTableErr(err) {
		// 读取接口允许在增量 SQL 尚未执行时回退默认值。
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// LoadPublicAboutProfileResponse 公开「关于我」响应（未缓存）。
func LoadPublicAboutProfileResponse(ctx context.Context) (map[string]any, error) {
	record, err := loadAboutProfileOrNull(ctx)
	if err != nil {
		return nil, err
	}
	return BuildAboutProfileResponse(record), nil
}

// LoadCachedPublicAboutProfile 读穿透缓存的公开「关于我」响应。
func LoadCachedPublicAboutProfile(ctx context.Context) (map[string]any, error) {
	return cache.ReadThrough(aboutProfileCacheKey, TTLSeconds, func() (map[string]any, error) {
		return LoadPublicAboutProfileResponse(ctx)
	})
}
