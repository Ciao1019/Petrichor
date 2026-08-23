// Package sitecontent 复刻 src/server/public-content-cache.ts 与各公开读取 loader：
// about/appearance/projects/site-graph 的公开侧只读入口 + Upstash/进程内缓存失效。
package sitecontent

import (
	"petrichor/api/internal/cache"
)

// 公开内容缓存统一 TTL：1 天。写操作都会主动失效，TTL 只是兜底上限。
const TTLSeconds = cache.OneDaySeconds

// CacheKey 带命名空间的缓存键（petrichor:<parts>）。
func CacheKey(parts ...string) string { return cache.CacheKey(parts...) }

// 各公开内容的 Redis 缓存键（与 TS publicContentRedisKey 一致）。
var (
	articleListCacheKey      = CacheKey("public", "article-list")
	articleDetailCachePrefix = CacheKey("public", "article-detail") + ":"
	aboutProfileCacheKey     = CacheKey("public", "about-profile")
	projectShowcaseCacheKey  = CacheKey("public", "project-showcase")
	siteAppearanceCacheKey   = CacheKey("public", "site-appearance")
	siteGraphCacheKey        = CacheKey("public", "site-graph")
)

// InvalidateArticleListCache 失效公开文章列表缓存。
func InvalidateArticleListCache() { cache.Drop(articleListCacheKey) }

// InvalidateArticleDetailCache 失效公开文章详情缓存；shareCode 为空时清全部详情缓存。
func InvalidateArticleDetailCache(shareCode string) {
	if shareCode != "" {
		cache.Drop(articleDetailCachePrefix + shareCode)
		return
	}
	cache.DropByPrefix(articleDetailCachePrefix)
}

// InvalidateAboutProfileCache 失效「关于我」公开缓存。
func InvalidateAboutProfileCache() { cache.Drop(aboutProfileCacheKey) }

// InvalidateProjectShowcaseCache 失效开源项目展示公开缓存。
func InvalidateProjectShowcaseCache() { cache.Drop(projectShowcaseCacheKey) }

// InvalidateSiteAppearanceCache 失效站点外观公开缓存。
func InvalidateSiteAppearanceCache() { cache.Drop(siteAppearanceCacheKey) }

// InvalidateSiteGraphCache 失效前台星图公开缓存。
func InvalidateSiteGraphCache() { cache.Drop(siteGraphCacheKey) }

// ArticleListCacheKey 公开文章列表的缓存键（kb 写路径失效与 publicapi 读穿透共用）。
func ArticleListCacheKey() string { return articleListCacheKey }

// ArticleDetailCacheKey 单篇公开文章详情的缓存键（按 shareCode 分键）。
func ArticleDetailCacheKey(shareCode string) string {
	return articleDetailCachePrefix + shareCode
}

// AboutProfileCacheKey 公开「关于我」缓存键。
func AboutProfileCacheKey() string { return aboutProfileCacheKey }

// SiteAppearanceCacheKey 公开站点外观缓存键。
func SiteAppearanceCacheKey() string { return siteAppearanceCacheKey }

// ProjectShowcaseCacheKey 公开项目展示缓存键。
func ProjectShowcaseCacheKey() string { return projectShowcaseCacheKey }

// SiteGraphCacheKey 公开星图载荷缓存键。
func SiteGraphCacheKey() string { return siteGraphCacheKey }
