// about.go 移植 src/server/about/logic.ts + handlers.ts（admin 侧）：
// 「关于我」单例资料的默认回退、校验归一化与 upsert。
package adminpanel

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/cache"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const AboutProfileID = 1

var accentStyles = []string{"red", "orange", "green", "teal", "blue", "purple", "pink", "yellow"}

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

	aboutLimitDisplayName  = 100
	aboutLimitRoleTitle    = 160
	aboutLimitIntro        = 4000
	aboutLimitQuote        = 500
	aboutLimitListItem     = 100
	aboutLimitListCount    = 20
	aboutLimitContactText  = 200
	aboutLimitContactLabel = 80
	aboutLimitContactHref  = 400
	aboutAccentCountLimit  = 24
	aboutAccentPhraseLimit = 100
	aboutAccentNoteLimit   = 100
)

func isAccentStyle(v string) bool { return inList(accentStyles, v) }

func cloneAccents(values []AboutAccent) []AboutAccent {
	out := make([]AboutAccent, len(values))
	copy(out, values)
	return out
}

func accentsToJSON(values []AboutAccent) []map[string]any {
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

// normalizeAccents 归一化注记数组：丢弃非对象/空短语项，按短语去重，style 非法回退 red。
func normalizeAccents(raw []any) []AboutAccent {
	seen := map[string]struct{}{}
	values := []AboutAccent{}
	for _, item := range raw {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		phrase := strings.TrimSpace(toStringValue(record["phrase"]))
		if phrase == "" {
			continue
		}
		if _, dup := seen[phrase]; dup {
			continue
		}
		styleRaw := strings.TrimSpace(toStringValue(record["style"]))
		style := styleRaw
		if !isAccentStyle(styleRaw) {
			style = "red"
		}
		note := strings.TrimSpace(toStringValue(record["note"]))
		seen[phrase] = struct{}{}
		values = append(values, AboutAccent{Phrase: phrase, Style: style, Note: note})
	}
	return values
}

// parseAccentsJSON 读取库中 accents JSON：缺失/损坏回退默认；合法但为空则尊重为空。
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
	values := normalizeListForRead(arr, nil)
	if len(values) == 0 {
		return append([]string{}, fallback...)
	}
	return values
}

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

// BuildAboutProfileResponse 记录缺失或字段为空时逐项回退默认值。
func BuildAboutProfileResponse(record *aboutProfileRecord) map[string]any {
	if record == nil {
		return map[string]any{
			"displayName":  defaultAboutDisplayName,
			"roleTitle":    defaultAboutRoleTitle,
			"intro":        defaultAboutIntro,
			"expertise":    append([]string{}, defaultAboutExpertise...),
			"toolkit":      append([]string{}, defaultAboutToolkit...),
			"quote":        defaultAboutQuote,
			"accents":      accentsToJSON(cloneAccents(defaultAboutAccents)),
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
		"displayName":  safeText(record.DisplayName, defaultAboutDisplayName),
		"roleTitle":    safeText(record.RoleTitle, defaultAboutRoleTitle),
		"intro":        safeText(record.Intro, defaultAboutIntro),
		"expertise":    parseProfileListJSON(record.ExpertiseJSON, defaultAboutExpertise),
		"toolkit":      parseProfileListJSON(record.ToolkitJSON, defaultAboutToolkit),
		"quote":        safeText(record.Quote, defaultAboutQuote),
		"accents":      accentsToJSON(parseAccentsJSON(record.AccentsJSON)),
		"contactText":  derefOr(record.ContactText, defaultAboutContactText),
		"contactLabel": derefOr(record.ContactLabel, defaultAboutContactLabel),
		"contactHref":  derefOr(record.ContactHref, defaultAboutContactHref),
		"createdAt":    formatTime(record.CreatedAt),
		"updatedAt":    formatTime(record.UpdatedAt),
	}
}

// LoadAboutProfileOrNull 读取单例记录；缺表或无记录时回退 nil。
func LoadAboutProfileOrNull(ctx context.Context) (*aboutProfileRecord, error) {
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
		// 读取接口允许在增量 SQL 尚未执行时回退默认值；写入仍要求先应用迁移。
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// normalizeRequiredMultiline 复刻 normalizeRequiredText：
// 字段缺失/null 用默认值兜底，显式空串报错；逐行裁剪保留换行。
func normalizeRequiredMultiline(input map[string]any, field, fallback, label string, maxLength int) (string, error) {
	raw, present := input[field]
	value := ""
	if present && raw != nil {
		value = strings.TrimSpace(strings.Join(trimmedLines(splitLines(toStringValue(raw))), "\n"))
	} else {
		value = strings.TrimSpace(strings.Join(trimmedLines(splitLines(fallback)), "\n"))
	}
	if value == "" {
		return "", httpx.BadRequest(label + "不能为空")
	}
	if runeLen(value) > maxLength {
		return "", httpx.BadRequest(label + "长度不能超过 " + strconv.Itoa(maxLength))
	}
	return value, nil
}

func trimmedLines(lines []string) []string {
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = strings.TrimSpace(line)
	}
	return out
}

// validateAboutProfileInput 复刻 validateAboutProfileInput 的全部规则与报错信息。
func validateAboutProfileInput(input map[string]any) (map[string]any, error) {
	result := map[string]any{}

	displayName, err := normalizeRequiredMultiline(input, "displayName", defaultAboutDisplayName, "名称", aboutLimitDisplayName)
	if err != nil {
		return nil, err
	}
	roleTitle, err := normalizeRequiredMultiline(input, "roleTitle", defaultAboutRoleTitle, "副标题", aboutLimitRoleTitle)
	if err != nil {
		return nil, err
	}
	intro, err := normalizeRequiredMultiline(input, "intro", defaultAboutIntro, "自我介绍", aboutLimitIntro)
	if err != nil {
		return nil, err
	}
	quote, err := normalizeRequiredMultiline(input, "quote", defaultAboutQuote, "quote", aboutLimitQuote)
	if err != nil {
		return nil, err
	}

	requiredList := func(field, label string, fallback []string) ([]string, error) {
		var source []any
		raw, present := input[field]
		switch {
		case !present || raw == nil:
			source = anySliceFromStrings(fallback)
		case isArrayValue(raw):
			source, _ = raw.([]any)
		default:
			source = anySliceFromStrings(splitLines(toStringValue(raw)))
		}
		values := normalizeListForRead(source, nil)
		if len(values) == 0 {
			return nil, httpx.BadRequest(label + " 不能为空")
		}
		if len(values) > aboutLimitListCount {
			return nil, httpx.BadRequest(label + " 数量不能超过 " + strconv.Itoa(aboutLimitListCount))
		}
		for _, item := range values {
			if runeLen(item) > aboutLimitListItem {
				return nil, httpx.BadRequest(label + " 单项长度不能超过 " + strconv.Itoa(aboutLimitListItem))
			}
		}
		return values, nil
	}

	expertise, err := requiredList("expertise", "Expertise", defaultAboutExpertise)
	if err != nil {
		return nil, err
	}
	toolkit, err := requiredList("toolkit", "Toolkit", defaultAboutToolkit)
	if err != nil {
		return nil, err
	}

	accentsRaw, _ := input["accents"].([]any)
	accents := normalizeAccents(accentsRaw)
	if len(accents) > aboutAccentCountLimit {
		return nil, httpx.BadRequest("正文注记数量不能超过 " + strconv.Itoa(aboutAccentCountLimit))
	}
	for _, accent := range accents {
		if runeLen(accent.Phrase) > aboutAccentPhraseLimit {
			return nil, httpx.BadRequest("正文注记短语长度不能超过 " + strconv.Itoa(aboutAccentPhraseLimit))
		}
		if accent.Note != "" && runeLen(accent.Note) > aboutAccentNoteLimit {
			return nil, httpx.BadRequest("正文注记气泡文案长度不能超过 " + strconv.Itoa(aboutAccentNoteLimit))
		}
	}

	optionalText := func(field, label string, maxLength int) (string, error) {
		value := normalizeOneLineValue(toStringValue(input[field]))
		if runeLen(value) > maxLength {
			return "", httpx.BadRequest(label + "长度不能超过 " + strconv.Itoa(maxLength))
		}
		return value, nil
	}
	contactText, err := optionalText("contactText", "联系引导语", aboutLimitContactText)
	if err != nil {
		return nil, err
	}
	contactLabel, err := optionalText("contactLabel", "联系链接文字", aboutLimitContactLabel)
	if err != nil {
		return nil, err
	}
	contactHref, err := optionalText("contactHref", "联系链接地址", aboutLimitContactHref)
	if err != nil {
		return nil, err
	}

	result["displayName"] = displayName
	result["roleTitle"] = roleTitle
	result["intro"] = intro
	result["expertise"] = expertise
	result["toolkit"] = toolkit
	result["quote"] = quote
	result["accents"] = accents
	result["contactText"] = contactText
	result["contactLabel"] = contactLabel
	result["contactHref"] = contactHref
	return result, nil
}

func anySliceFromStrings(items []string) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		out = append(out, item)
	}
	return out
}

