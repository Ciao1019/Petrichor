// appearance.go 移植 src/server/appearance/logic.ts + public-loader.ts 的公开侧：
// 站点外观单例（当前只有 publicQaEnabled 开关），缺表/无记录回退默认值。
package sitecontent

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/cache"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// SiteAppearanceID 站点外观单例行 ID。
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
	return map[string]any{
		"publicQaEnabled": record.PublicQaEnabled,
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

// LoadPublicSiteAppearanceResponse 公开站点外观响应（未缓存）。
func LoadPublicSiteAppearanceResponse(ctx context.Context) (map[string]any, error) {
	record, err := loadSiteAppearanceOrNull(ctx)
	if err != nil {
		return nil, err
	}
	return BuildSiteAppearanceResponse(record), nil
}

// LoadCachedPublicSiteAppearance 读穿透缓存的公开站点外观响应。
func LoadCachedPublicSiteAppearance(ctx context.Context) (map[string]any, error) {
	return cache.ReadThrough(siteAppearanceCacheKey, TTLSeconds, func() (map[string]any, error) {
		return LoadPublicSiteAppearanceResponse(ctx)
	})
}

// IsPublicQaEnabled 供问答端点判断前台问答是否开放；读取失败按关闭处理。
func IsPublicQaEnabled(ctx context.Context) bool {
	resp, err := LoadCachedPublicSiteAppearance(ctx)
	if err != nil {
		return false
	}
	enabled, ok := resp["publicQaEnabled"].(bool)
	return ok && enabled
}
