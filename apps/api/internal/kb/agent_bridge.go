// agent_bridge.go 为 internal/agentapi 暴露的薄桥接层：
// 复用包内既有的查询与组装逻辑，避免在 agentapi 里复制 SQL。
package kb

import "context"

// Querier 供外部包传入 *pgxpool.Pool 或 pgx.Tx。
type Querier = execQuerier

// ListWikiPagesForAgent 对应 wiki-agent-logic.ts listWikiPages：页面清单（不含 inLinks）。
func ListWikiPagesForAgent(q Querier, userID, knowledgeBaseID int64) ([]map[string]any, error) {
	if _, err := assertKnowledgeBaseOwner(q, userID, knowledgeBaseID); err != nil {
		return nil, err
	}
	pages, err := loadWikiPageRows(q, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	pageMaps := make([]map[string]any, 0, len(pages))
	for i := range pages {
		pageMaps = append(pageMaps, toWikiPageResponse(&pages[i]))
	}
	return pageMaps, nil
}

// RunWikiLintForAgent 对应 wiki-agent-logic.ts runWikiLint。
func RunWikiLintForAgent(q Querier, userID, knowledgeBaseID int64) (map[string]any, error) {
	if _, err := assertKnowledgeBaseOwner(q, userID, knowledgeBaseID); err != nil {
		return nil, err
	}
	pages, err := loadWikiPageRows(q, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	return buildWikiLint(q, userID, knowledgeBaseID, pages)
}

// LoadWikiPageDetailForAgent 对应 wiki-agent-logic.ts loadWikiPageDetail。
func LoadWikiPageDetailForAgent(q Querier, userID, knowledgeBaseID int64, pageKey string) (map[string]any, error) {
	return wikiPageDetailCore(q, userID, knowledgeBaseID, pageKey)
}

// DeleteArticleWikiPagesForAgent 导出 deleteArticleWikiPages，供文章删除时清理 Wiki 派生数据。
func DeleteArticleWikiPagesForAgent(q Querier, userID int64, articles []ArticleRow, rebuildIndex bool) (int, error) {
	return deleteArticleWikiPages(q, userID, articles, rebuildIndex)
}

// LoadTreeNodesForAgent 导出 loadTreeNodes（PageIndex 目录树节点，供推理检索 / 语义检索）。
func LoadTreeNodesForAgent(q Querier, userID, knowledgeBaseID int64, articleID *int64) ([]TreeNodeRow, error) {
	return loadTreeNodes(q, userID, knowledgeBaseID, articleID)
}

// AssertKnowledgeBaseOwnerForAgent 归属校验（404 语义与 TS 一致）。
func AssertKnowledgeBaseOwnerForAgent(q Querier, userID, knowledgeBaseID int64) (*KBRow, error) {
	return assertKnowledgeBaseOwner(q, userID, knowledgeBaseID)
}

// QueryOwnedArticleForAgent 对应 handlers.ts loadOwnedArticle：不存在返回 nil（由调用方决定 404 文案）。
func QueryOwnedArticleForAgent(q Querier, userID, articleID int64) (*ArticleRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
		articleID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanArticleRows(rows)
}

// InvalidatePublicArticleCaches 导出公开文章缓存失效（list 全量 + detail 指定 shareCode 或全前缀）。
func InvalidatePublicArticleCaches(shareCode string) {
	invalidatePublicArticleListCache()
	invalidatePublicArticleDetailCache(shareCode)
}

// PublicArticleMetadata 公开文章派生元数据（对照 share-logic.ts buildPublicArticleMetadata）。
type PublicArticleMetadata struct {
	PublicExcerpt     *string
	ReadingMinutes    int32
	TocJSON           *string
	PublicContentHash *string
}

// BuildPublicArticleMetadata 导出 buildPublicArticleMetadata。
func BuildPublicArticleMetadata(contentMd string) PublicArticleMetadata {
	excerpt, readingMinutes, tocJSON, contentHash := buildPublicArticleMetadata(contentMd)
	return PublicArticleMetadata{
		PublicExcerpt:     excerpt,
		ReadingMinutes:    readingMinutes,
		TocJSON:           tocJSON,
		PublicContentHash: contentHash,
	}
}
