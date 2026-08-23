// appearance.go 移植 src/server/appearance 的 admin 侧：
// 站点外观单例（当前只有 publicQaEnabled 开关）。
package adminpanel

import (
	"context"
	"errors"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const SiteAppearanceID = 1

type siteAppearanceRecord struct {
	PublicQaEnabled bool
	CreatedAt       *time.Time
	UpdatedAt       *time.Time
}

// BuildSiteAppearanceResponse 记录缺失时回退默认（publicQaEnabled=true）。
func BuildSiteAppearanceResponse(record *siteAppearanceRecord) map[string]any {
	if record == nil {
		return map[string]any{"publicQaEnabled": true, "createdAt": nil, "updatedAt": nil}
	}
	formatTime := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return httpx.FormatISO(*t)
	}
	publicQaEnabled := record.PublicQaEnabled
	return map[string]any{
		"publicQaEnabled": publicQaEnabled,
		"createdAt":       formatTime(record.CreatedAt),
		"updatedAt":       formatTime(record.UpdatedAt),
	}
}

func loadSiteAppearanceOrNull(ctx context.Context) (*siteAppearanceRecord, error) {
	row := db.Pool().QueryRow(ctx,
		`SELECT public_qa_enabled, created_at, updated_at FROM petrichor_site_appearance WHERE id = $1 LIMIT 1`,
		SiteAppearanceID)
	var r siteAppearanceRecord
	err := row.Scan(&r.PublicQaEnabled, &r.CreatedAt, &r.UpdatedAt)
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

// AdminSiteAppearanceDetail GET /api/admin/appearance。
func AdminSiteAppearanceDetail(c *gin.Context) {
	record, err := loadSiteAppearanceOrNull(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, BuildSiteAppearanceResponse(record))
}

// AdminSiteAppearanceUpdate POST /api/admin/appearance。
func AdminSiteAppearanceUpdate(c *gin.Context) {
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	// 非布尔输入回退默认值（对齐 validateSiteAppearanceInput）
	publicQaEnabled := true
	if raw, ok := body["publicQaEnabled"].(bool); ok {
		publicQaEnabled = raw
	}

	now := time.Now()
	_, uerr := db.Pool().Exec(c.Request.Context(),
		`INSERT INTO petrichor_site_appearance (id, public_qa_enabled, created_at, updated_at)
		 VALUES ($1,$2,$3,$3)
		 ON CONFLICT (id) DO UPDATE SET public_qa_enabled=$2, updated_at=$3`,
		SiteAppearanceID, publicQaEnabled, now)
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}

	record, lerr := loadSiteAppearanceOrNull(c.Request.Context())
	if lerr != nil {
		httpx.HandleError(c, lerr)
		return
	}
	invalidatePublicCacheKeys("site-appearance")
	httpx.OK(c, BuildSiteAppearanceResponse(record))
}
