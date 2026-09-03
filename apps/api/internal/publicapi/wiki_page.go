// wiki_page.go 复刻 public-wiki-handlers.ts 的 publicWikiPageDetail：
// 公开 Wiki 页面详情（前台问答弹窗用），仅返回 sourceRefs 关联到公开文章的页面。
package publicapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicscope"
)

// PublicArticleRef 保留包内既有名称，实际定义统一放在 publicscope。
type PublicArticleRef = publicscope.ArticleRef

// loadPublicArticleScope 是公开问答等既有调用的兼容入口。
func loadPublicArticleScope(ctx context.Context) (map[int64]*PublicArticleRef, error) {
	return publicscope.LoadArticles(ctx)
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
	createdAt       time.Time
	updatedAt       time.Time
}

const wikiPageColumnsPublic = `id, user_id, knowledge_base_id, page_key, title, kind,
	content_md, frontmatter_json, summary, created_at, updated_at`

func scanWikiPage(scanner interface{ Scan(dest ...any) error }) (*wikiPageRecord, error) {
	var r wikiPageRecord
	err := scanner.Scan(&r.id, &r.userID, &r.knowledgeBaseID, &r.pageKey, &r.title, &r.kind,
		&r.contentMd, &r.frontmatterJSON, &r.summary, &r.createdAt, &r.updatedAt)
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
	text := markdownToPlainText(contentMd)
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
	haystack := markdownToPlainText(contentMd)
	lower := strings.ToLower(haystack)
	byteIndex := strings.Index(lower, strings.ToLower(keyword))
	if byteIndex < 0 {
		return ""
	}
	runes := []rune(haystack)
	index := utf8.RuneCountInString(lower[:byteIndex])
	keywordLength := len([]rune(keyword))
	start := index - radius
	prefix := "…"
	if start < 0 {
		start = 0
		prefix = ""
	}
	end := index + keywordLength + radius
	suffix := "…"
	if end > len(runes) {
		end = len(runes)
		suffix = ""
	}
	return prefix + strings.TrimSpace(string(runes[start:end])) + suffix
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
	metadata := readPublicWikiMetadata(page.frontmatterJSON)
	return map[string]any{
		"pageKey":      page.pageKey,
		"title":        page.title,
		"kind":         page.kind,
		"summary":      summary,
		"aliases":      metadata.Aliases,
		"categoryPath": metadata.CategoryPath,
	}
}

func isTopicKind(kind string) bool {
	switch kind {
	case "concept", "entity", "comparison", "answer":
		return true
	}
	return false
}

// resolveAccessiblePage 只从已通过“全部来源均公开”检查的页面集合中解析目标。
func resolveAccessiblePage(
	ctx context.Context,
	safePageIDs []int64,
	knowledgeBaseID *int64,
	pageKey string,
) (*wikiPageRecord, error) {
	if len(safePageIDs) == 0 {
		return nil, notFoundErr("Wiki 页面不存在或不在公开范围内")
	}
	row := pool().QueryRow(ctx,
		`SELECT `+wikiPageColumnsPublic+`
		 FROM petrichor_kb_wiki_page
		 WHERE page_key = $1 AND id = ANY($2) AND archived_at IS NULL
		   AND ($3::bigint IS NULL OR knowledge_base_id = $3)
		 ORDER BY id ASC LIMIT 1`, pageKey, safePageIDs, knowledgeBaseID)
	page, err := scanWikiPage(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFoundErr("Wiki 页面不存在或不在公开范围内")
	}
	return page, err
}

// WikiPageDetail GET /api/public/wiki/page?pageKey=...。
func WikiPageDetail(c *gin.Context) {
	pageKey := strings.TrimSpace(c.Query("pageKey"))
	if pageKey == "" || runeLen(pageKey) > 200 {
		httpx.HandleError(c, badReq("pageKey 不能为空"))
		return
	}
	var knowledgeBaseID *int64
	if rawID := strings.TrimSpace(c.Query("knowledgeBaseId")); rawID != "" {
		parsedID, err := parseInt64(rawID)
		if err != nil || parsedID <= 0 {
			httpx.HandleError(c, badReq("knowledgeBaseId 必须是正整数"))
			return
		}
		knowledgeBaseID = &parsedID
	}
	ctx := c.Request.Context()
	scope, err := loadPublicArticleScope(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	safePageIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, knowledgeBaseID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	page, perr := resolveAccessiblePage(ctx, safePageIDs, knowledgeBaseID, pageKey)
	if perr != nil {
		httpx.HandleError(c, perr)
		return
	}

	detail, derr := readPublicWikiPageDetail(ctx, scope, publicscope.IDSet(safePageIDs), page)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	c.Header("Cache-Control", publicWikiCacheControl)
	httpx.OK(c, detail)
}

// readPublicWikiPageDetail 页面详情：全文 + 出入链邻居摘要 + 来源文章（WeKnora 式）。
func readPublicWikiPageDetail(
	ctx context.Context,
	scope map[int64]*PublicArticleRef,
	safePageIDs map[int64]struct{},
	page *wikiPageRecord,
) (map[string]any, error) {
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

	var knowledgeBaseName string
	if err := pool().QueryRow(ctx,
		`SELECT name FROM petrichor_kb_knowledge_base WHERE id = $1`,
		page.knowledgeBaseID).Scan(&knowledgeBaseName); err != nil {
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
			"href":     publicWikiPageHref(page.knowledgeBaseID, pageKey),
		}
	}

	linkItems := []map[string]any{}
	for _, l := range links {
		resolved := outByKey[l.toPageKey]
		if resolved == nil {
			continue
		}
		if _, safe := safePageIDs[resolved.id]; !safe {
			continue
		}
		linkItems = append(linkItems, buildNeighbor(l.toPageKey, l.linkType, resolved))
	}
	inLinkItems := []map[string]any{}
	for _, l := range inLinks {
		resolved := neighborByID[l.fromPage]
		if resolved == nil {
			continue
		}
		if _, safe := safePageIDs[resolved.id]; !safe {
			continue
		}
		inLinkItems = append(inLinkItems, buildNeighbor(resolved.pageKey, l.linkType, resolved))
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

	mediaToken, err := issueMediaAccessToken(mediaKindWiki, page.id)
	if err != nil {
		return nil, err
	}
	resp := toWikiQaCard(page)
	resp["knowledgeBaseId"] = formatInt(page.knowledgeBaseID)
	resp["knowledgeBaseName"] = knowledgeBaseName
	resp["href"] = publicWikiPageHref(page.knowledgeBaseID, page.pageKey)
	resp["updatedAt"] = httpx.FormatISO(page.updatedAt)
	resp["contentMd"] = page.contentMd
	resp["links"] = linkItems
	resp["inLinks"] = inLinkItems
	resp["sourceArticles"] = sourceArticles
	resp["mediaAccessToken"] = mediaToken
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
