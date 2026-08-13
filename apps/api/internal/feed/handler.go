package feed

import (
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

type Handler struct {
	client *ent.Client
	cfg    *config.Config
}

func NewHandler(client *ent.Client, cfg *config.Config) *Handler {
	return &Handler{client: client, cfg: cfg}
}

type feedItem struct {
	Title     string
	Href      string
	Excerpt   string
	Tags      []string
	UpdatedAt time.Time
	PinOrder  *int
	ShareID   int64
}

func escapeXML(s string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(s)
}

func (h *Handler) baseURL() string {
	base := strings.TrimRight(strings.TrimSpace(h.cfg.AppURL), "/")
	if base == "" {
		base = "http://localhost:3000"
	}
	if parsed, err := url.Parse(base); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		base = parsed.Scheme + "://" + parsed.Host
	}
	return base
}

func isPublicShareVisible(share *ent.KBArticleShare, now time.Time) bool {
	if share == nil || !share.Enabled || share.RevokedAt != nil {
		return false
	}
	if share.ExpiresAt != nil && !share.ExpiresAt.After(now) {
		return false
	}
	return true
}

func (h *Handler) listPublicItems(c *gin.Context) ([]feedItem, error) {
	now := time.Now().UTC()
	rows, err := h.client.KBArticleShare.Query().
		Where(
			kbarticleshare.EnabledEQ(true),
			kbarticleshare.RevokedAtIsNil(),
		).
		Order(ent.Desc(kbarticleshare.FieldID)).
		All(c.Request.Context())
	if err != nil {
		return nil, err
	}
	articleIDs := make([]int64, 0, len(rows))
	for _, share := range rows {
		articleIDs = append(articleIDs, share.ArticleID)
	}
	tagsByArticle := make(map[int64][]string)
	if len(articleIDs) > 0 {
		tags, tagErr := h.client.KBArticleTag.Query().
			Where(kbarticletag.ArticleIDIn(articleIDs...)).
			Order(ent.Asc(kbarticletag.FieldTag)).
			All(c.Request.Context())
		if tagErr == nil {
			for _, tag := range tags {
				tagsByArticle[tag.ArticleID] = append(tagsByArticle[tag.ArticleID], tag.Tag)
			}
		}
	}
	items := make([]feedItem, 0, len(rows))
	for _, share := range rows {
		if !isPublicShareVisible(share, now) {
			continue
		}
		if share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != "" {
			continue
		}
		article, err := h.client.KBArticle.Get(c.Request.Context(), share.ArticleID)
		if err != nil {
			continue
		}
		excerpt := ""
		if article.AiSummary != nil {
			excerpt = strings.TrimSpace(*article.AiSummary)
		}
		if excerpt == "" && article.PublicExcerpt != nil {
			excerpt = strings.TrimSpace(*article.PublicExcerpt)
		}
		href := "/p/" + share.ShareCode
		if share.InternalURL != nil && strings.HasPrefix(strings.TrimSpace(*share.InternalURL), "/") {
			href = strings.TrimSpace(*share.InternalURL)
		}
		items = append(items, feedItem{
			Title:     article.Title,
			Href:      href,
			Excerpt:   excerpt,
			Tags:      tagsByArticle[article.ID],
			UpdatedAt: article.UpdatedAt.UTC(),
			PinOrder:  share.PinOrder,
			ShareID:   share.ID,
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		left, right := items[i], items[j]
		if (left.PinOrder != nil) != (right.PinOrder != nil) {
			return left.PinOrder != nil
		}
		if left.PinOrder != nil && right.PinOrder != nil && *left.PinOrder != *right.PinOrder {
			return *left.PinOrder > *right.PinOrder
		}
		if !left.UpdatedAt.Equal(right.UpdatedAt) {
			return left.UpdatedAt.After(right.UpdatedAt)
		}
		return left.ShareID > right.ShareID
	})
	return items, nil
}

func (h *Handler) absoluteURL(path string) string {
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return h.baseURL() + path
}

func latestUpdated(items []feedItem) time.Time {
	latest := time.Time{}
	for _, item := range items {
		if item.UpdatedAt.After(latest) {
			latest = item.UpdatedAt
		}
	}
	if latest.IsZero() {
		return time.Now().UTC()
	}
	return latest
}

// RSS 输出 RSS 2.0 公开文章订阅。
func (h *Handler) RSS(c *gin.Context) {
	items, err := h.listPublicItems(c)
	if err != nil {
		c.String(500, "feed error")
		return
	}
	siteURL := h.absoluteURL("/")
	selfURL := h.absoluteURL("/rss.xml")
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>` + "\n")
	b.WriteString(`<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">` + "\n")
	b.WriteString("  <channel>\n")
	b.WriteString("    <title>" + escapeXML("Petrichor") + "</title>\n")
	b.WriteString("    <link>" + escapeXML(siteURL) + "</link>\n")
	b.WriteString("    <description>" + escapeXML("Petrichor 公开文章、知识与灵感更新。") + "</description>\n")
	b.WriteString(`    <atom:link href="` + escapeXML(selfURL) + `" rel="self" type="application/rss+xml" />` + "\n")
	b.WriteString("    <lastBuildDate>" + escapeXML(latestUpdated(items).Format(time.RFC1123Z)) + "</lastBuildDate>\n")
	for _, item := range items {
		href := h.absoluteURL(item.Href)
		b.WriteString("    <item>\n")
		b.WriteString("      <title>" + escapeXML(item.Title) + "</title>\n")
		b.WriteString("      <link>" + escapeXML(href) + "</link>\n")
		b.WriteString(`      <guid isPermaLink="true">` + escapeXML(href) + "</guid>\n")
		b.WriteString("      <pubDate>" + escapeXML(item.UpdatedAt.Format(time.RFC1123Z)) + "</pubDate>\n")
		b.WriteString("      <description>" + escapeXML(item.Excerpt) + "</description>\n")
		for _, tag := range item.Tags {
			if tag = strings.TrimSpace(tag); tag != "" {
				b.WriteString("      <category>" + escapeXML(tag) + "</category>\n")
			}
		}
		b.WriteString("    </item>\n")
	}
	b.WriteString("  </channel>\n</rss>\n")
	c.Header("Content-Type", "application/rss+xml; charset=utf-8")
	c.Header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600")
	c.String(200, b.String())
}

// Atom 输出 Atom 公开文章订阅。
func (h *Handler) Atom(c *gin.Context) {
	items, err := h.listPublicItems(c)
	if err != nil {
		c.String(500, "feed error")
		return
	}
	siteURL := h.absoluteURL("/")
	selfURL := h.absoluteURL("/atom.xml")
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>` + "\n")
	b.WriteString(`<feed xmlns="http://www.w3.org/2005/Atom">` + "\n")
	b.WriteString("  <title>" + escapeXML("Petrichor") + "</title>\n")
	b.WriteString("  <subtitle>" + escapeXML("Petrichor 公开文章、知识与灵感更新。") + "</subtitle>\n")
	b.WriteString(`  <link href="` + escapeXML(siteURL) + `" />` + "\n")
	b.WriteString(`  <link rel="self" href="` + escapeXML(selfURL) + `" />` + "\n")
	b.WriteString("  <id>" + escapeXML(siteURL) + "</id>\n")
	b.WriteString("  <updated>" + escapeXML(latestUpdated(items).Format(time.RFC3339)) + "</updated>\n")
	for _, item := range items {
		href := h.absoluteURL(item.Href)
		b.WriteString("  <entry>\n")
		b.WriteString("    <title>" + escapeXML(item.Title) + "</title>\n")
		b.WriteString(`    <link href="` + escapeXML(href) + `" />` + "\n")
		b.WriteString("    <id>" + escapeXML(href) + "</id>\n")
		b.WriteString("    <updated>" + escapeXML(item.UpdatedAt.Format(time.RFC3339)) + "</updated>\n")
		b.WriteString("    <summary>" + escapeXML(item.Excerpt) + "</summary>\n")
		for _, tag := range item.Tags {
			if tag = strings.TrimSpace(tag); tag != "" {
				b.WriteString(`    <category term="` + escapeXML(tag) + `" />` + "\n")
			}
		}
		b.WriteString("  </entry>\n")
	}
	b.WriteString("</feed>\n")
	c.Header("Content-Type", "application/atom+xml; charset=utf-8")
	c.Header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600")
	c.String(200, b.String())
}
