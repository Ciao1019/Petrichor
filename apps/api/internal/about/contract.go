package about

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

var defaultProfile = ProfileDTO{
	DisplayName: "CiZai",
	RoleTitle:   "Creative Dev & Visual Artist",
	Intro:       "我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。",
	Expertise:   []string{"Frontend Architecture", "AI 应用开发", "Knowledge Systems", "Creative Coding"},
	Toolkit:     []string{"TypeScript", "React", "Next.js", "AI", "PostgreSQL", "Minecraft"},
	Quote:       "Code is just another medium for painting dreams.",
	Accents: []Accent{
		{Phrase: "CiZai", Style: "red", Note: "yep, that's me"},
		{Phrase: "程序员", Style: "green", Note: "just a dev"},
		{Phrase: "金山办公", Style: "blue", Note: "where I work"},
		{Phrase: "Coding / AI", Style: "green", Note: "my playground"},
		{Phrase: "Minecraft", Style: "blue", Note: "★ my comfort game"},
	},
	ContactText: "想聊点什么？随时", ContactLabel: "message me", ContactHref: "mailto:zang@linux.do",
}

type profileInput struct {
	DisplayName, RoleTitle, Intro, Quote   string
	Expertise, Toolkit                     []string
	Accents                                []Accent
	ContactText, ContactLabel, ContactHref string
}

func buildProfileResponse(row *ent.SiteAboutProfile) ProfileDTO {
	if row == nil {
		result := defaultProfile
		result.Expertise = append([]string(nil), defaultProfile.Expertise...)
		result.Toolkit = append([]string(nil), defaultProfile.Toolkit...)
		result.Accents = append([]Accent(nil), defaultProfile.Accents...)
		return result
	}
	result := toDTO(row)
	result.DisplayName = fallbackText(row.DisplayName, defaultProfile.DisplayName)
	result.RoleTitle = fallbackText(row.RoleTitle, defaultProfile.RoleTitle)
	result.Intro = fallbackText(row.Intro, defaultProfile.Intro)
	result.Quote = fallbackText(row.Quote, defaultProfile.Quote)
	result.Expertise = parseListJSON(row.ExpertiseJSON, defaultProfile.Expertise)
	result.Toolkit = parseListJSON(row.ToolkitJSON, defaultProfile.Toolkit)
	result.Accents = parseAccentsJSON(row.AccentsJSON, defaultProfile.Accents)
	return result
}

func validateProfileInput(raw map[string]any) (profileInput, error) {
	displayName, err := requiredMultiline(raw["displayName"], defaultProfile.DisplayName, "名称", 100)
	if err != nil {
		return profileInput{}, err
	}
	roleTitle, err := requiredMultiline(raw["roleTitle"], defaultProfile.RoleTitle, "副标题", 160)
	if err != nil {
		return profileInput{}, err
	}
	intro, err := requiredMultiline(raw["intro"], defaultProfile.Intro, "自我介绍", 4000)
	if err != nil {
		return profileInput{}, err
	}
	expertise, err := requiredList(raw["expertise"], defaultProfile.Expertise, "Expertise")
	if err != nil {
		return profileInput{}, err
	}
	toolkit, err := requiredList(raw["toolkit"], defaultProfile.Toolkit, "Toolkit")
	if err != nil {
		return profileInput{}, err
	}
	quote, err := requiredMultiline(raw["quote"], defaultProfile.Quote, "quote", 500)
	if err != nil {
		return profileInput{}, err
	}
	accents, err := validateAccents(raw["accents"])
	if err != nil {
		return profileInput{}, err
	}
	contactText, err := optionalOneLine(raw["contactText"], "联系引导语", 200)
	if err != nil {
		return profileInput{}, err
	}
	contactLabel, err := optionalOneLine(raw["contactLabel"], "联系链接文字", 80)
	if err != nil {
		return profileInput{}, err
	}
	contactHref, err := optionalOneLine(raw["contactHref"], "联系链接地址", 400)
	if err != nil {
		return profileInput{}, err
	}
	return profileInput{displayName, roleTitle, intro, quote, expertise, toolkit, accents, contactText, contactLabel, contactHref}, nil
}