func isArrayValue(raw any) bool {
	_, ok := raw.([]any)
	return ok
}

// invalidatePublicCacheKeys 失效公开内容缓存键（petrichor:public:<name>）。
func invalidatePublicCacheKeys(name string) {
	cache.Drop(cache.CacheKey("public", name))
}

// AdminAboutProfileDetail GET /api/admin/about/profile。
func AdminAboutProfileDetail(c *gin.Context) {
	record, err := LoadAboutProfileOrNull(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, BuildAboutProfileResponse(record))
}

// AdminAboutProfileUpdate POST /api/admin/about/profile。
func AdminAboutProfileUpdate(c *gin.Context) {
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	input, err := validateAboutProfileInput(body)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	expertiseJSON, jerr := marshalJSONCompact(input["expertise"].([]string))
	if jerr != nil {
		httpx.HandleError(c, jerr)
		return
	}
	toolkitJSON, jerr := marshalJSONCompact(input["toolkit"].([]string))
	if jerr != nil {
		httpx.HandleError(c, jerr)
		return
	}
	accentsJSON, jerr := marshalJSONCompact(input["accents"].([]AboutAccent))
	if jerr != nil {
		httpx.HandleError(c, jerr)
		return
	}

	now := time.Now()
	_, uerr := db.Pool().Exec(c.Request.Context(),
		`INSERT INTO petrichor_site_about_profile
		 (id, display_name, role_title, intro, expertise_json, toolkit_json, quote, accents_json,
		  contact_text, contact_label, contact_href, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
		 ON CONFLICT (id) DO UPDATE SET
		   display_name=$2, role_title=$3, intro=$4, expertise_json=$5, toolkit_json=$6, quote=$7,
		   accents_json=$8, contact_text=$9, contact_label=$10, contact_href=$11, updated_at=$12`,
		AboutProfileID,
		input["displayName"], input["roleTitle"], input["intro"], expertiseJSON, toolkitJSON,
		input["quote"], accentsJSON,
		input["contactText"], input["contactLabel"], input["contactHref"], now)
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}

	record, lerr := LoadAboutProfileOrNull(c.Request.Context())
	if lerr != nil {
		httpx.HandleError(c, lerr)
		return
	}
	invalidatePublicCacheKeys("about-profile")
	httpx.OK(c, BuildAboutProfileResponse(record))
}
