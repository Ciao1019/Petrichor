// wiki_page.go 复刻 public-wiki-handlers.ts 的 publicWikiPageDetail：
// 公开 Wiki 页面详情（前台问答弹窗用），仅返回 sourceRefs 关联到公开文章的页面。
package publicapi

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
)

// PublicArticleRef 一篇公开（已分享、未撤销、未过期、无密码）文章的归属信息。
type PublicArticleRef struct {
	ArticleID       int64
	UserID          int64
	KnowledgeBaseID int64
	ShareCode       string
	Title           string
}

// loadPublicArticleScope 加载当前所有「公开可访问」的文章作用域：
// 已启用分享、未撤销、未过期、且无访问密码。公开 Wiki/问答检索的唯一可达边界。
func loadPublicArticleScope(ctx context.Context) (map[int64]*PublicArticleRef, error) {
	rows, err := pool().Query(ctx,
		`SELECT a.id, a.user_id, a.knowledge_base_id, a.title, s.share_code
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE s.enabled = true AND s.revoked_at IS NULL
		   AND (s.password_hash IS NULL OR btrim(s.password_hash) = '')
		   AND (s.expires_at IS NULL OR s.expires_at > now())`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scope := map[int64]*PublicArticleRef{}
	for rows.Next() {
		var ref PublicArticleRef
		if serr := rows.Scan(&ref.ArticleID, &ref.UserID, &ref.KnowledgeBaseID, &ref.Title, &ref.ShareCode); serr != nil {
			return nil, serr
		}
		scope[ref.ArticleID] = &ref
	}
	return scope, rows.Err()
}

type wikiPageRecord struct {
	id              int64
	userID          int64
	knowledgeBaseID int64
	pageKey         string
	title           string
	kind            string
	contentMd       string
	frontmatterJSON *string
	summary         *string
}

const wikiPageColumnsPublic = `id, user_id, knowledge_base_id, page_key, title, kind,
	content_md, frontmatter_json, summary`

func scanWikiPage(scanner interface{ Scan(dest ...any) error }) (*wikiPageRecord, error) {
	var r wikiPageRecord
	err := scanner.Scan(&r.id, &r.userID, &r.knowledgeBaseID, &r.pageKey, &r.title, &r.kind,
		&r.contentMd, &r.frontmatterJSON, &r.summary)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

type wikiLinkRow struct {
	id        int64
	fromPage  int64
	toPageKey string
	linkType  string
}

// summarizeWikiContent 对应 wiki-qa-core.ts 的 summarizeWikiContent（省略号截断）。
func summarizeWikiContent(contentMd string, maxLength int) string {
	text := fenceRe.ReplaceAllString(contentMd, " ")
	text = regexp.MustCompile("[#>*_`~-]+").ReplaceAllString(text, "")
	text = spaceRe.ReplaceAllString(text, " ")
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) > maxLength {
		return string(runes[:maxLength]) + "…"
	}
	return text
}

// extractWikiMatchSnippet 从正文中提取关键词命中的前后文片段。
func extractWikiMatchSnippet(contentMd, keyword string, radius int) string {
	if keyword == "" {
		return ""
	}
	haystack := fenceRe.ReplaceAllString(contentMd, " ")
	lower := strings.ToLower(haystack)
	index := strings.Index(lower, strings.ToLower(keyword))
	if index < 0 {
		return ""
	}
	start := index - radius
	prefix := "…"
	if start < 0 {
		start = 0
		prefix = ""
	}
	end := index + len(keyword) + radius
	suffix := "…"
	if end > len(haystack) {
		end = len(haystack)
		suffix = ""
	}
	fragment := spaceRe.ReplaceAllString(haystack[start:end], " ")
	return prefix + strings.TrimSpace(fragment) + suffix
}

// readFrontmatterAliases 读取 frontmatter JSON 的 aliases 数组。
func readFrontmatterAliases(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var parsed struct {
		Aliases []any `json:"aliases"`
	}
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return []string{}
	}
	out := []string{}
	for _, item := range parsed.Aliases {
		value := strings.TrimSpace(toStr(item))
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

// toWikiQaCard 页面卡：摘要缺失时从正文现场派生。
func toWikiQaCard(page *wikiPageRecord) map[string]any {
	summary := strings.TrimSpace(derefStr(page.summary))
	if summary == "" {
		summary = summarizeWikiContent(page.contentMd, 160)
	}
	return map[string]any{
		"pageKey": page.pageKey,
		"title":   page.title,
		"kind":    page.kind,
		"summary": summary,
		"aliases": readFrontmatterAliases(page.frontmatterJSON),
	}
}

func isTopicKind(kind string) bool {
	switch kind {
	case "concept", "entity", "comparison", "answer":
		return true
	}
	return false
}

// resolveAccessiblePage 按 pageKey 找到公开可达的目标页面；index 页在知识库有公开文章时放行。
func resolveAccessiblePage(ctx context.Context, scope map[int64]*PublicArticleRef, pageKey string) (*wikiPageRecord, error) {
	rows, err := pool().Query(ctx,
		`SELECT `+wikiPageColumnsPublic+`
		 FROM petrichor_kb_wiki_page
		 WHERE page_key = $1 AND archived_at IS NULL ORDER BY id ASC`, pageKey)
	if err != nil {
		return nil, err
	}
	pages := []*wikiPageRecord{}
	for rows.Next() {
		page, serr := scanWikiPage(rows)
		if serr != nil {
			rows.Close()
			return nil, serr
		}
		pages = append(pages, page)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(pages) == 0 {
		return nil, notFoundErr("Wiki 页面不存在")
	}

	pageIDs := make([]int64, 0, len(pages))
	for _, page := range pages {
		pageIDs = append(pageIDs, page.id)
	}
	refRows, rerr := pool().Query(ctx,
		`SELECT page_id, article_id FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)`, pageIDs)
	if rerr != nil {
		return nil, rerr
	}
	type pageArticleRef struct {
		pageID    int64
		articleID int64
	}
	refs := []pageArticleRef{}
	for refRows.Next() {
		var item pageArticleRef
		if serr := refRows.Scan(&item.pageID, &item.articleID); serr != nil {
			refRows.Close()
			return nil, serr
		}
		refs = append(refs, item)
	}
	refRows.Close()
	if err := refRows.Err(); err != nil {
		return nil, err
	}

	for _, page := range pages {
		for _, ref := range refs {
			if ref.pageID == page.id {
				if _, public := scope[ref.articleID]; public {
					return page, nil
				}
			}
		}
	}

	// index 页特例：其知识库下存在任何公开文章即可读（目录不含敏感正文）。
	for _, page := range pages {
		if page.kind != "index" {
			continue
		}
		for _, ref := range refs {
			if article, public := scope[ref.articleID]; public &&
				article.UserID == page.userID && article.KnowledgeBaseID == page.knowledgeBaseID {
				return page, nil
			}
		}
	}

	return nil, notFoundErr("该 Wiki 页面不在公开范围内")
}

// WikiPageDetail GET /api/public/wiki/page?pageKey=...。
func WikiPageDetail(c *gin.Context) {
	pageKey := strings.TrimSpace(c.Query("pageKey"))
	if pageKey == "" || runeLen(pageKey) > 200 {
		httpx.HandleError(c, badReq("pageKey 不能为空"))
		return
	}
	ctx := c.Request.Context()
	scope, err := loadPublicArticleScope(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	page, perr := resolveAccessiblePage(ctx, scope, pageKey)
	if perr != nil {
		httpx.HandleError(c, perr)
		return
	}

	detail, derr := readPublicWikiPageDetail(ctx, scope, page)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	httpx.OK(c, detail)
}

// readPublicWikiPageDetail 页面详情：全文 + 出入链邻居摘要 + 来源文章（WeKnora 式）。
func readPublicWikiPageDetail(ctx context.Context, scope map[int64]*PublicArticleRef, page *wikiPageRecord) (map[string]any, error) {
	links := []wikiLinkRow{}
	linkRows, err := pool().Query(ctx,
		`SELECT id, from_page_id, to_page_key, link_type FROM petrichor_kb_wiki_link
		 WHERE from_page_id = $1 ORDER BY id ASC`, page.id)
	if err != nil {
		return nil, err
	}
	for linkRows.Next() {
		var l wikiLinkRow
		if serr := linkRows.Scan(&l.id, &l.fromPage, &l.toPageKey, &l.linkType); serr != nil {
			linkRows.Close()
			return nil, serr
		}
		links = append(links, l)
	}
	linkRows.Close()
	if err := linkRows.Err(); err != nil {
		return nil, err
	}

	inLinks := []wikiLinkRow{}
	inRows, err := pool().Query(ctx,
		`SELECT id, from_page_id, to_page_key, link_type FROM petrichor_kb_wiki_link
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND to_page_key = $3
		 ORDER BY from_page_id ASC`, page.userID, page.knowledgeBaseID, page.pageKey)
	if err != nil {
		return nil, err
	}
	for inRows.Next() {
		var l wikiLinkRow
		if serr := inRows.Scan(&l.id, &l.fromPage, &l.toPageKey, &l.linkType); serr != nil {
			inRows.Close()
			return nil, serr
		}
		inLinks = append(inLinks, l)
	}
	inRows.Close()
	if err := inRows.Err(); err != nil {
		return nil, err
	}

	// 邻居页面：入链的来源页 + 出链目标键对应页。
	inFromIDs := uniqueInt64(func() []int64 {
		ids := make([]int64, 0, len(inLinks))
		for _, l := range inLinks {
			ids = append(ids, l.fromPage)
		}
		return ids
	}())
	neighborByID, err := loadPagesByIDs(ctx, inFromIDs)
	if err != nil {
		return nil, err
	}
	outKeys := uniqueStrings(func() []string {
		keys := make([]string, 0, len(links))
		for _, l := range links {
			keys = append(keys, l.toPageKey)
		}
		return keys
	}())
	outByKey, err := loadOutTargetPages(ctx, page.knowledgeBaseID, outKeys)
	if err != nil {
		return nil, err
	}

	buildNeighbor := func(pageKey, linkType string, resolved *wikiPageRecord) map[string]any {
		title := pageKey
		var kind any
		var summary any
		if resolved != nil {
			title = resolved.title
			kind = resolved.kind
			s := strings.TrimSpace(derefStr(resolved.summary))
			if s == "" {
				s = summarizeWikiContent(resolved.contentMd, 120)
			}
			summary = s
		}
		return map[string]any{
			"pageKey":  pageKey,
			"title":    title,
			"kind":     kind,
			"summary":  summary,
			"linkType": linkType,
		}
	}

	linkItems := []map[string]any{}
	for _, l := range links {
		linkItems = append(linkItems, buildNeighbor(l.toPageKey, l.linkType, outByKey[l.toPageKey]))
	}
	inLinkItems := []map[string]any{}
	for _, l := range inLinks {
		resolved := neighborByID[l.fromPage]
		key := ""
		if resolved != nil {
			key = resolved.pageKey
		}
		if key == "" {
			continue
		}
		inLinkItems = append(inLinkItems, buildNeighbor(key, l.linkType, resolved))
	}

	// 来源文章：只列仍在公开作用域内的引用。
	sourceRefRows, err := pool().Query(ctx,
		`SELECT article_id, note FROM petrichor_kb_wiki_source_ref WHERE page_id = $1`, page.id)
	if err != nil {
		return nil, err
	}
	type sourceRef struct {
		articleID int64
		note      *string
	}
	refs := []sourceRef{}
	for sourceRefRows.Next() {
		var ref sourceRef
		if serr := sourceRefRows.Scan(&ref.articleID, &ref.note); serr != nil {
			sourceRefRows.Close()
			return nil, serr
		}
		refs = append(refs, ref)
	}
	sourceRefRows.Close()
	if err := sourceRefRows.Err(); err != nil {
		return nil, err
	}

	sourceArticles := []map[string]any{}
	for _, ref := range refs {
		article, ok := scope[ref.articleID]
		if !ok {
			continue
		}
		sourceArticles = append(sourceArticles, map[string]any{
			"articleId": formatInt(article.ArticleID),
			"title":     article.Title,
			"href":      "/p/" + article.ShareCode,
			"note":      nullableString(ref.note),
		})
	}

	resp := toWikiQaCard(page)
	resp["contentMd"] = page.contentMd
	resp["links"] = linkItems
	resp["inLinks"] = inLinkItems
	resp["sourceArticles"] = sourceArticles
	return resp, nil
}

func loadPagesByIDs(ctx context.Context, ids []int64) (map[int64]*wikiPageRecord, error) {
	result := map[int64]*wikiPageRecord{}
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT `+wikiPageColumnsPublic+` FROM petrichor_kb_wiki_page
		 WHERE id = ANY($1) AND archived_at IS NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		page, serr := scanWikiPage(rows)
		if serr != nil {
			return nil, serr
		}
		result[page.id] = page
	}
	return result, rows.Err()
}

func loadOutTargetPages(ctx context.Context, knowledgeBaseID int64, pageKeys []string) (map[string]*wikiPageRecord, error) {
	result := map[string]*wikiPageRecord{}
	if len(pageKeys) == 0 {
		return result, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT `+wikiPageColumnsPublic+` FROM petrichor_kb_wiki_page
		 WHERE page_key = ANY($1) AND knowledge_base_id = $2 AND archived_at IS NULL`,
		pageKeys, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		page, serr := scanWikiPage(rows)
		if serr != nil {
			return nil, serr
		}
		result[page.pageKey] = page
	}
	return result, rows.Err()
}

func uniqueInt64(ids []int64) []int64 {
	seen := map[int64]struct{}{}
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := values[:0]
	for _, v := range values {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

func nullableString(v *string) any {
	if v == nil || strings.TrimSpace(*v) == "" {
		return nil
	}
	return *v
}
