// projects.go 实现开源项目展示的公开侧读取：
// 开源项目展示单例读取，缺表/无记录回退默认清单。
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

// ProjectShowcaseID 开源项目展示单例行 ID。
const ProjectShowcaseID = 1

var stampColors = []string{"red", "orange", "green", "teal", "blue", "purple", "pink"}

// ProjectItem 项目条目（JSON 字段顺序与 TS 对象一致）。
type ProjectItem struct {
	Name       string   `json:"name"`
	Year       string   `json:"year"`
	Stack      []string `json:"stack"`
	Stamp      string   `json:"stamp"`
	StampColor string   `json:"stampColor"`
	Blurb      string   `json:"blurb"`
	RepoURL    string   `json:"repoUrl"`
	SiteURL    string   `json:"siteUrl"`
}

const (
	defaultProjectHeading = "开源项目"
	defaultProjectIntro   = "我正在构建与参与的开源项目。点开每一项，可以查看项目简介、技术栈与源码。"
)

var defaultProjectItems = []ProjectItem{
	{
		Name:       "Petrichor",
		Year:       "2026",
		Stack:      []string{"TypeScript", "React", "Go", "PostgreSQL"},
		Stamp:      "SELF-HOSTED",
		StampColor: "red",
		Blurb:      "面向人与 AI Agent 的自托管知识平台：从编辑、公开发布和语义 Wiki，到基于证据的 RAG 问答、MCP / REST 接入与可移植 Agent Skill。",
		RepoURL:    "https://github.com/Ciao1019/Petrichor",
		SiteURL:    "",
	},
	{
		Name:       "AgentX",
		Year:       "2025",
		Stack:      []string{"Java", "TypeScript", "MCP", "Docker"},
		Stamp:      "AGENT",
		StampColor: "blue",
		Blurb:      "通过自然语言与工具集成构建个性化智能 Agent，涵盖 MCP 网关、模型高可用、RAG、长期记忆、定时任务、监控与 OpenAPI。",
		RepoURL:    "https://github.com/lucky-aeon/AgentX",
		SiteURL:    "",
	},
	{
		Name:       "stream-query",
		Year:       "2022",
		Stack:      []string{"Java", "MyBatis-Plus", "Stream", "Lambda"},
		Stamp:      "DROMARA",
		StampColor: "green",
		Blurb:      "以 Stream 与 Lambda 封装数据查询和结果处理，提供无需手写 Mapper 的 MyBatis-Plus 体验，并支持 Database、OneToOne 与 OneToMany 等流式 API。",
		RepoURL:    "https://github.com/dromara/stream-query",
		SiteURL:    "",
	},
}

type projectRecord struct {
	Heading   string
	Intro     *string
	ItemsJSON *string
	CreatedAt *time.Time
	UpdatedAt *time.Time
}

func isStampColor(v string) bool {
	for _, item := range stampColors {
		if item == v {
			return true
		}
	}
	return false
}

func cloneProjectItems(values []ProjectItem) []ProjectItem {
	out := make([]ProjectItem, len(values))
	for i, item := range values {
		item.Stack = append([]string{}, item.Stack...)
		out[i] = item
	}
	return out
}

// normalizeItems 归一化项目数组：丢弃非对象/无名称项；stampColor 非法回退 red。
func normalizeItems(raw []any) []ProjectItem {
	values := []ProjectItem{}
	for _, entry := range raw {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name := oneLine(record["name"])
		if name == "" {
			continue
		}
		colorRaw := strings.TrimSpace(anyToString(record["stampColor"]))
		color := colorRaw
		if !isStampColor(colorRaw) {
			color = "red"
		}
		values = append(values, ProjectItem{
			Name:       name,
			Year:       oneLine(record["year"]),
			Stack:      normalizeStack(record["stack"]),
			Stamp:      oneLine(record["stamp"]),
			StampColor: color,
			Blurb:      multiLine(record["blurb"]),
			RepoURL:    oneLine(record["repoUrl"]),
			SiteURL:    oneLine(record["siteUrl"]),
		})
	}
	return values
}

// normalizeStack 技术栈归一化：数组或逗号分隔字符串，去空去重。
func normalizeStack(raw any) []string {
	var source []any
	switch v := raw.(type) {
	case []any:
		source = v
	case string:
		parts := strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == '，' || r == '\n' })
		source = make([]any, 0, len(parts))
		for _, part := range parts {
			source = append(source, part)
		}
	default:
		return []string{}
	}
	seen := map[string]struct{}{}
	values := []string{}
	for _, item := range source {
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

// parseItemsJSON 缺失/损坏回退默认；合法但为空数组（用户主动清空）则尊重为空。
func parseItemsJSON(raw *string) []ProjectItem {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return cloneProjectItems(defaultProjectItems)
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return cloneProjectItems(defaultProjectItems)
	}
	arr, ok := parsed.([]any)
	if !ok {
		return cloneProjectItems(defaultProjectItems)
	}
	return normalizeItems(arr)
}

// BuildProjectShowcaseResponse 记录缺失时整体回退默认。
func BuildProjectShowcaseResponse(record *projectRecord) map[string]any {
	if record == nil {
		return map[string]any{
			"heading":   defaultProjectHeading,
			"intro":     defaultProjectIntro,
			"items":     cloneProjectItems(defaultProjectItems),
			"createdAt": nil,
			"updatedAt": nil,
		}
	}
	safeText := func(value string, fallback string) string {
		if strings.TrimSpace(value) == "" {
			return fallback
		}
		return value
	}
	formatTime := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return httpx.FormatISO(*t)
	}
	intro := ""
	if record.Intro != nil {
		intro = *record.Intro
	}
	return map[string]any{
		"heading": safeText(record.Heading, defaultProjectHeading),
		// intro 允许为空（用户可清空隐藏），故不走默认回退。
		"intro":     intro,
		"items":     parseItemsJSON(record.ItemsJSON),
		"createdAt": formatTime(record.CreatedAt),
		"updatedAt": formatTime(record.UpdatedAt),
	}
}

func loadProjectShowcaseOrNull(ctx context.Context) (*projectRecord, error) {
	row := db.Pool().QueryRow(ctx,
		`SELECT heading, intro, items_json, created_at, updated_at
		 FROM petrichor_site_project_showcase WHERE id = $1 LIMIT 1`, ProjectShowcaseID)
	var r projectRecord
	err := row.Scan(&r.Heading, &r.Intro, &r.ItemsJSON, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil && isUndefinedTableErr(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// LoadPublicProjectShowcaseResponse 公开项目展示响应（未缓存）。
func LoadPublicProjectShowcaseResponse(ctx context.Context) (map[string]any, error) {
	record, err := loadProjectShowcaseOrNull(ctx)
	if err != nil {
		return nil, err
	}
	return BuildProjectShowcaseResponse(record), nil
}

// LoadCachedPublicProjectShowcase 读穿透缓存的公开项目展示响应。
func LoadCachedPublicProjectShowcase(ctx context.Context) (map[string]any, error) {
	return cache.ReadThrough(projectShowcaseCacheKey, TTLSeconds, func() (map[string]any, error) {
		return LoadPublicProjectShowcaseResponse(ctx)
	})
}
