// projects.go 移植 src/server/projects/logic.ts + handlers.ts（admin 侧）：
// 开源项目展示页单例的手写桌面风项目清单。
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

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

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

const defaultProjectHeading = "开源项目"

var defaultProjectItems = []ProjectItem{
	{
		Name:       "Ech0 — self-hosted microblog",
		Year:       "2025",
		Stack:      []string{"Go", "Vue"},
		Stamp:      "popular",
		StampColor: "red",
		Blurb:      "An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.",
		RepoURL:    "https://github.com/lin-snow/Ech0",
		SiteURL:    "https://ech0.app",
	},
	{
		Name:       "Dox — todos in terminal",
		Year:       "2026",
		Stack:      []string{"Go", "TypeScript"},
		Stamp:      "new",
		StampColor: "blue",
		Blurb:      "More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.",
		RepoURL:    "https://github.com/lin-snow/dox",
		SiteURL:    "",
	},
	{
		Name:       "Kemate — a Vercel-like PaaS",
		Year:       "2026",
		Stack:      []string{"Go"},
		Stamp:      "WIP",
		StampColor: "green",
		Blurb:      "A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture.",
		RepoURL:    "",
		SiteURL:    "",
	},
}

const (
	projectLimitHeading   = 100
	projectLimitIntro     = 300
	projectLimitCount     = 40
	projectLimitName      = 160
	projectLimitYear      = 20
	projectLimitStamp     = 24
	projectLimitBlurb     = 800
	projectLimitURL       = 400
	projectLimitStackCnt  = 12
	projectLimitStackItem = 40
)

func isStampColor(v string) bool { return inList(stampColors, v) }

func cloneProjectItems(values []ProjectItem) []ProjectItem {
	out := make([]ProjectItem, len(values))
	for i, item := range values {
		item.Stack = append([]string{}, item.Stack...)
		out[i] = item
	}
	return out
}

