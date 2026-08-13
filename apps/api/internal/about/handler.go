package about

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/siteaboutprofile"
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

type ProfileDTO struct {
	DisplayName  string   `json:"displayName"`
	RoleTitle    string   `json:"roleTitle"`
	Intro        string   `json:"intro"`
	Expertise    []string `json:"expertise"`
	Toolkit      []string `json:"toolkit"`
	Quote        string   `json:"quote"`
	Accents      []Accent `json:"accents"`
	ContactText  string   `json:"contactText"`
	ContactLabel string   `json:"contactLabel"`
	ContactHref  string   `json:"contactHref"`
	CreatedAt    *string  `json:"createdAt"`
	UpdatedAt    *string  `json:"updatedAt"`
}

type Accent struct {
	Phrase string `json:"phrase"`
	Style  string `json:"style"`
	Note   string `json:"note,omitempty"`
}

var accentStyles = map[string]struct{}{
	"red": {}, "orange": {}, "green": {}, "teal": {}, "blue": {}, "purple": {}, "pink": {}, "yellow": {},
}

func toDTO(row *ent.SiteAboutProfile) ProfileDTO {
	expertise := decodeStringList(row.ExpertiseJSON)
	toolkit := decodeStringList(row.ToolkitJSON)
	accents := decodeAccents(row.AccentsJSON)
	return ProfileDTO{
		DisplayName:  row.DisplayName,
		RoleTitle:    row.RoleTitle,
		Intro:        row.Intro,
		Expertise:    expertise,
		Toolkit:      toolkit,
		Quote:        row.Quote,
		Accents:      accents,
		ContactText:  row.ContactText,
		ContactLabel: row.ContactLabel,
		ContactHref:  row.ContactHref,
		CreatedAt:    timeString(row.CreatedAt),
		UpdatedAt:    timeString(row.UpdatedAt),
	}
}

func timeString(value time.Time) *string {
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func decodeStringList(raw string) []string {
	var values []string
	if json.Unmarshal([]byte(raw), &values) != nil {
		return []string{}
	}
	return normalizeStringList(values)
}

func normalizeStringList(raw []string) []string {
	seen := make(map[string]struct{}, len(raw))
	values := make([]string, 0, len(raw))
	for _, item := range raw {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		values = append(values, item)
	}
	return values
}

func decodeAccents(raw string) []Accent {
	var values []Accent
	if json.Unmarshal([]byte(raw), &values) != nil {
		return []Accent{}
	}
	return normalizeAccents(values)
}

func normalizeAccents(raw []Accent) []Accent {
	seen := make(map[string]struct{}, len(raw))
	values := make([]Accent, 0, len(raw))
	for _, item := range raw {
		item.Phrase = strings.TrimSpace(item.Phrase)
		item.Style = strings.TrimSpace(item.Style)
		item.Note = strings.TrimSpace(item.Note)
		if item.Phrase == "" {
			continue
		}
		if _, ok := seen[item.Phrase]; ok {
			continue
		}
		if _, ok := accentStyles[item.Style]; !ok {
			item.Style = "red"
		}
		seen[item.Phrase] = struct{}{}
		values = append(values, item)
	}
	return values
}

func (h *Handler) ensure(ctx context.Context) (*ent.SiteAboutProfile, error) {
	row, err := h.client.SiteAboutProfile.Query().Where(siteaboutprofile.IDEQ(singletonID)).Only(ctx)
	if err == nil {
		return row, nil
	}
	if !ent.IsNotFound(err) {
		return nil, err
	}
	return h.client.SiteAboutProfile.Create().SetID(singletonID).Save(ctx)
}

func (h *Handler) PublicGet(c *gin.Context) {
	row, err := h.load(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildProfileResponse(row))
}

func (h *Handler) AdminGet(c *gin.Context) {
	if !requireSuperAdmin(c) {
		return
	}
	h.PublicGet(c)
}

type saveRequest struct {
	DisplayName  *string  `json:"displayName"`
	RoleTitle    *string  `json:"roleTitle"`
	Intro        *string  `json:"intro"`
	Expertise    []string `json:"expertise"`
	Toolkit      []string `json:"toolkit"`
	Quote        *string  `json:"quote"`
	Accents      []Accent `json:"accents"`
	ContactText  *string  `json:"contactText"`
	ContactLabel *string  `json:"contactLabel"`
	ContactHref  *string  `json:"contactHref"`
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
	input, err := validateProfileInput(raw)
	if err != nil {
		response.Fail(c, err)
		return
	}
	row, err := h.save(c.Request.Context(), input)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildProfileResponse(row))
}

func requireSuperAdmin(c *gin.Context) bool {
	user := auth.MustUser(c)
	if !auth.IsSuperAdmin(user) {
		response.Fail(c, response.Forbidden("仅超级管理员可执行该操作"))
		return false
	}
	return true
}

func (h *Handler) load(ctx context.Context) (*ent.SiteAboutProfile, error) {
	row, err := h.client.SiteAboutProfile.Query().Where(siteaboutprofile.IDEQ(singletonID)).Only(ctx)
	if err == nil {
		return row, nil
	}
	if ent.IsNotFound(err) || isMissingTableError(err, "petrichor_site_about_profile") {
		return nil, nil
	}
	return nil, err
}

func (h *Handler) save(ctx context.Context, input profileInput) (*ent.SiteAboutProfile, error) {
	expertiseJSON, _ := json.Marshal(input.Expertise)
	toolkitJSON, _ := json.Marshal(input.Toolkit)
	accentsJSON, _ := json.Marshal(input.Accents)
	row, err := h.load(ctx)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return h.client.SiteAboutProfile.Create().
			SetID(singletonID).
			SetDisplayName(input.DisplayName).
			SetRoleTitle(input.RoleTitle).
			SetIntro(input.Intro).
			SetExpertiseJSON(string(expertiseJSON)).
			SetToolkitJSON(string(toolkitJSON)).
			SetQuote(input.Quote).
			SetAccentsJSON(string(accentsJSON)).
			SetContactText(input.ContactText).
			SetContactLabel(input.ContactLabel).
			SetContactHref(input.ContactHref).
			Save(ctx)
	}
	return h.client.SiteAboutProfile.UpdateOneID(singletonID).
		SetDisplayName(input.DisplayName).
		SetRoleTitle(input.RoleTitle).
		SetIntro(input.Intro).
		SetExpertiseJSON(string(expertiseJSON)).
		SetToolkitJSON(string(toolkitJSON)).
		SetQuote(input.Quote).
		SetAccentsJSON(string(accentsJSON)).
		SetContactText(input.ContactText).
		SetContactLabel(input.ContactLabel).
		SetContactHref(input.ContactHref).
		Save(ctx)
}

func isMissingTableError(err error, table string) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, table) && (strings.Contains(text, "42p01") || strings.Contains(text, "does not exist") || strings.Contains(text, "relation"))
}
