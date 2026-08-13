package appearance

import (
	"context"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/siteappearance"
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
	PublicQaEnabled bool    `json:"publicQaEnabled"`
	CreatedAt       *string `json:"createdAt"`
	UpdatedAt       *string `json:"updatedAt"`
}

func toDTO(row *ent.SiteAppearance) DTO {
	return DTO{
		PublicQaEnabled: row.PublicQaEnabled,
		CreatedAt:       formatTime(row.CreatedAt),
		UpdatedAt:       formatTime(row.UpdatedAt),
	}
}

func buildResponse(row *ent.SiteAppearance) DTO {
	if row == nil {
		return DTO{PublicQaEnabled: true}
	}
	return toDTO(row)
}

func resolvePublicQAEnabled(raw map[string]any) bool {
	if value, ok := raw["publicQaEnabled"].(bool); ok {
		return value
	}
	return true
}

func formatTime(value time.Time) *string {
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func (h *Handler) ensure(ctx context.Context) (*ent.SiteAppearance, error) {
	row, err := h.client.SiteAppearance.Query().Where(siteappearance.IDEQ(singletonID)).Only(ctx)
	if err == nil {
		return row, nil
	}
	if !ent.IsNotFound(err) {
		return nil, err
	}
	return h.client.SiteAppearance.Create().SetID(singletonID).Save(ctx)
}

func (h *Handler) PublicGet(c *gin.Context) {
	row, err := h.load(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, buildResponse(row))
}

func (h *Handler) AdminGet(c *gin.Context) {
	if !h.requireSuperAdmin(c) {
		return
	}
	h.PublicGet(c)
}

type saveRequest struct {
	PublicQaEnabled *bool `json:"publicQaEnabled"`
}

func (h *Handler) AdminSave(c *gin.Context) {
	if !h.requireSuperAdmin(c) {
		return
	}
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	enabled := resolvePublicQAEnabled(raw)
	row, err := h.load(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if row == nil {
		row, err = h.client.SiteAppearance.Create().SetID(singletonID).SetPublicQaEnabled(enabled).Save(c.Request.Context())
	} else {
		row, err = h.client.SiteAppearance.UpdateOneID(singletonID).SetPublicQaEnabled(enabled).Save(c.Request.Context())
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toDTO(row))
}

func (h *Handler) requireSuperAdmin(c *gin.Context) bool {
	if !auth.IsSuperAdmin(auth.MustUser(c)) {
		response.Fail(c, response.Forbidden("仅超级管理员可执行该操作"))
		return false
	}
	return true
}

func (h *Handler) load(ctx context.Context) (*ent.SiteAppearance, error) {
	row, err := h.client.SiteAppearance.Query().Where(siteappearance.IDEQ(singletonID)).Only(ctx)
	if err == nil {
		return row, nil
	}
	if ent.IsNotFound(err) || isMissingTableError(err) {
		return nil, nil
	}
	return nil, err
}

func isMissingTableError(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "petrichor_site_appearance") && (strings.Contains(text, "42p01") || strings.Contains(text, "does not exist") || strings.Contains(text, "relation"))
}