// normalizeStack 技术栈归一化：数组或逗号分隔字符串，去空去重。
func normalizeStack(raw any) []string {
	var source []any
	switch v := raw.(type) {
	case []any:
		source = v
	case string:
		parts := splitAny(v, []rune{',', '，', '\n'})
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
	return values
}

func splitAny(value string, seps []rune) []string {
	splitter := func(r rune) bool {
		for _, sep := range seps {
			if r == sep {
				return true
			}
		}
		return false
	}
	return strings.FieldsFunc(value, splitter)
}

// normalizeProjects 归一化项目数组：丢弃非对象/无名称项；stampColor 非法回退 red。
func normalizeProjects(raw []any) []ProjectItem {
	values := []ProjectItem{}
	for _, entry := range raw {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name := normalizeOneLineValue(toStringValue(record["name"]))
		if name == "" {
			continue
		}
		colorRaw := strings.TrimSpace(toStringValue(record["stampColor"]))
		stampColor := colorRaw
		if !isStampColor(colorRaw) {
			stampColor = "red"
		}
		values = append(values, ProjectItem{
			Name:       name,
			Year:       normalizeOneLineValue(toStringValue(record["year"])),
			Stack:      normalizeStack(record["stack"]),
			Stamp:      normalizeOneLineValue(toStringValue(record["stamp"])),
			StampColor: stampColor,
			Blurb:      normalizeMultilineLoose(toStringValue(record["blurb"])),
			RepoURL:    normalizeOneLineValue(toStringValue(record["repoUrl"])),
			SiteURL:    normalizeOneLineValue(toStringValue(record["siteUrl"])),
		})
	}
	return values
}

// normalizeMultilineLoose 多行文本：保留段落换行，仅裁剪每行首尾空白。
func normalizeMultilineLoose(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	lines := strings.Split(value, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

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
	return normalizeProjects(arr)
}

type projectRecord struct {
	Heading   string
	Intro     *string
	ItemsJSON *string
	CreatedAt *time.Time
	UpdatedAt *time.Time
}

// BuildProjectShowcaseResponse 记录缺失时回退默认清单；intro 允许为空。
func BuildProjectShowcaseResponse(record *projectRecord) map[string]any {
	formatTime := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return httpx.FormatISO(*t)
	}
	if record == nil {
		return map[string]any{
			"heading":   defaultProjectHeading,
			"intro":     "",
			"items":     cloneProjectItems(defaultProjectItems),
			"createdAt": nil,
			"updatedAt": nil,
		}
	}
	heading := strings.TrimSpace(record.Heading)
	if heading == "" {
		heading = defaultProjectHeading
	}
	intro := ""
	if record.Intro != nil {
		intro = *record.Intro
	}
	return map[string]any{
		"heading":   heading,
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

// validateProjectInput 复刻 validateProjectShowcaseInput 的全部规则与报错信息。
func validateProjectInput(input map[string]any) (heading, intro string, items []ProjectItem, err error) {
	heading = normalizeOneLineValue(toStringValue(input["heading"]))
	if heading == "" {
		heading = defaultProjectHeading
	}
	if runeLen(heading) > projectLimitHeading {
		return "", "", nil, httpx.BadRequest("标题长度不能超过 " + strconv.Itoa(projectLimitHeading))
	}
	intro = normalizeOneLineValue(toStringValue(input["intro"]))
	if runeLen(intro) > projectLimitIntro {
		return "", "", nil, httpx.BadRequest("副标题长度不能超过 " + strconv.Itoa(projectLimitIntro))
	}
	itemsRaw, _ := input["items"].([]any)
	items = normalizeProjects(itemsRaw)
	if len(items) > projectLimitCount {
		return "", "", nil, httpx.BadRequest("项目数量不能超过 " + strconv.Itoa(projectLimitCount))
	}
	for _, item := range items {
		if item.Name == "" {
			return "", "", nil, httpx.BadRequest("项目名称不能为空")
		}
		if runeLen(item.Name) > projectLimitName {
			return "", "", nil, httpx.BadRequest("项目名称长度不能超过 " + strconv.Itoa(projectLimitName))
		}
		if runeLen(item.Year) > projectLimitYear {
			return "", "", nil, httpx.BadRequest("项目年份长度不能超过 " + strconv.Itoa(projectLimitYear))
		}
		if runeLen(item.Stamp) > projectLimitStamp {
			return "", "", nil, httpx.BadRequest("项目标签词长度不能超过 " + strconv.Itoa(projectLimitStamp))
		}
		if runeLen(item.Blurb) > projectLimitBlurb {
			return "", "", nil, httpx.BadRequest("项目描述长度不能超过 " + strconv.Itoa(projectLimitBlurb))
		}
		if runeLen(item.RepoURL) > projectLimitURL || runeLen(item.SiteURL) > projectLimitURL {
			return "", "", nil, httpx.BadRequest("项目链接长度不能超过 " + strconv.Itoa(projectLimitURL))
		}
		if len(item.Stack) > projectLimitStackCnt {
			return "", "", nil, httpx.BadRequest("技术栈数量不能超过 " + strconv.Itoa(projectLimitStackCnt))
		}
		for _, tech := range item.Stack {
			if runeLen(tech) > projectLimitStackItem {
				return "", "", nil, httpx.BadRequest("技术栈单项长度不能超过 " + strconv.Itoa(projectLimitStackItem))
			}
		}
	}
	return heading, intro, items, nil
}

// AdminProjectShowcaseDetail GET /api/admin/projects。
func AdminProjectShowcaseDetail(c *gin.Context) {
	record, err := loadProjectShowcaseOrNull(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, BuildProjectShowcaseResponse(record))
}

// AdminProjectShowcaseUpdate POST /api/admin/projects。
func AdminProjectShowcaseUpdate(c *gin.Context) {
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	heading, intro, items, verr := validateProjectInput(body)
	if verr != nil {
		httpx.HandleError(c, verr)
		return
	}
	itemsJSON, jerr := marshalJSONCompact(items)
	if jerr != nil {
		httpx.HandleError(c, jerr)
		return
	}

	now := time.Now()
	_, uerr := db.Pool().Exec(c.Request.Context(),
		`INSERT INTO petrichor_site_project_showcase (id, heading, intro, items_json, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$5)
		 ON CONFLICT (id) DO UPDATE SET heading=$2, intro=$3, items_json=$4, updated_at=$5`,
		ProjectShowcaseID, heading, intro, itemsJSON, now)
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}

	record, lerr := loadProjectShowcaseOrNull(c.Request.Context())
	if lerr != nil {
		httpx.HandleError(c, lerr)
		return
	}
	invalidatePublicCacheKeys("project-showcase")
	httpx.OK(c, BuildProjectShowcaseResponse(record))
}