func requiredMultiline(raw any, fallback, label string, limit int) (string, error) {
	value := fallback
	if raw != nil {
		value = fmt.Sprint(raw)
	}
	value = strings.TrimSpace(strings.Join(trimmedLines(value, false), "\n"))
	if value == "" {
		return "", response.BadRequest(label + "不能为空")
	}
	if utf8.RuneCountInString(value) > limit {
		return "", response.BadRequest(fmt.Sprintf("%s长度不能超过 %d", label, limit))
	}
	return value, nil
}

func optionalOneLine(raw any, label string, limit int) (string, error) {
	value := ""
	if raw != nil {
		value = fmt.Sprint(raw)
	}
	value = strings.Join(trimmedLines(value, true), " ")
	if utf8.RuneCountInString(value) > limit {
		return "", response.BadRequest(fmt.Sprintf("%s长度不能超过 %d", label, limit))
	}
	return value, nil
}

func trimmedLines(value string, omitEmpty bool) []string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if omitEmpty && line == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

func requiredList(raw any, fallback []string, label string) ([]string, error) {
	var source []any
	switch value := raw.(type) {
	case nil:
		for _, item := range fallback {
			source = append(source, item)
		}
	case string:
		for _, item := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
			source = append(source, item)
		}
	case []any:
		source = value
	case []string:
		for _, item := range value {
			source = append(source, item)
		}
	default:
		source = []any{value}
	}
	values := normalizeAnyStrings(source)
	if len(values) == 0 {
		return nil, response.BadRequest(label + " 不能为空")
	}
	if len(values) > 20 {
		return nil, response.BadRequest(label + " 数量不能超过 20")
	}
	for _, item := range values {
		if utf8.RuneCountInString(item) > 100 {
			return nil, response.BadRequest(label + " 单项长度不能超过 100")
		}
	}
	return values, nil
}

func normalizeAnyStrings(raw []any) []string {
	seen := map[string]struct{}{}
	values := make([]string, 0, len(raw))
	for _, item := range raw {
		value := ""
		if item != nil {
			value = strings.TrimSpace(fmt.Sprint(item))
		}
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func validateAccents(raw any) ([]Accent, error) {
	values := normalizeAccentValues(raw)
	if len(values) > 24 {
		return nil, response.BadRequest("正文注记数量不能超过 24")
	}
	for _, item := range values {
		if utf8.RuneCountInString(item.Phrase) > 100 {
			return nil, response.BadRequest("正文注记短语长度不能超过 100")
		}
		if utf8.RuneCountInString(item.Note) > 100 {
			return nil, response.BadRequest("正文注记气泡文案长度不能超过 100")
		}
	}
	return values, nil
}

func normalizeAccentValues(raw any) []Accent {
	items, ok := raw.([]any)
	if !ok {
		return []Accent{}
	}
	seen := map[string]struct{}{}
	values := make([]Accent, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		phrase := strings.TrimSpace(fmt.Sprint(record["phrase"]))
		if phrase == "" || phrase == "<nil>" {
			continue
		}
		if _, exists := seen[phrase]; exists {
			continue
		}
		style := strings.TrimSpace(fmt.Sprint(record["style"]))
		if _, valid := accentStyles[style]; !valid {
			style = "red"
		}
		note := strings.TrimSpace(fmt.Sprint(record["note"]))
		if note == "<nil>" {
			note = ""
		}
		seen[phrase] = struct{}{}
		values = append(values, Accent{Phrase: phrase, Style: style, Note: note})
	}
	return values
}

func parseListJSON(raw string, fallback []string) []string {
	if strings.TrimSpace(raw) == "" {
		return append([]string(nil), fallback...)
	}
	var values []any
	if json.Unmarshal([]byte(raw), &values) != nil {
		return append([]string(nil), fallback...)
	}
	normalized := normalizeAnyStrings(values)
	if len(normalized) == 0 {
		return append([]string(nil), fallback...)
	}
	return normalized
}

func parseAccentsJSON(raw string, fallback []Accent) []Accent {
	if strings.TrimSpace(raw) == "" {
		return append([]Accent(nil), fallback...)
	}
	var values []any
	if json.Unmarshal([]byte(raw), &values) != nil {
		return append([]Accent(nil), fallback...)
	}
	return normalizeAccentValues(values)
}

func fallbackText(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
