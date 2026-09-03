// filing.go 实现站点备案信息的公开侧读取。
package sitecontent

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const (
	SiteFilingID             = 1
	defaultICPURL            = "https://beian.miit.gov.cn/"
	defaultPublicSecurityURL = "https://www.beian.gov.cn/portal/registerSystemInfo"
)

type siteFilingRecord struct {
	Enabled              bool
	ICPNumber            string
	ICPURL               string
	PublicSecurityNumber string
	PublicSecurityURL    string
	CreatedAt            *time.Time
	UpdatedAt            *time.Time
}

// BuildSiteFilingResponse 记录缺失时默认不展示备案信息。
func BuildSiteFilingResponse(record *siteFilingRecord) map[string]any {
	if record == nil {
		return map[string]any{
			"enabled":              false,
			"icpNumber":            "",
			"icpUrl":               defaultICPURL,
			"publicSecurityNumber": "",
			"publicSecurityUrl":    defaultPublicSecurityURL,
			"createdAt":            nil,
			"updatedAt":            nil,
		}
	}

	formatTime := func(value *time.Time) any {
		if value == nil {
			return nil
		}
		return httpx.FormatISO(*value)
	}
	fallbackURL := func(value, fallback string) string {
		if strings.TrimSpace(value) == "" {
			return fallback
		}
		return value
	}

	return map[string]any{
		"enabled":              record.Enabled,
		"icpNumber":            record.ICPNumber,
		"icpUrl":               fallbackURL(record.ICPURL, defaultICPURL),
		"publicSecurityNumber": record.PublicSecurityNumber,
		"publicSecurityUrl":    fallbackURL(record.PublicSecurityURL, defaultPublicSecurityURL),
		"createdAt":            formatTime(record.CreatedAt),
		"updatedAt":            formatTime(record.UpdatedAt),
	}
}

func loadSiteFilingOrNull(ctx context.Context) (*siteFilingRecord, error) {
	row := db.Pool().QueryRow(ctx,
		`SELECT enabled, icp_number, icp_url, public_security_number, public_security_url,
		        created_at, updated_at
		 FROM petrichor_site_filing WHERE id = $1 LIMIT 1`, SiteFilingID)
	var record siteFilingRecord
	err := row.Scan(
		&record.Enabled,
		&record.ICPNumber,
		&record.ICPURL,
		&record.PublicSecurityNumber,
		&record.PublicSecurityURL,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil && isUndefinedTableErr(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// LoadPublicSiteFilingResponse 返回未缓存的公开备案配置。
func LoadPublicSiteFilingResponse(ctx context.Context) (map[string]any, error) {
	record, err := loadSiteFilingOrNull(ctx)
	if err != nil {
		return nil, err
	}
	return BuildSiteFilingResponse(record), nil
}
