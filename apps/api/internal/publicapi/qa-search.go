package publicapi

import (
	"context"
)

type qaSearchBackend struct {
	lexicalArticle func(context.Context, string, *publicSearchScope, int) ([]*publicSearchHit, error)
	lexicalWiki    func(context.Context, string, *publicSearchScope, int) ([]*publicSearchHit, error)
	semantic       func(context.Context, *publicSearchScope, string, string, int) ([]*publicSearchHit, bool, string, error)
}

// 与公开搜索共用分片全文、向量检索和 RRF；不能用站长身份查询私人助手索引。
var publicQaSearchBackend = qaSearchBackend{
	lexicalArticle: lexicalPublicQaArticles, lexicalWiki: lexicalPublicWikiSearch, semantic: semanticPublicSearch,
}

// publicQaRecallStats 记录各召回路的命中数量，供助手 Runtime 展示检索方式。
type publicQaRecallStats struct {
	lexicalArticle int
	lexicalWiki    int
	semantic       int
}

// searchPublicQaInScope 在调用方已裁剪的公开范围内检索（例如限定某个公开知识库）。
func searchPublicQaInScope(ctx context.Context, scope *publicSearchScope, query, kind string, limit int) ([]*publicSearchHit, string, publicQaRecallStats, error) {
	stats := publicQaRecallStats{}
	if len(scope.articles) == 0 && len(scope.pages) == 0 {
		return []*publicSearchHit{}, "fulltext", stats, nil
	}
	const candidates = 40
	lexical := []*publicSearchHit{}
	if searchTypeEnabled(kind, "article") && len(scope.articles) > 0 {
		hits, err := publicQaSearchBackend.lexicalArticle(ctx, query, scope, candidates)
		if err != nil {
			return nil, "", stats, err
		}
		stats.lexicalArticle = len(hits)
		lexical = append(lexical, hits...)
	}
	if searchTypeEnabled(kind, "wiki") && len(scope.pages) > 0 {
		hits, err := publicQaSearchBackend.lexicalWiki(ctx, query, scope, candidates)
		if err != nil {
			return nil, "", stats, err
		}
		stats.lexicalWiki = len(hits)
		lexical = append(lexical, hits...)
	}
	sortSearchHits(lexical, func(hit *publicSearchHit) float64 { return hit.lexicalScore })
	semanticCtx, cancel := context.WithTimeout(ctx, publicSemanticSearchTimeout)
	semantic, available, _, semanticErr := publicQaSearchBackend.semantic(semanticCtx, scope, query, kind, candidates)
	cancel()
	if ctx.Err() != nil {
		return nil, "", stats, ctx.Err()
	}
	strategy := "hybrid"
	if semanticErr != nil || !available {
		strategy = "fulltext"
		semantic = nil
	}
	stats.semantic = len(semantic)
	combined := combineSearchHits(strategy, lexical, semantic)
	targets := publicWikiTargets{}
	for _, page := range scope.pages {
		targets[publicWikiPageHref(page.knowledgeBaseID, page.pageKey)] = true
	}
	filtered := []*publicSearchHit{}
	for _, hit := range combined {
		if !searchTypeEnabled(kind, hit.resultType) {
			continue
		}
		if hit.resultType == "article" {
			article := scope.articles[hit.articleID]
			if article == nil {
				continue
			}
			hit.href = "/p/" + article.ShareCode
			hit.knowledgeBaseID = article.KnowledgeBaseID
		} else {
			page := scope.pages[hit.wikiPageID]
			if page == nil {
				continue
			}
			hit.href = publicWikiPageHref(page.knowledgeBaseID, page.pageKey)
			hit.knowledgeBaseID, hit.pageKey = page.knowledgeBaseID, page.pageKey
			hit.summary = sanitizePublicWikiReferences(hit.summary, page.knowledgeBaseID, targets)
			hit.snippet = sanitizePublicWikiReferences(hit.snippet, page.knowledgeBaseID, targets)
		}
		filtered = append(filtered, hit)
		if len(filtered) >= limit {
			break
		}
	}
	return filtered, strategy, stats, nil
}

// 新公开、尚未构建分片的文章也能按正文定位，避免升级后丢失旧入口的基本召回。
func lexicalPublicQaArticles(ctx context.Context, query string, scope *publicSearchScope, limit int) ([]*publicSearchHit, error) {
	hits, err := lexicalPublicArticleSearch(ctx, query, scope, limit)
	if err != nil || len(hits) >= limit {
		return hits, err
	}
	seen := map[int64]bool{}
	for _, hit := range hits {
		seen[hit.articleID] = true
	}
	ids := []int64{}
	for id := range scope.articles {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return hits, nil
	}
	rows, err := pool().Query(ctx, `SELECT a.id, a.title, a.content_md, a.updated_at
		FROM petrichor_kb_article a
		WHERE a.id = ANY($1) AND a.content_md ILIKE $2
		AND NOT EXISTS (SELECT 1 FROM petrichor_kb_article_chunk_index i
			WHERE i.article_id = a.id AND i.source_type = 'chunk')
		ORDER BY a.updated_at DESC, a.id DESC LIMIT $3`, ids, "%"+escapeLikePattern(query)+"%", limit-len(hits))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		hit := &publicSearchHit{resultType: "article", lexicalScore: 0.01, matchReason: "原文匹配（尚未构建索引）"}
		var content string
		if err := rows.Scan(&hit.articleID, &hit.title, &content, &hit.updatedAt); err != nil {
			return nil, err
		}
		hit.key = searchHitKey("article", hit.articleID)
		hit.snippet = extractWikiMatchSnippet(content, query, 100)
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}
