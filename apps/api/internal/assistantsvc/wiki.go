// wiki.go 对照 wiki-handlers.ts + kb/wiki-qa-user.ts + kb/wiki-qa-core.ts：
// 后台助手的 Wiki 页面详情（回答里的 [[..]] 引用点击弹窗用）。
// 作用域 = 当前登录用户自己的知识库页面；focus 指定知识库时用于消除同名 pageKey 歧义。
package assistantsvc

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
)

type wikiPageRow struct {
	ID              int64
	UserID          int64
	KnowledgeBaseID int64
	PageKey         string
	Title           string
	Kind            string
	ContentMd       string
	FrontmatterJSON *string
	Summary         *string
	Version         int32
}

const wikiQaPageColumns = `id, user_id, knowledge_base_id, page_key, title, kind, content_md,
	frontmatter_json, summary, version`

func scanWikiQaPage(row interface{ Scan(dest ...any) error }) (*wikiPageRow, error) {
	var r wikiPageRow
	if err := row.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.PageKey, &r.Title, &r.Kind,
		&r.ContentMd, &r.FrontmatterJSON, &r.Summary, &r.Version); err != nil {
		return nil, err
	}
	return &r, nil
}

// AssistantWikiPageDetailHandler GET /api/assistant/wiki/page?pageKey=&knowledgeBaseId=。
func AssistantWikiPageDetailHandler(c *gin.Context) {
	pageKey := trimSpaceStr(c.Query("pageKey"))
	if pageKey == "" || runeLen(pageKey) > 200 {
		// 对照 zod pageKeySchema：越界走统一「请求参数错误」
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	var knowledgeBaseID *int64
	// TS：仅纯数字时解析，否则视为未指定（不报错）
	if raw := trimSpaceStr(c.Query("knowledgeBaseId")); isDigitString(raw) {
		if n, perr := strconv.ParseInt(raw, 10, 64); perr == nil && n >= 0 {
			knowledgeBaseID = &n
		}
	}
	user := currentUserOf(c)
	detail, err := readUserWikiPageDetail(c.Request.Context(), user.ID, pageKey, knowledgeBaseID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, detail)
}

func isDigitString(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// readUserWikiPageDetail 对照 readUserWikiPageDetail。
// pageKey 在用户多个库里可能同名：指定 knowledgeBaseId 时优先命中该库，否则取最早创建的页面。
func readUserWikiPageDetail(ctx context.Context, userID int64, pageKey string, knowledgeBaseID *int64) (map[string]any, error) {
	rows, err := dbPool().Query(ctx,
		`SELECT `+wikiQaPageColumns+` FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND page_key = $2 AND archived_at IS NULL
		 ORDER BY id ASC`, userID, pageKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []*wikiPageRow
	for rows.Next() {
		p, err := scanWikiQaPage(rows)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, httpx.NotFound("Wiki 页面不存在")
	}
	page := candidates[0]
	if knowledgeBaseID != nil {
		for _, candidate := range candidates {
			if candidate.KnowledgeBaseID == *knowledgeBaseID {
				page = candidate
				break
			}
		}
	}

	linkRows, inLinkRows, err := loadWikiLinks(ctx, page)
	if err != nil {
		return nil, err
	}
	neighborByID, outByKey, err := loadWikiNeighbors(ctx, page, linkRows, inLinkRows)
	if err != nil {
		return nil, err
	}
	sourceArticles, err := loadWikiSourceArticles(ctx, page)
	if err != nil {
		return nil, err
	}

	card := toWikiQaCard(page)
	links := make([]map[string]any, 0, len(linkRows))
	for _, link := range linkRows {
		links = append(links, toWikiNeighbor(link.ToPageKey, link.LinkType, outByKey[link.ToPageKey]))
	}
	inLinks := make([]map[string]any, 0, len(inLinkRows))
	for _, link := range inLinkRows {
		from := neighborByID[link.FromPageID]
		pageKeyValue := ""
		if from != nil {
			pageKeyValue = from.PageKey
		}
		item := toWikiNeighbor(pageKeyValue, link.LinkType, from)
		if item["pageKey"] == "" {
			continue
		}
		inLinks = append(inLinks, item)
	}

	return map[string]any{
		"pageKey":        card["pageKey"],
		"title":          card["title"],
		"kind":           card["kind"],
		"summary":        card["summary"],
		"aliases":        card["aliases"],
		"contentMd":      page.ContentMd,
		"links":          links,
		"inLinks":        inLinks,
		"sourceArticles": sourceArticles,
	}, nil
}

type wikiLinkRow struct {
	ID         int64
	UserID     int64
	KbID       int64
	FromPageID int64
	ToPageKey  string
	LinkType   string
}

func loadWikiLinks(ctx context.Context, page *wikiPageRow) ([]wikiLinkRow, []wikiLinkRow, error) {
	load := func(sql string, args ...any) ([]wikiLinkRow, error) {
		rows, err := dbPool().Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []wikiLinkRow
		for rows.Next() {
			var l wikiLinkRow
			if err := rows.Scan(&l.ID, &l.UserID, &l.KbID, &l.FromPageID, &l.ToPageKey, &l.LinkType); err != nil {
				return nil, err
			}
			out = append(out, l)
		}
		return out, rows.Err()
	}
	links, err := load(
		`SELECT id, user_id, knowledge_base_id, from_page_id, to_page_key, link_type
		 FROM petrichor_kb_wiki_link WHERE from_page_id = $1 ORDER BY id ASC`, page.ID)
	if err != nil {
		return nil, nil, err
	}
	inLinks, err := load(
		`SELECT id, user_id, knowledge_base_id, from_page_id, to_page_key, link_type
		 FROM petrichor_kb_wiki_link
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND to_page_key = $3
		 ORDER BY from_page_id ASC`, page.UserID, page.KnowledgeBaseID, page.PageKey)
	if err != nil {
		return nil, nil, err
	}
	return links, inLinks, nil
}

func loadWikiNeighbors(ctx context.Context, page *wikiPageRow,
	links, inLinks []wikiLinkRow) (map[int64]*wikiPageRow, map[string]*wikiPageRow, error) {
	neighborIDs := dedupeInt64Of(func() []int64 {
		out := make([]int64, 0, len(inLinks))
		for _, link := range inLinks {
			out = append(out, link.FromPageID)
		}
		return out
	}())
	outTargets := func() []string {
		seen := map[string]bool{}
		out := make([]string, 0, len(links))
		for _, link := range links {
			if seen[link.ToPageKey] {
				continue
			}
			seen[link.ToPageKey] = true
			out = append(out, link.ToPageKey)
		}
		return out
	}()

	load := func(sql string, args ...any) ([]*wikiPageRow, error) {
		rows, err := dbPool().Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []*wikiPageRow
		for rows.Next() {
			p, err := scanWikiQaPage(rows)
			if err != nil {
				return nil, err
			}
			out = append(out, p)
		}
		return out, rows.Err()
	}

	var neighborRows []*wikiPageRow
	if len(neighborIDs) > 0 {
		found, err := load(
			`SELECT `+wikiQaPageColumns+` FROM petrichor_kb_wiki_page
			 WHERE id = ANY($1) AND archived_at IS NULL`, neighborIDs)
		if err != nil {
			return nil, nil, err
		}
		neighborRows = found
	}
	var outTargetRows []*wikiPageRow
	if len(outTargets) > 0 {
		found, err := load(
			`SELECT `+wikiQaPageColumns+` FROM petrichor_kb_wiki_page
			 WHERE page_key = ANY($1) AND knowledge_base_id = $2 AND archived_at IS NULL`,
			outTargets, page.KnowledgeBaseID)
		if err != nil {
			return nil, nil, err
		}
		outTargetRows = found
	}

	neighborByID := map[int64]*wikiPageRow{}
	for _, row := range neighborRows {
		neighborByID[row.ID] = row
	}
	outByKey := map[string]*wikiPageRow{}
	for _, row := range outTargetRows {
		outByKey[row.PageKey] = row
	}
	return neighborByID, outByKey, nil
}

func loadWikiSourceArticles(ctx context.Context, page *wikiPageRow) ([]map[string]any, error) {
	rows, err := dbPool().Query(ctx,
		`SELECT article_id, anchor, note FROM petrichor_kb_wiki_source_ref WHERE page_id = $1`, page.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type sourceRef struct {
		ArticleID int64
		Anchor    *string
		Note      *string
	}
	var refs []sourceRef
	for rows.Next() {
		var ref sourceRef
		if err := rows.Scan(&ref.ArticleID, &ref.Anchor, &ref.Note); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	titleByArticleID := map[int64]string{}
	if len(refs) > 0 {
		articleIDs := make([]int64, 0, len(refs))
		for _, ref := range refs {
			articleIDs = append(articleIDs, ref.ArticleID)
		}
		titleRows, err := dbPool().Query(ctx,
			`SELECT id, title FROM petrichor_kb_article WHERE id = ANY($1)`, articleIDs)
		if err != nil {
			return nil, err
		}
		defer titleRows.Close()
		for titleRows.Next() {
			var id int64
			var title string
			if err := titleRows.Scan(&id, &title); err != nil {
				return nil, err
			}
			titleByArticleID[id] = title
		}
		if err := titleRows.Err(); err != nil {
			return nil, err
		}
	}
	sourceArticles := make([]map[string]any, 0, len(refs))
	for _, ref := range refs {
		title, ok := titleByArticleID[ref.ArticleID]
		if !ok {
			continue
		}
		sourceArticles = append(sourceArticles, map[string]any{
			"articleId": idStr(ref.ArticleID),
			"title":     title,
			"href":      "/dashboard/knowledge/" + idStr(page.KnowledgeBaseID) + "/articles/" + idStr(ref.ArticleID),
			"note":      ref.Note,
		})
	}
	return sourceArticles, nil
}

// ===== wiki-qa-core 纯函数段 =====

var wikiTopicKinds = map[string]bool{
	"concept": true, "entity": true, "comparison": true, "answer": true,
}

func summarizeWikiContent(contentMd string, maxLength int) string {
	text := fenceContentRe.ReplaceAllString(contentMd, " ")
	text = mdSymbolRunRe.ReplaceAllString(text, "")
	text = spaceCollapseRe.ReplaceAllString(text, " ")
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) > maxLength {
		return string(runes[:maxLength]) + "…"
	}
	return text
}

func readFrontmatterAliases(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var parsed struct {
		Aliases []any `json:"aliases"`
	}
	if json.Unmarshal([]byte(*raw), &parsed) != nil || parsed.Aliases == nil {
		return []string{}
	}
	out := make([]string, 0, len(parsed.Aliases))
	for _, value := range parsed.Aliases {
		s := strings.TrimSpace(toFlatString(value))
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func toWikiQaCard(page *wikiPageRow) map[string]any {
	summary := ""
	if page.Summary != nil {
		summary = strings.TrimSpace(*page.Summary)
	}
	if summary == "" {
		summary = summarizeWikiContent(page.ContentMd, 160)
	}
	return map[string]any{
		"pageKey": page.PageKey,
		"title":   page.Title,
		"kind":    page.Kind,
		"summary": summary,
		"aliases": readFrontmatterAliases(page.FrontmatterJSON),
	}
}

// toWikiNeighbor 对照 wiki-qa-user.ts 的 toNeighbor。
func toWikiNeighbor(pageKey, linkType string, resolved *wikiPageRow) map[string]any {
	title := pageKey
	kindAny := any(nil)
	summaryAny := any(nil)
	if resolved != nil {
		title = resolved.Title
		kindAny = resolved.Kind
		trimmed := ""
		if resolved.Summary != nil {
			trimmed = strings.TrimSpace(*resolved.Summary)
		}
		if trimmed == "" {
			trimmed = summarizeWikiContent(resolved.ContentMd, 120)
		}
		summaryAny = trimmed
	}
	return map[string]any{
		"pageKey":  pageKey,
		"title":    title,
		"kind":     kindAny,
		"summary":  summaryAny,
		"linkType": linkType,
	}
}

func dedupeInt64Of(in []int64) []int64 { return dedupeInt64(in) }

var (
	fenceContentRe  = regexp.MustCompile("(?s)```[\\s\\S]*?```")
	mdSymbolRunRe   = regexp.MustCompile("[#>*_`~-]+")
	spaceCollapseRe = regexp.MustCompile("\\s+")
)
