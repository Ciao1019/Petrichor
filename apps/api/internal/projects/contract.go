package projects

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

var defaultProjectResponse = DTO{
	Heading: "开源项目",
	Intro:   "",
	Items: []ProjectItem{
		{Name: "Ech0 — self-hosted microblog", Year: "2025", Stack: []string{"Go", "Vue"}, Stamp: "popular", StampColor: "red", Blurb: "An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.", RepoURL: "https://github.com/lin-snow/Ech0", SiteURL: "https://ech0.app"},
		{Name: "Dox — todos in terminal", Year: "2026", Stack: []string{"Go", "TypeScript"}, Stamp: "new", StampColor: "blue", Blurb: "More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.", RepoURL: "https://github.com/lin-snow/dox"},
		{Name: "Kemate — a Vercel-like PaaS", Year: "2026", Stack: []string{"Go"}, Stamp: "WIP", StampColor: "green", Blurb: "A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture."},
	},
}

type projectInput struct {
	Heading string
	Intro   string
	Items   []ProjectItem
}

func buildProjectResponse(row *ent.SiteProjectShowcase) DTO {
	if row == nil {
		result := defaultProjectResponse
		result.Items = cloneProjectItems(defaultProjectResponse.Items)
		return result
	}
	result := toDTO(row)
	if strings.TrimSpace(result.Heading) == "" {
		result.Heading = defaultProjectResponse.Heading
	}
	result.Items = parseProjectItems(row.ItemsJSON, defaultProjectResponse.Items)
	return result
}

func validateProjectInput(raw map[string]any) (projectInput, error) {
	heading := projectOneLine(raw["heading"])
	if heading == "" {
		heading = defaultProjectResponse.Heading
	}
	if utf8.RuneCountInString(heading) > 100 {
		return projectInput{}, response.BadRequest("标题长度不能超过 100")
	}
	intro := projectOneLine(raw["intro"])
	if utf8.RuneCountInString(intro) > 300 {
		return projectInput{}, response.BadRequest("副标题长度不能超过 300")
	}
	items := normalizeProjectValues(raw["items"])
	if len(items) > 40 {
		return projectInput{}, response.BadRequest("项目数量不能超过 40")
	}
	for _, item := range items {
		if utf8.RuneCountInString(item.Name) > 160 {
			return projectInput{}, response.BadRequest("项目名称长度不能超过 160")
		}
		if utf8.RuneCountInString(item.Year) > 20 {
			return projectInput{}, response.BadRequest("项目年份长度不能超过 20")
		}
		if utf8.RuneCountInString(item.Stamp) > 24 {
			return projectInput{}, response.BadRequest("项目标签词长度不能超过 24")
		}
		if utf8.RuneCountInString(item.Blurb) > 800 {
			return projectInput{}, response.BadRequest("项目描述长度不能超过 800")
		}
		if utf8.RuneCountInString(item.RepoURL) > 400 || utf8.RuneCountInString(item.SiteURL) > 400 {
			return projectInput{}, response.BadRequest("项目链接长度不能超过 400")
		}
		if len(item.Stack) > 12 {
			return projectInput{}, response.BadRequest("技术栈数量不能超过 12")
		}
		for _, tech := range item.Stack {
			if utf8.RuneCountInString(tech) > 40 {
				return projectInput{}, response.BadRequest("技术栈单项长度不能超过 40")
			}
		}
	}
	return projectInput{Heading: heading, Intro: intro, Items: items}, nil
}

func normalizeProjectValues(raw any) []ProjectItem {
	entries, ok := raw.([]any)
	if !ok {
		return []ProjectItem{}
	}
	values := make([]ProjectItem, 0, len(entries))
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name := projectOneLine(record["name"])
		if name == "" {
			continue
		}
		color := strings.TrimSpace(jsString(record["stampColor"]))
		if _, valid := stampColors[color]; !valid {
			color = "red"
		}
		values = append(values, ProjectItem{
			Name: name, Year: projectOneLine(record["year"]), Stack: normalizeStackValue(record["stack"]),
			Stamp: projectOneLine(record["stamp"]), StampColor: color, Blurb: projectMultiLine(record["blurb"]),
			RepoURL: projectOneLine(record["repoUrl"]), SiteURL: projectOneLine(record["siteUrl"]),
		})
	}
	return values
}

func normalizeStackValue(raw any) []string {
	var source []any
	switch value := raw.(type) {
	case []any:
		source = value
	case string:
		for _, item := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == '，' || r == '\n' || r == '\r' }) {
			source = append(source, item)
		}
	}
	seen := map[string]struct{}{}
	values := make([]string, 0, len(source))
	for _, entry := range source {
		value := strings.TrimSpace(jsString(entry))
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

func parseProjectItems(raw string, fallback []ProjectItem) []ProjectItem {
	if strings.TrimSpace(raw) == "" {
		return cloneProjectItems(fallback)
	}
	var entries []any
	if json.Unmarshal([]byte(raw), &entries) != nil {
		return cloneProjectItems(fallback)
	}
	return normalizeProjectValues(entries)
}

func cloneProjectItems(items []ProjectItem) []ProjectItem {
	result := make([]ProjectItem, len(items))
	for i, item := range items {
		result[i] = item
		result[i].Stack = append([]string(nil), item.Stack...)
	}
	return result
}

func projectOneLine(raw any) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(jsString(raw), "\r\n", "\n"), "\r", "\n"), "\n")
	values := make([]string, 0, len(lines))
	for _, line := range lines {
		if line = strings.TrimSpace(line); line != "" {
			values = append(values, line)
		}
	}
	return strings.Join(values, " ")
}

func projectMultiLine(raw any) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(jsString(raw), "\r\n", "\n"), "\r", "\n"), "\n")
	for i := range lines {
		lines[i] = strings.TrimSpace(lines[i])
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func jsString(raw any) string {
	if raw == nil {
		return ""
	}
	return fmt.Sprint(raw)
}
