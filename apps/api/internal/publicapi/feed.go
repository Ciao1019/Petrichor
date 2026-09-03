package publicapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicscope"
)

const publicFeedLimit = 50

type publicFeedArticle struct {
	id        int64
	title     string
	summary   string
	contentMd string
	href      string
	createdAt time.Time
	updatedAt time.Time
	tags      []string
}

func loadPublicFeedArticles(ctx context.Context) ([]publicFeedArticle, error) {
	rows, err := pool().Query(ctx,
		`SELECT DISTINCT ON (a.id)
		        a.id, a.title, COALESCE(a.public_excerpt, ''), COALESCE(a.ai_summary, ''),
		        a.content_md, a.created_at, GREATEST(a.updated_at, s.updated_at), s.share_code, s.internal_url
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE `+publicscope.ShareVisibilityWhere+`
		 ORDER BY a.id, s.id DESC`)
	if err != nil {
		return nil, err
	}
	articles := []publicFeedArticle{}
	articleIDs := []int64{}
	for rows.Next() {
		var article publicFeedArticle
		var excerpt, aiSummary, shareCode string
		var internalURL *string
		if err := rows.Scan(
			&article.id, &article.title, &excerpt, &aiSummary, &article.contentMd,
			&article.createdAt, &article.updatedAt, &shareCode, &internalURL,
		); err != nil {
			rows.Close()
			return nil, err
		}
		article.summary = strings.TrimSpace(excerpt)
		if article.summary == "" {
			article.summary = strings.TrimSpace(aiSummary)
		}
		if article.summary == "" {
			article.summary = buildHomepageArticleExcerpt(article.contentMd, 220)
		}
		article.href = resolveHref(shareCode, internalURL)
		articles = append(articles, article)
		articleIDs = append(articleIDs, article.id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	tags, err := loadTagsByArticleIDs(ctx, articleIDs)
	if err != nil {
		return nil, err
	}
	for index := range articles {
		articles[index].tags = tagsFor(tags, articles[index].id)
	}
	sort.SliceStable(articles, func(i, j int) bool {
		return articles[i].updatedAt.After(articles[j].updatedAt)
	})
	if len(articles) > publicFeedLimit {
		articles = articles[:publicFeedLimit]
	}
	return articles, nil
}

func absolutePublicURL(path string) string {
	if strings.HasPrefix(path, "https://") || strings.HasPrefix(path, "http://") {
		return path
	}
	return strings.TrimRight(config.ResolveBaseURL(), "/") + "/" + strings.TrimLeft(path, "/")
}

type rssDocument struct {
	XMLName xml.Name   `xml:"rss"`
	Version string     `xml:"version,attr"`
	Channel rssChannel `xml:"channel"`
}

type rssChannel struct {
	Title         string    `xml:"title"`
	Link          string    `xml:"link"`
	Description   string    `xml:"description"`
	Language      string    `xml:"language"`
	LastBuildDate string    `xml:"lastBuildDate,omitempty"`
	Items         []rssItem `xml:"item"`
}

type rssItem struct {
	Title       string   `xml:"title"`
	Link        string   `xml:"link"`
	GUID        rssGUID  `xml:"guid"`
	Description string   `xml:"description"`
	PubDate     string   `xml:"pubDate"`
	Categories  []string `xml:"category,omitempty"`
}

type rssGUID struct {
	IsPermaLink string `xml:"isPermaLink,attr"`
	Value       string `xml:",chardata"`
}

type atomDocument struct {
	XMLName xml.Name    `xml:"feed"`
	XMLNS   string      `xml:"xmlns,attr"`
	Title   string      `xml:"title"`
	ID      string      `xml:"id"`
	Updated string      `xml:"updated"`
	Links   []atomLink  `xml:"link"`
	Author  atomAuthor  `xml:"author"`
	Entries []atomEntry `xml:"entry"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr,omitempty"`
	Type string `xml:"type,attr,omitempty"`
}

type atomAuthor struct {
	Name string `xml:"name"`
}

type atomText struct {
	Type  string `xml:"type,attr,omitempty"`
	Value string `xml:",chardata"`
}

type atomEntry struct {
	Title      string     `xml:"title"`
	ID         string     `xml:"id"`
	Updated    string     `xml:"updated"`
	Published  string     `xml:"published"`
	Link       atomLink   `xml:"link"`
	Summary    atomText   `xml:"summary"`
	Categories []atomTerm `xml:"category,omitempty"`
}

type atomTerm struct {
	Term string `xml:"term,attr"`
}

func latestFeedUpdate(articles []publicFeedArticle) time.Time {
	var latest time.Time
	for _, article := range articles {
		if article.updatedAt.After(latest) {
			latest = article.updatedAt
		}
	}
	if latest.IsZero() {
		return time.Unix(0, 0).UTC()
	}
	return latest.UTC()
}

func renderRSSFeed(articles []publicFeedArticle) ([]byte, error) {
	items := make([]rssItem, 0, len(articles))
	for _, article := range articles {
		link := absolutePublicURL(article.href)
		items = append(items, rssItem{
			Title:       article.title,
			Link:        link,
			GUID:        rssGUID{IsPermaLink: "true", Value: link},
			Description: article.summary,
			PubDate:     article.updatedAt.UTC().Format(time.RFC1123Z),
			Categories:  article.tags,
		})
	}
	document := rssDocument{
		Version: "2.0",
		Channel: rssChannel{
			Title:         "Petrichor",
			Link:          absolutePublicURL("/"),
			Description:   "Petrichor 公开知识与文章更新",
			Language:      "zh-CN",
			LastBuildDate: latestFeedUpdate(articles).Format(time.RFC1123Z),
			Items:         items,
		},
	}
	body, err := xml.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), body...), nil
}

