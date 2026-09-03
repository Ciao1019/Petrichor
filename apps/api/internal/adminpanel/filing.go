// filing.go 实现站点备案信息的管理侧配置。
package adminpanel

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const (
	SiteFilingID             = 1
	defaultICPURL            = "https://beian.miit.gov.cn/"
	defaultPublicSecurityURL = "https://www.beian.gov.cn/portal/registerSystemInfo"
	filingNumberMaxLength    = 120
	filingURLMaxLength       = 500
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

// BuildSiteFilingResponse 记录缺失时返回关闭状态与官方查询入口。
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

func validateFilingURL(raw any, fallback, label string) (string, error) {
	value := normalizeOneLineValue(toStringValue(raw))
	if value == "" {
		return fallback, nil
	}
	if runeLen(value) > filingURLMaxLength {
		return "", httpx.BadRequest(label + "长度不能超过 500")
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", httpx.BadRequest(label + "必须是有效的 HTTP(S) 地址")
	}
	return value, nil
}

func validateSiteFilingInput(input map[string]any) (siteFilingRecord, error) {
	record := siteFilingRecord{
		Enabled:              toBoolValue(input["enabled"]),
		ICPNumber:            normalizeOneLineValue(toStringValue(input["icpNumber"])),
		PublicSecurityNumber: normalizeOneLineValue(toStringValue(input["publicSecurityNumber"])),
	}
	if runeLen(record.ICPNumber) > filingNumberMaxLength {
		return siteFilingRecord{}, httpx.BadRequest("ICP备案号长度不能超过 120")
	}
	if runeLen(record.PublicSecurityNumber) > filingNumberMaxLength {
		return siteFilingRecord{}, httpx.BadRequest("公安备案号长度不能超过 120")
	}
	if record.Enabled && record.ICPNumber == "" && record.PublicSecurityNumber == "" {
		return siteFilingRecord{}, httpx.BadRequest("开启前台展示前，请至少填写一个备案号")
	}

	var err error
	record.ICPURL, err = validateFilingURL(input["icpUrl"], defaultICPURL, "ICP 备案链接")
	if err != nil {
		return siteFilingRecord{}, err
	}
	record.PublicSecurityURL, err = validateFilingURL(input["publicSecurityUrl"], defaultPublicSecurityURL, "公安备案链接")
	if err != nil {
		return siteFilingRecord{}, err
	}
	return record, nil
}

// AdminSiteFilingDetail GET /api/admin/filing。
func AdminSiteFilingDetail(c *gin.Context) {
	record, err := loadSiteFilingOrNull(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, BuildSiteFilingResponse(record))
}

// AdminSiteFilingUpdate POST /api/admin/filing。
func AdminSiteFilingUpdate(c *gin.Context) {
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	record, err := validateSiteFilingInput(body)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	now := time.Now()
	_, err = db.Pool().Exec(c.Request.Context(),
		`INSERT INTO petrichor_site_filing
		 (id, enabled, icp_number, icp_url, public_security_number, public_security_url, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
		 ON CONFLICT (id) DO UPDATE SET
		   enabled=$2, icp_number=$3, icp_url=$4, public_security_number=$5,
		   public_security_url=$6, updated_at=$7`,
		SiteFilingID,
		record.Enabled,
		record.ICPNumber,
		record.ICPURL,
		record.PublicSecurityNumber,
		record.PublicSecurityURL,
		now,
	)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	saved, err := loadSiteFilingOrNull(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	invalidatePublicCacheKeys("site-filing")
	httpx.OK(c, BuildSiteFilingResponse(saved))
}
