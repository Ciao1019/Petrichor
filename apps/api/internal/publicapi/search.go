package publicapi

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicscope"
)

const (
	publicPortalSearchDefaultLimit  = int64(20)
	publicPortalSearchMaxLimit      = int64(50)
	publicSearchMaxOffset           = int64(1000)
	publicSearchCandidateCap        = 1200
	publicSemanticSearchHourlyLimit = 120
	publicSemanticSearchTimeout     = 8 * time.Second
)

type publicSearchHit struct {
	key               string
	resultType        string
	articleID         int64
	wikiPageID        int64
	knowledgeBaseID   int64
	pageKey           string
	title             string
	summary           string
	snippet           string
	href              string
	kind              string
	categoryPath      []string
	tags              []string
	knowledgeBaseName string
	sourceCount       int64
	updatedAt         time.Time
	lexicalScore      float64
	semanticScore     float64
	combinedScore     float64
	matchReason       string
}

type publicSearchScope struct {
	articles          map[int64]*PublicArticleRef
	pages             map[int64]*wikiPageRecord
	articleTags       map[int64][]string
	knowledgeBaseName map[int64]string
	pageSourceCount   map[int64]int64
	byUser            map[int64]struct{}
}

func loadPublicSearchScope(ctx context.Context) (*publicSearchScope, error) {
	articles, err := loadPublicArticleScope(ctx)
	if err != nil {
		return nil, err
	}
	safePageIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, nil)
	if err != nil {
		return nil, err
	}
	pages := map[int64]*wikiPageRecord{}
	if len(safePageIDs) > 0 {
		rows, queryErr := pool().Query(ctx,
			`SELECT `+wikiPageColumnsPublic+` FROM petrichor_kb_wiki_page
			 WHERE id = ANY($1) AND archived_at IS NULL`, safePageIDs)
		if queryErr != nil {
			return nil, queryErr
		}
		for rows.Next() {
			page, scanErr := scanWikiPage(rows)
			if scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			pages[page.id] = page
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	articleIDs := make([]int64, 0, len(articles))
	knowledgeBaseIDs := map[int64]struct{}{}
	byUser := map[int64]struct{}{}
	for articleID, article := range articles {
		articleIDs = append(articleIDs, articleID)
		knowledgeBaseIDs[article.KnowledgeBaseID] = struct{}{}
		byUser[article.UserID] = struct{}{}
	}
	pageIDs := make([]int64, 0, len(pages))
	for pageID, page := range pages {
		pageIDs = append(pageIDs, pageID)
		knowledgeBaseIDs[page.knowledgeBaseID] = struct{}{}
		byUser[page.userID] = struct{}{}
	}
	articleTags, err := loadTagsByArticleIDs(ctx, articleIDs)
	if err != nil {
		return nil, err
	}
	knowledgeBaseName := map[int64]string{}
	if len(knowledgeBaseIDs) > 0 {
		ids := make([]int64, 0, len(knowledgeBaseIDs))
		for id := range knowledgeBaseIDs {
			ids = append(ids, id)
		}
		rows, queryErr := pool().Query(ctx,
			`SELECT id, name FROM petrichor_kb_knowledge_base WHERE id = ANY($1)`, ids)
		if queryErr != nil {
			return nil, queryErr
		}
		for rows.Next() {
			var id int64
			var name string
			if scanErr := rows.Scan(&id, &name); scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			knowledgeBaseName[id] = name
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	pageSourceCount := map[int64]int64{}
	if len(pageIDs) > 0 {
		rows, queryErr := pool().Query(ctx,
			`SELECT page_id, count(*)::bigint FROM petrichor_kb_wiki_source_ref
			 WHERE page_id = ANY($1) GROUP BY page_id`, pageIDs)
		if queryErr != nil {
			return nil, queryErr
		}
		for rows.Next() {
			var pageID, count int64
			if scanErr := rows.Scan(&pageID, &count); scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			pageSourceCount[pageID] = count
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return &publicSearchScope{
		articles: articles, pages: pages, articleTags: articleTags,
		knowledgeBaseName: knowledgeBaseName, pageSourceCount: pageSourceCount, byUser: byUser,
	}, nil
}

func searchTypeEnabled(filter, resultType string) bool {
	return filter == "all" || filter == resultType
}

func consumePublicSemanticSearchQuota(ctx context.Context, ip string) error {
	if strings.TrimSpace(ip) == "" {
		return nil
	}
	now := timeNow()
	count, err := bumpBucket(ctx, "public-search-ip:"+ip+":"+hourBucket(now), now)
	if err != nil {
		return err
	}
	if count > publicSemanticSearchHourlyLimit {
		return httpx.TooManyRequests("本小时语义检索次数已达上限，请稍后再试")
	}
	return nil
}

func searchHitKey(resultType string, id int64) string {
	return resultType + ":" + formatInt(id)
}

var publicSearchTermPattern = regexp.MustCompile(`[\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}]+|[\p{L}\p{N}]+`)

func publicSearchTokenText(value string) string {
	tokens := []string{}
	for _, part := range publicSearchTermPattern.FindAllString(strings.ToLower(value), -1) {
		runes := []rune(part)
		isCJK := len(runes) > 0 && ((runes[0] >= 0x3400 && runes[0] <= 0x4dbf) ||
			(runes[0] >= 0x4e00 && runes[0] <= 0x9fff) || (runes[0] >= 0xf900 && runes[0] <= 0xfaff))
		if !isCJK {
			if len(runes) >= 2 {
				tokens = append(tokens, part)
			}
			continue
		}
		if len(runes) == 1 {
			tokens = append(tokens, part)
			continue
		}
		for index := 0; index+2 <= len(runes); index++ {
			tokens = append(tokens, string(runes[index:index+2]))
		}
	}
	return strings.Join(tokens, " ")
}

func filterPublicSearchScope(scope *publicSearchScope, knowledgeBaseID int64, tag string) {
	for id, article := range scope.articles {
		if knowledgeBaseID > 0 && article.KnowledgeBaseID != knowledgeBaseID {
			delete(scope.articles, id)
			continue
		}
		if tag != "" {
			matched := false
			for _, candidate := range scope.articleTags[id] {
				if strings.EqualFold(strings.TrimSpace(candidate), tag) {
					matched = true
					break
				}
			}
			if !matched {
				delete(scope.articles, id)
			}
		}
	}
	for id, page := range scope.pages {
		if knowledgeBaseID > 0 && page.knowledgeBaseID != knowledgeBaseID {
			delete(scope.pages, id)
		}
		if tag != "" {
			delete(scope.pages, id)
		}
	}
	scope.byUser = map[int64]struct{}{}
	for _, article := range scope.articles {
		scope.byUser[article.UserID] = struct{}{}
	}
	for _, page := range scope.pages {
		scope.byUser[page.userID] = struct{}{}
	}
}

func lexicalPublicArticleSearch(
	ctx context.Context,
	keyword string,
	scope *publicSearchScope,
	candidateLimit int,
) ([]*publicSearchHit, error) {
	articleIDs := make([]int64, 0, len(scope.articles))
	for articleID := range scope.articles {
		articleIDs = append(articleIDs, articleID)
	}
	if len(articleIDs) == 0 {
		return []*publicSearchHit{}, nil
	}
	pattern := "%" + escapeLikePattern(keyword) + "%"
	rows, err := pool().Query(ctx,
		`WITH search_query AS (
		   SELECT websearch_to_tsquery('simple', $2) AS query
		 ), ranked_chunk AS (
		   SELECT DISTINCT ON (i.article_id)
		          i.article_id, i.content,
		          ts_rank_cd(i.search_vector, search_query.query, 32)::float8 AS rank
		   FROM petrichor_kb_article_chunk_index i, search_query
		   WHERE i.article_id = ANY($1) AND i.source_type = 'chunk'
		     AND i.search_vector @@ search_query.query
		   ORDER BY i.article_id, rank DESC, i.source_position ASC
		 )
		 SELECT a.id, a.title, COALESCE(a.public_excerpt, ''), COALESCE(a.ai_summary, ''),
		        COALESCE(ranked_chunk.content, ''), a.updated_at,
		        (COALESCE(ranked_chunk.rank, 0) * 6
		          + similarity(a.title, $4) * 4
		          + similarity(COALESCE(a.public_excerpt, ''), $4) * 2
		          + similarity(COALESCE(a.ai_summary, ''), $4) * 2)::float8 AS score
		 FROM petrichor_kb_article a
		 LEFT JOIN ranked_chunk ON ranked_chunk.article_id = a.id
		 WHERE a.id = ANY($1)
		   AND (ranked_chunk.article_id IS NOT NULL
		     OR a.title ILIKE $3
		     OR COALESCE(a.public_excerpt, '') ILIKE $3
		     OR COALESCE(a.ai_summary, '') ILIKE $3
		     OR EXISTS (
		       SELECT 1 FROM petrichor_kb_article_tag tag
		       WHERE tag.article_id = a.id AND tag.tag ILIKE $3
		     ))
		 ORDER BY score DESC, a.updated_at DESC, a.id DESC
		 LIMIT $5`, articleIDs, publicSearchTokenText(keyword), pattern, keyword, candidateLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []*publicSearchHit{}
	for rows.Next() {
		var articleID int64
		var title, excerpt, summary, matchedContent string
		var updatedAt time.Time
		var score float64
		if err := rows.Scan(&articleID, &title, &excerpt, &summary, &matchedContent, &updatedAt, &score); err != nil {
			return nil, err
		}
		article := scope.articles[articleID]
		if article == nil {
			continue
		}
		preview := strings.TrimSpace(excerpt)
		if preview == "" {
			preview = strings.TrimSpace(summary)
		}
		snippet := extractWikiMatchSnippet(matchedContent, keyword, 100)
		if snippet == "" {
			snippet = summarizeWikiContent(firstNonEmpty(matchedContent, preview, title), 240)
		}
		hits = append(hits, &publicSearchHit{
			key:             searchHitKey("article", articleID),
			resultType:      "article",
			articleID:       articleID,
			knowledgeBaseID: article.KnowledgeBaseID,
			title:           title,
			summary:         preview,
			snippet:         snippet,
			href:            "/p/" + article.ShareCode,
			updatedAt:       updatedAt,
			lexicalScore:    score,
			matchReason:     "全文匹配",
		})
	}
	return hits, rows.Err()
}

func lexicalPublicWikiSearch(
	ctx context.Context,
	keyword string,
	scope *publicSearchScope,
	candidateLimit int,
) ([]*publicSearchHit, error) {
	if len(scope.pages) == 0 {
		return []*publicSearchHit{}, nil
	}
	pageIDs := make([]int64, 0, len(scope.pages))
	for id := range scope.pages {
		pageIDs = append(pageIDs, id)
	}
	pattern := "%" + escapeLikePattern(keyword) + "%"
	rows, err := pool().Query(ctx,
		`WITH search_query AS (
		   SELECT websearch_to_tsquery('simple', $2) AS query
		 ), ranked_node AS (
		   SELECT DISTINCT ON (node.page_id)
		          node.page_id, node.content_md,
		          ts_rank_cd(node.search_vector, search_query.query, 32)::float8 AS rank
		   FROM petrichor_kb_wiki_tree_node node, search_query
		   WHERE node.page_id = ANY($1) AND node.search_vector @@ search_query.query
		   ORDER BY node.page_id, rank DESC, node.depth ASC, node.position ASC
		 )
		 SELECT p.id, p.knowledge_base_id, p.page_key, p.title, p.kind,
		        COALESCE(p.summary, ''), COALESCE(ranked_node.content_md, ''),
		        p.frontmatter_json, p.updated_at,
		        (COALESCE(ranked_node.rank, 0) * 6
		          + similarity(p.title, $4) * 4
		          + similarity(COALESCE(p.summary, ''), $4) * 2)::float8 AS score
		 FROM petrichor_kb_wiki_page p
		 LEFT JOIN ranked_node ON ranked_node.page_id = p.id
		 WHERE p.id = ANY($1)
		   AND (ranked_node.page_id IS NOT NULL OR p.title ILIKE $3 OR COALESCE(p.summary, '') ILIKE $3)
		 ORDER BY score DESC, p.updated_at DESC, p.id DESC
		 LIMIT $5`, pageIDs, publicSearchTokenText(keyword), pattern, keyword, candidateLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []*publicSearchHit{}
	for rows.Next() {
		var pageID, knowledgeBaseID int64
		var pageKey, title, kind, summary, matchedContent string
		var frontmatter *string
		var updatedAt time.Time
		var score float64
		if err := rows.Scan(&pageID, &knowledgeBaseID, &pageKey, &title, &kind,
			&summary, &matchedContent, &frontmatter, &updatedAt, &score); err != nil {
			return nil, err
		}
		metadata := readPublicWikiMetadata(frontmatter)
		snippet := extractWikiMatchSnippet(matchedContent, keyword, 100)
		if snippet == "" {
			snippet = summarizeWikiContent(firstNonEmpty(matchedContent, summary, title), 240)
		}
		hits = append(hits, &publicSearchHit{
			key:             searchHitKey("wiki", pageID),
			resultType:      "wiki",
			wikiPageID:      pageID,
			knowledgeBaseID: knowledgeBaseID,
			pageKey:         pageKey,
			title:           title,
			summary:         strings.TrimSpace(summary),
			snippet:         snippet,
			href:            publicWikiPageHref(knowledgeBaseID, pageKey),
			kind:            kind,
			categoryPath:    metadata.CategoryPath,
			updatedAt:       updatedAt,
			lexicalScore:    score,
			matchReason:     "全文匹配",
		})
	}
	return hits, rows.Err()
}

func sortSearchHits(hits []*publicSearchHit, scoreOf func(*publicSearchHit) float64) {
	sort.SliceStable(hits, func(i, j int) bool {
		left, right := scoreOf(hits[i]), scoreOf(hits[j])
		if left != right {
			return left > right
		}
		return hits[i].updatedAt.After(hits[j].updatedAt)
	})
}

func combineSearchHits(mode string, lexical, semantic []*publicSearchHit) []*publicSearchHit {
	if mode == "fulltext" {
		sortSearchHits(lexical, func(hit *publicSearchHit) float64 { return hit.lexicalScore })
		for index, hit := range lexical {
			hit.combinedScore = 1 / float64(index+1)
		}
		return lexical
	}
	if mode == "semantic" {
		sortSearchHits(semantic, func(hit *publicSearchHit) float64 { return hit.semanticScore })
		for index, hit := range semantic {
			hit.combinedScore = 1 / float64(index+1)
		}
		return semantic
	}

	byKey := map[string]*publicSearchHit{}
	for index, hit := range lexical {
		current := *hit
		current.combinedScore = 0.45 / float64(60+index+1)
		byKey[hit.key] = &current
	}
	for index, hit := range semantic {
		semanticRRF := 0.55 / float64(60+index+1)
		if current := byKey[hit.key]; current != nil {
			current.combinedScore += semanticRRF
			current.semanticScore = hit.semanticScore
			current.matchReason = "全文与语义共同匹配"
			if current.snippet == "" {
				current.snippet = hit.snippet
			}
			continue
		}
		current := *hit
		current.combinedScore = semanticRRF
		byKey[hit.key] = &current
	}
	combined := make([]*publicSearchHit, 0, len(byKey))
	for _, hit := range byKey {
		combined = append(combined, hit)
	}
	sortSearchHits(combined, func(hit *publicSearchHit) float64 { return hit.combinedScore })
	return combined
}

func optionalPositiveID(id int64) any {
	if id <= 0 {
		return nil
	}
	return formatInt(id)
}

func optionalString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func decoratePublicSearchHits(scope *publicSearchScope, hits ...[]*publicSearchHit) {
	for _, group := range hits {
		for _, hit := range group {
			hit.knowledgeBaseName = scope.knowledgeBaseName[hit.knowledgeBaseID]
			if hit.resultType == "article" {
				hit.tags = tagsFor(scope.articleTags, hit.articleID)
			} else {
				hit.sourceCount = scope.pageSourceCount[hit.wikiPageID]
			}
		}
	}
}

func publicSearchResult(hit *publicSearchHit) map[string]any {
	result := map[string]any{
		"id":                hit.key,
		"type":              hit.resultType,
		"title":             hit.title,
		"summary":           hit.summary,
		"snippet":           hit.snippet,
		"href":              hit.href,
		"updatedAt":         httpx.FormatISO(hit.updatedAt),
		"score":             hit.combinedScore,
		"semanticScore":     hit.semanticScore,
		"matchReason":       hit.matchReason,
		"knowledgeBaseId":   nil,
		"pageKey":           nil,
		"kind":              nil,
		"categoryPath":      []string{},
		"tags":              append([]string{}, hit.tags...),
		"knowledgeBaseName": nil,
		"sourceCount":       nil,
	}
	if hit.resultType == "article" {
		result["articleId"] = formatInt(hit.articleID)
		result["knowledgeBaseId"] = formatInt(hit.knowledgeBaseID)
		result["knowledgeBaseName"] = hit.knowledgeBaseName
	} else {
		result["knowledgeBaseId"] = formatInt(hit.knowledgeBaseID)
		result["knowledgeBaseName"] = hit.knowledgeBaseName
		result["pageKey"] = hit.pageKey
		result["kind"] = hit.kind
		result["categoryPath"] = hit.categoryPath
		result["sourceCount"] = hit.sourceCount
	}
	return result
}

// Search GET /api/public/search：统一查询公开文章与安全 Wiki 页面。
func Search(c *gin.Context) {
	startedAt := time.Now()
	keyword := strings.TrimSpace(firstNonEmpty(c.Query("q"), c.Query("keyword")))
	if keyword == "" {
		httpx.HandleError(c, badReq("请输入搜索关键字"))
		return
	}
	if runeLen(keyword) > publicSearchMaxKeywordLength {
		httpx.HandleError(c, badReq("关键字长度不能超过 100"))
		return
	}
	modeRequested := strings.ToLower(strings.TrimSpace(c.DefaultQuery("mode", "hybrid")))
	mode := modeRequested
	if mode == "lexical" {
		mode = "fulltext"
	}
	if mode != "fulltext" && mode != "semantic" && mode != "hybrid" {
		httpx.HandleError(c, badReq("mode 必须是 fulltext、lexical、semantic 或 hybrid"))
		return
	}
	resultType := strings.ToLower(strings.TrimSpace(c.DefaultQuery("type", "all")))
	if resultType != "all" && resultType != "article" && resultType != "wiki" {
		httpx.HandleError(c, badReq("type 必须是 all、article 或 wiki"))
		return
	}
	limit := parseBoundedNumber(c.Query("limit"), publicPortalSearchDefaultLimit, 1, publicPortalSearchMaxLimit)
	offset := parseBoundedNumber(c.Query("offset"), 0, 0, publicSearchMaxOffset)
	candidateLimit := int(offset + limit + 200)
	if candidateLimit < 300 {
		candidateLimit = 300
	}
	if candidateLimit > publicSearchCandidateCap {
		candidateLimit = publicSearchCandidateCap
	}
	knowledgeBaseID := int64(0)
	if rawID := strings.TrimSpace(firstNonEmpty(c.Query("kb"), c.Query("knowledgeBaseId"))); rawID != "" {
		parsedID, parseErr := parseInt64(rawID)
		if parseErr != nil || parsedID <= 0 {
			httpx.HandleError(c, badReq("kb 必须是正整数"))
			return
		}
		knowledgeBaseID = parsedID
	}
	tag := strings.TrimSpace(c.Query("tag"))
	if runeLen(tag) > 50 {
		httpx.HandleError(c, badReq("tag 长度不能超过 50"))
		return
	}

	ctx := c.Request.Context()
	scope, err := loadPublicSearchScope(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	filterPublicSearchScope(scope, knowledgeBaseID, tag)
	lexical := []*publicSearchHit{}
	if mode != "semantic" {
		if searchTypeEnabled(resultType, "article") {
			hits, err := lexicalPublicArticleSearch(ctx, keyword, scope, candidateLimit)
			if err != nil {
				httpx.HandleError(c, err)
				return
			}
			lexical = append(lexical, hits...)
		}
		if searchTypeEnabled(resultType, "wiki") {
			hits, err := lexicalPublicWikiSearch(ctx, keyword, scope, candidateLimit)
			if err != nil {
				httpx.HandleError(c, err)
				return
			}
			lexical = append(lexical, hits...)
		}
		sortSearchHits(lexical, func(hit *publicSearchHit) float64 { return hit.lexicalScore })
	}

	semantic := []*publicSearchHit{}
	semanticAvailable := true
	semanticMessage := ""
	if mode != "fulltext" {
		if err := consumePublicSemanticSearchQuota(ctx, ResolveClientIp(c)); err != nil {
			httpx.HandleError(c, err)
			return
		}
		semanticCtx, cancelSemantic := context.WithTimeout(ctx, publicSemanticSearchTimeout)
		semantic, semanticAvailable, semanticMessage, err = semanticPublicSearch(
			semanticCtx, scope, keyword, resultType, candidateLimit,
		)
		cancelSemantic()
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
	}
	if mode == "semantic" && !semanticAvailable {
		semantic = []*publicSearchHit{}
	}
	decoratePublicSearchHits(scope, lexical, semantic)
	modeApplied := mode
	if mode == "hybrid" && !semanticAvailable {
		modeApplied = "fulltext"
	}
	combined := combineSearchHits(modeApplied, lexical, semantic)
	total := int64(len(combined))
	start := offset
	if start > total {
		start = total
	}
	end := start + limit
	if end > total {
		end = total
	}
	items := make([]map[string]any, 0, end-start)
	for _, hit := range combined[start:end] {
		items = append(items, publicSearchResult(hit))
	}

	var semanticMessageValue any
	if semanticMessage != "" {
		semanticMessageValue = semanticMessage
	}
	c.Header("Cache-Control", "public, max-age=15, s-maxage=30, stale-while-revalidate=60")
	httpx.OK(c, map[string]any{
		"query":             keyword,
		"mode":              mode,
		"modeRequested":     modeRequested,
		"modeApplied":       modeApplied,
		"type":              resultType,
		"knowledgeBaseId":   optionalPositiveID(knowledgeBaseID),
		"tag":               optionalString(tag),
		"items":             items,
		"total":             total,
		"limit":             limit,
		"offset":            offset,
		"hasMore":           end < total,
		"semanticAvailable": semanticAvailable,
		"semanticMessage":   semanticMessageValue,
		"tookMs":            time.Since(startedAt).Milliseconds(),
	})
}