func renderAtomFeed(articles []publicFeedArticle) ([]byte, error) {
	entries := make([]atomEntry, 0, len(articles))
	for _, article := range articles {
		link := absolutePublicURL(article.href)
		categories := make([]atomTerm, 0, len(article.tags))
		for _, tag := range article.tags {
			categories = append(categories, atomTerm{Term: tag})
		}
		entries = append(entries, atomEntry{
			Title:      article.title,
			ID:         link,
			Updated:    article.updatedAt.UTC().Format(time.RFC3339),
			Published:  article.createdAt.UTC().Format(time.RFC3339),
			Link:       atomLink{Href: link, Rel: "alternate", Type: "text/html"},
			Summary:    atomText{Type: "text", Value: article.summary},
			Categories: categories,
		})
	}
	document := atomDocument{
		XMLNS:   "http://www.w3.org/2005/Atom",
		Title:   "Petrichor",
		ID:      absolutePublicURL("/"),
		Updated: latestFeedUpdate(articles).Format(time.RFC3339),
		Links: []atomLink{
			{Href: absolutePublicURL("/"), Rel: "alternate", Type: "text/html"},
			{Href: absolutePublicURL("/atom.xml"), Rel: "self", Type: "application/atom+xml"},
		},
		Author:  atomAuthor{Name: "Petrichor"},
		Entries: entries,
	}
	body, err := xml.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), body...), nil
}

func shouldReturnFeedNotModified(ifNoneMatch, ifModifiedSince, etag string, lastModified time.Time) bool {
	if ifNoneMatch = strings.TrimSpace(ifNoneMatch); ifNoneMatch != "" {
		normalizedETag := strings.TrimPrefix(etag, "W/")
		for _, candidate := range strings.Split(ifNoneMatch, ",") {
			candidate = strings.TrimSpace(candidate)
			if candidate == "*" || strings.TrimPrefix(candidate, "W/") == normalizedETag {
				return true
			}
		}
		return false
	}
	modifiedSince, err := http.ParseTime(ifModifiedSince)
	return err == nil && !lastModified.After(modifiedSince)
}

func serveFeed(c *gin.Context, atom bool) {
	articles, err := loadPublicFeedArticles(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	var body []byte
	if atom {
		body, err = renderAtomFeed(articles)
	} else {
		body, err = renderRSSFeed(articles)
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	checksum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(checksum[:16]) + `"`
	lastModified := latestFeedUpdate(articles).Truncate(time.Second)
	c.Header("ETag", etag)
	c.Header("Last-Modified", lastModified.Format(http.TimeFormat))
	c.Header("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=600")
	if shouldReturnFeedNotModified(
		c.GetHeader("If-None-Match"), c.GetHeader("If-Modified-Since"), etag, lastModified,
	) {
		c.Status(http.StatusNotModified)
		return
	}
	contentType := "application/rss+xml; charset=utf-8"
	if atom {
		contentType = "application/atom+xml; charset=utf-8"
	}
	c.Data(http.StatusOK, contentType, body)
}

func RSSFeed(c *gin.Context)  { serveFeed(c, false) }
func AtomFeed(c *gin.Context) { serveFeed(c, true) }
