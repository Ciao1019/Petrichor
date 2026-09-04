// site_endpoints.go 站点内容公开端点：about / appearance / filing / projects。
package publicapi

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/cache"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/sitecontent"
)

// AboutProfile GET+POST /api/public/about/profile。
func AboutProfile(c *gin.Context) {
	ctx := c.Request.Context()
	resp, err := cache.ReadThrough(sitecontent.AboutProfileCacheKey(), sitecontent.TTLSeconds,
		func() (map[string]any, error) { return sitecontent.LoadPublicAboutProfileResponse(ctx) })
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, resp)
}

// SiteAppearance GET+POST /api/public/appearance。
func SiteAppearance(c *gin.Context) {
	ctx := c.Request.Context()
	resp, err := cache.ReadThrough(sitecontent.SiteAppearanceCacheKey(), sitecontent.TTLSeconds,
		func() (map[string]any, error) { return sitecontent.LoadPublicSiteAppearanceResponse(ctx) })
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, resp)
}

// SiteFiling GET /api/public/filing。
func SiteFiling(c *gin.Context) {
	ctx := c.Request.Context()
	resp, err := cache.ReadThrough(sitecontent.SiteFilingCacheKey(), sitecontent.TTLSeconds,
		func() (map[string]any, error) { return sitecontent.LoadPublicSiteFilingResponse(ctx) })
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, resp)
}

// ProjectShowcase GET+POST /api/public/projects。
func ProjectShowcase(c *gin.Context) {
	ctx := c.Request.Context()
	resp, err := cache.ReadThrough(sitecontent.ProjectShowcaseCacheKey(), sitecontent.TTLSeconds,
		func() (map[string]any, error) { return sitecontent.LoadPublicProjectShowcaseResponse(ctx) })
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, resp)
}
