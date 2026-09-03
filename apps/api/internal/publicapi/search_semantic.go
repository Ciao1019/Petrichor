package publicapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/cache"
)

const (
	publicSearchEmbeddingTTL = 10 * 60
	publicSemanticMinScore   = 0.15
)

func truncatePublicSearchQuery(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func publicSearchVectorLiteral(vector []float32) string {
	parts := make([]string, len(vector))
	for index, value := range vector {
		parts[index] = strconv.FormatFloat(float64(value), 'g', -1, 32)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func embedPublicSearchQuery(ctx context.Context, userID int64, query string) ([]float32, string, error) {
	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeEmbedding, nil)
	if err != nil {
		return nil, "", err
	}
	hash := sha256.Sum256([]byte(query))
	cacheKey := cache.CacheKey(
		"public-search", "embedding", formatInt(userID), resolved.ModelRef, hex.EncodeToString(hash[:12]),
	)
	vector, err := cache.ReadThrough(cacheKey, publicSearchEmbeddingTTL, func() ([]float32, error) {
		vectors, embeddingErr := aicore.Embeddings(
			ctx,
			resolved.Runtime,
			resolved.ModelRef,
			[]string{truncatePublicSearchQuery(query, 4000)},
		)
		if embeddingErr != nil {
			return nil, embeddingErr
		}
		if len(vectors) == 0 || len(vectors[0]) == 0 {
			return nil, fmt.Errorf("向量模型返回空向量")
		}
		return vectors[0], nil
	})
	if err != nil {
		return nil, "", err
	}
	return vector, resolved.ModelRef, nil
}

func articleIDsForPublicSearchUser(scope *publicSearchScope, userID int64) []int64 {
	ids := []int64{}
	for id, article := range scope.articles {
		if article.UserID == userID {
			ids = append(ids, id)
		}
	}
	return ids
}

func pageIDsForPublicSearchUser(scope *publicSearchScope, userID int64) []int64 {
	ids := []int64{}
	for id, page := range scope.pages {
		if page.userID == userID {
			ids = append(ids, id)
		}
	}
	return ids
}

func semanticPublicArticleSearch(
	ctx context.Context,
	scope *publicSearchScope,
	userID int64,
	articleIDs []int64,
	vector []float32,
	model string,
	candidateLimit int,
) ([]*publicSearchHit, error) {
	if len(articleIDs) == 0 {
		return []*publicSearchHit{}, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT i.article_id, a.title, COALESCE(a.public_excerpt, ''), COALESCE(a.ai_summary, ''),
		        c.content_md, a.updated_at,
		        (1 - (i.embedding <=> $2::vector))::float8 AS score
		 FROM petrichor_kb_article_chunk_index i
		 JOIN petrichor_kb_article_chunk c ON c.id = i.chunk_id AND c.user_id = i.user_id
		 JOIN petrichor_kb_article a ON a.id = i.article_id AND a.user_id = i.user_id
		 WHERE i.user_id = $1 AND i.article_id = ANY($3)
		   AND i.embedding_status = 'ready' AND i.embedding IS NOT NULL
		   AND i.embedding_model = $4 AND i.embedding_dimensions = $5
		   AND i.embedding_version = 1 AND i.source_type = 'chunk'
		 ORDER BY i.embedding <=> $2::vector
		 LIMIT $6`, userID, publicSearchVectorLiteral(vector), articleIDs, model, len(vector), candidateLimit*3)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bestByArticle := map[int64]*publicSearchHit{}
	for rows.Next() {
		var articleID int64
		var title, excerpt, summary, content string
		var updatedAt time.Time
		var score float64
		if err := rows.Scan(&articleID, &title, &excerpt, &summary, &content, &updatedAt, &score); err != nil {
			return nil, err
		}
		if score < publicSemanticMinScore || bestByArticle[articleID] != nil {
			continue
		}
		article := scope.articles[articleID]
		if article == nil {
			continue
		}
		preview := strings.TrimSpace(excerpt)
		if preview == "" {
			preview = strings.TrimSpace(summary)
		}
		bestByArticle[articleID] = &publicSearchHit{
			key:             searchHitKey("article", articleID),
			resultType:      "article",
			articleID:       articleID,
			knowledgeBaseID: article.KnowledgeBaseID,
			title:           title,
			summary:         preview,
			snippet:         summarizeWikiContent(content, 240),
			href:            "/p/" + article.ShareCode,
			updatedAt:       updatedAt,
			semanticScore:   score,
			matchReason:     "语义相关",
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	hits := make([]*publicSearchHit, 0, len(bestByArticle))
	for _, hit := range bestByArticle {
		hits = append(hits, hit)
	}
	sortSearchHits(hits, func(hit *publicSearchHit) float64 { return hit.semanticScore })
	if len(hits) > candidateLimit {
		hits = hits[:candidateLimit]
	}
	return hits, nil
}

func semanticPublicWikiSearch(
	ctx context.Context,
	scope *publicSearchScope,
	userID int64,
	pageIDs []int64,
	vector []float32,
	model string,
	candidateLimit int,
) ([]*publicSearchHit, error) {
	if len(pageIDs) == 0 {
		return []*publicSearchHit{}, nil
	}
	rows, err := pool().Query(ctx,
		`SELECT node.page_id, COALESCE(node.summary, ''), node.content_md,
		        (1 - (node.embedding <=> $2::vector))::float8 AS score
		 FROM petrichor_kb_wiki_tree_node node
		 WHERE node.user_id = $1 AND node.page_id = ANY($3)
		   AND node.embedding_status = 'ready' AND node.embedding IS NOT NULL
		   AND node.embedding_model = $4 AND node.embedding_dimensions = $5
		   AND node.embedding_version = 1
		 ORDER BY node.embedding <=> $2::vector
		 LIMIT $6`, userID, publicSearchVectorLiteral(vector), pageIDs, model, len(vector), candidateLimit*3)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bestByPage := map[int64]*publicSearchHit{}
	for rows.Next() {
		var pageID int64
		var nodeSummary, content string
		var score float64
		if err := rows.Scan(&pageID, &nodeSummary, &content, &score); err != nil {
			return nil, err
		}
		if score < publicSemanticMinScore || bestByPage[pageID] != nil {
			continue
		}
		page := scope.pages[pageID]
		if page == nil {
			continue
		}
		metadata := readPublicWikiMetadata(page.frontmatterJSON)
		summary := derefTrim(page.summary)
		if summary == "" {
			summary = strings.TrimSpace(nodeSummary)
		}
		bestByPage[pageID] = &publicSearchHit{
			key:             searchHitKey("wiki", pageID),
			resultType:      "wiki",
			wikiPageID:      pageID,
			knowledgeBaseID: page.knowledgeBaseID,
			pageKey:         page.pageKey,
			title:           page.title,
			summary:         summary,
			snippet:         summarizeWikiContent(content, 240),
			href:            publicWikiPageHref(page.knowledgeBaseID, page.pageKey),
			kind:            page.kind,
			categoryPath:    metadata.CategoryPath,
			updatedAt:       page.updatedAt,
			semanticScore:   score,
			matchReason:     "语义相关",
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	hits := make([]*publicSearchHit, 0, len(bestByPage))
	for _, hit := range bestByPage {
		hits = append(hits, hit)
	}
	sortSearchHits(hits, func(hit *publicSearchHit) float64 { return hit.semanticScore })
	if len(hits) > candidateLimit {
		hits = hits[:candidateLimit]
	}
	return hits, nil
}

func semanticPublicSearch(
	ctx context.Context,
	scope *publicSearchScope,
	keyword string,
	resultType string,
	candidateLimit int,
) ([]*publicSearchHit, bool, string, error) {
	if len(scope.byUser) == 0 {
		return []*publicSearchHit{}, true, "", nil
	}
	userIDs := make([]int64, 0, len(scope.byUser))
	for userID := range scope.byUser {
		userIDs = append(userIDs, userID)
	}
	sort.Slice(userIDs, func(i, j int) bool { return userIDs[i] < userIDs[j] })

	hits := []*publicSearchHit{}
	resolvedUsers := 0
	failedUsers := 0
	for _, userID := range userIDs {
		vector, model, err := embedPublicSearchQuery(ctx, userID, keyword)
		if err != nil || len(vector) == 0 {
			failedUsers++
			continue
		}
		resolvedUsers++
		if searchTypeEnabled(resultType, "article") {
			articleHits, queryErr := semanticPublicArticleSearch(
				ctx, scope, userID, articleIDsForPublicSearchUser(scope, userID), vector, model, candidateLimit,
			)
			if queryErr != nil {
				return nil, false, "", queryErr
			}
			hits = append(hits, articleHits...)
		}
		if searchTypeEnabled(resultType, "wiki") {
			wikiHits, queryErr := semanticPublicWikiSearch(
				ctx, scope, userID, pageIDsForPublicSearchUser(scope, userID), vector, model, candidateLimit,
			)
			if queryErr != nil {
				return nil, false, "", queryErr
			}
			hits = append(hits, wikiHits...)
		}
	}
	sortSearchHits(hits, func(hit *publicSearchHit) float64 { return hit.semanticScore })
	if len(hits) > candidateLimit {
		hits = hits[:candidateLimit]
	}
	if resolvedUsers == 0 {
		return hits, false, "语义模型尚未配置或暂时不可用", nil
	}
	if failedUsers > 0 {
		return hits, true, "部分知识空间暂时无法进行语义检索", nil
	}
	return hits, true, "", nil
}
