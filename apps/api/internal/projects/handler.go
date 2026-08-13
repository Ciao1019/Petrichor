package projects

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/siteprojectshowcase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const singletonID = 1

type Handler struct {
	client *ent.Client
}

func NewHandler(client *ent.Client) *Handler {
	return &Handler{client: client}
}

type DTO struct {
	Heading   string        `json:"heading"`
	Intro     string        `json:"intro"`
	Items     []ProjectItem `json:"items"`
	CreatedAt *string       `json:"createdAt"`
	UpdatedAt *string       `json:"updatedAt"`
}

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

var stampColors = map[string]struct{}{"red": {}, "orange": {}, "green": {}, "teal": {}, "blue": {}, "purple": {}, "pink": {}}

func toDTO(row *ent.SiteProjectShowcase) DTO {
	items := decodeProjectItems(row.ItemsJSON)
	return DTO{
		Heading:   row.Heading,
		Intro:     row.Intro,
		Items:     items,
		CreatedAt: projectTimeString(row.CreatedAt),
		UpdatedAt: projectTimeString(row.UpdatedAt),
	}
}

func projectTimeString(value time.Time) *string {
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func decodeProjectItems(raw string) []ProjectItem {
	var items []ProjectItem
	if json.Unmarshal([]byte(raw), &items) != nil {
		return []ProjectItem{}
	}
	return normalizeProjectItems(items)
}

func normalizeProjectItems(raw []ProjectItem) []ProjectItem {
	items := make([]ProjectItem, 0, len(raw))
	for _, item := range raw {
		item.Name = strings.TrimSpace(item.Name)
		if item.Name == "" {
			continue
		}
		item.Year = strings.TrimSpace(item.Year)
		item.Stamp = strings.TrimSpace(item.Stamp)
		item.StampColor = strings.TrimSpace(item.StampColor)
		if _, ok := stampColors[item.StampColor]; !ok {
			item.StampColor = "red"
		}
		item.Blurb = strings.TrimSpace(item.Blurb)
		item.RepoURL = strings.TrimSpace(item.RepoURL)
		item.SiteURL = strings.TrimSpace(item.SiteURL)
		item.Stack = normalizeProjectStack(item.Stack)
		items = append(items, item)
	}
	return items
}

func normalizeProjectStack(raw []string) []string {
	seen := make(map[string]struct{}, len(raw))
	values := make([]string, 0, len(raw))
	for _, value := range raw {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func (h *Handler) ensure(ctx context.Context) (*ent.SiteProjectShowcase, error) {
	row, err := h.client.SiteProjectShowcase.Query().Where(siteprojectshowcase.IDEQ(singletonID)).Only(ctx)
	if err == nil {
		return row, nil
	}
	if !ent.IsNotFound(err) {
		return nil, err
	}
	return h.client.SiteProjectShowcase.Create().SetID(singletonID).Save(ctx)
}

func (h *Handler) PublicGet(c *gin.Context) {
	row, err := h.load(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildProjectResponse(row))
}

func (h *Handler) AdminGet(c *gin.Context) {
	if !requireSuperAdmin(c) {
		return
	}
	h.PublicGet(c)
}

type saveRequest struct {
	Heading *string       `json:"heading"`
	Intro   *string       `json:"intro"`
	Items   []ProjectItem `json:"items"`
}

func (h *Handler) AdminSave(c *gin.Context) {
	if !requireSuperAdmin(c) {
		return
	}
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	input, err := validateProjectInput(raw)
	if err != nil {
		response.Fail(c, err)
		return
	}
	row, err := h.save(c.Request.Context(), input)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildProjectResponse(row))
}

func requireSuperAdmin(c *gin.Context) bool {
	if !auth.IsSuperAdmin(auth.MustUser(c)) {
		response.Fail(c, response.Forbidden("仅超级管理员可执行该操作"))
		return false
	}
	return true
}

func (h *Handler) load(ctx context.Context) (*ent.SiteProjectShowcase, error) {
	row, err := h.client.SiteProjectShowcase.Query().Where(siteprojectshowcase.IDEQ(singletonID)).Only(ctx)
	if err == nil {
		return row, nil
	}
	if ent.IsNotFound(err) || isMissingTableError(err) {
		return nil, nil
	}
	return nil, err
}

func (h *Handler) save(ctx context.Context, input projectInput) (*ent.SiteProjectShowcase, error) {
	itemsJSON, _ := json.Marshal(input.Items)
	row, err := h.load(ctx)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return h.client.SiteProjectShowcase.Create().SetID(singletonID).SetHeading(input.Heading).SetIntro(input.Intro).SetItemsJSON(string(itemsJSON)).Save(ctx)
	}
	return h.client.SiteProjectShowcase.UpdateOneID(singletonID).SetHeading(input.Heading).SetIntro(input.Intro).SetItemsJSON(string(itemsJSON)).Save(ctx)
}

func isMissingTableError(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "petrichor_site_project_showcase") && (strings.Contains(text, "42p01") || strings.Contains(text, "does not exist") || strings.Contains(text, "relation"))
}
