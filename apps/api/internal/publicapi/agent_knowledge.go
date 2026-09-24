// agent_knowledge.go 为助手 Runtime 的公开问答档位提供只读数据面。
//
// 所有入口都以「当前匿名可见的文章 + 安全 Wiki 页面」为边界：范围在每次工具调用时
// 实时加载，撤销分享后立即失效；函数不接受、也不使用任何登录身份。
package publicapi

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicscope"
	"petrichor/api/internal/sitecontent"
)

// PublicKnowledgeScope 一次工具调用可见的公开资料集合。
type PublicKnowledgeScope struct {
	search *publicSearchScope
}

// LoadPublicKnowledgeScope 加载公开范围；knowledgeBaseID > 0 时只保留该知识库的文章与 Wiki。
func LoadPublicKnowledgeScope(ctx context.Context, knowledgeBaseID int64) (*PublicKnowledgeScope, error) {
	scope, err := loadPublicSearchScope(ctx)
	if err != nil {
		return nil, err
	}
	if knowledgeBaseID > 0 {
		filterPublicSearchScope(scope, knowledgeBaseID, "")
	}
	return &PublicKnowledgeScope{search: scope}, nil
}

// PublicKnowledgeBase 含公开资料的知识库。
type PublicKnowledgeBase struct {
	ID            int64
	Name          string
	ArticleCount  int
	WikiPageCount int
}

// KnowledgeBases 列出范围内含公开文章或安全 Wiki 的知识库，按名称排序。
func (s *PublicKnowledgeScope) KnowledgeBases() []PublicKnowledgeBase {
	byID := map[int64]*PublicKnowledgeBase{}
	ensure := func(id int64) *PublicKnowledgeBase {
		if byID[id] == nil {
			byID[id] = &PublicKnowledgeBase{ID: id, Name: s.search.knowledgeBaseName[id]}
		}
		return byID[id]
	}
	for _, article := range s.search.articles {
		ensure(article.KnowledgeBaseID).ArticleCount++
	}
	for _, page := range s.search.pages {
		ensure(page.knowledgeBaseID).WikiPageCount++
	}
	out := make([]PublicKnowledgeBase, 0, len(byID))
	for _, base := range byID {
		out = append(out, *base)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name == out[j].Name {
			return out[i].ID < out[j].ID
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// KnowledgeBaseName 返回范围内知识库名称；不在范围内时为空。
func (s *PublicKnowledgeScope) KnowledgeBaseName(id int64) string {
	return s.search.knowledgeBaseName[id]
}

// Article 返回公开文章引用；不在范围内时为 nil。
func (s *PublicKnowledgeScope) Article(id int64) *PublicArticleRef {
	return s.search.articles[id]
}

// PublicKnowledgeHit 检索命中：文章或安全 Wiki 页面。
type PublicKnowledgeHit struct {
	Type              string
	ArticleID         int64
	KnowledgeBaseID   int64
	KnowledgeBaseName string
	PageKey           string
	Kind              string
	Title             string
	Summary           string
	Snippet           string
	Href              string
	Score             float64
}

// PublicRecallStats 各召回路命中数量。
type PublicRecallStats struct {
	Strategy       string
	LexicalArticle int
	LexicalWiki    int
	Semantic       int
}

// Search 融合全文与语义召回，与前台公开搜索同一套索引与 RRF；kind 为 all、article 或 wiki。
func (s *PublicKnowledgeScope) Search(ctx context.Context, query, kind string, limit int) ([]PublicKnowledgeHit, PublicRecallStats, error) {
	hits, strategy, stats, err := searchPublicQaInScope(ctx, s.search, query, kind, limit)
	if err != nil {
		return nil, PublicRecallStats{}, err
	}
	decoratePublicSearchHits(s.search, hits)
	out := make([]PublicKnowledgeHit, 0, len(hits))
	for _, hit := range hits {
		out = append(out, PublicKnowledgeHit{
			Type: hit.resultType, ArticleID: hit.articleID, KnowledgeBaseID: hit.knowledgeBaseID,
			KnowledgeBaseName: hit.knowledgeBaseName, PageKey: hit.pageKey, Kind: hit.kind,
			Title: hit.title, Summary: hit.summary, Snippet: hit.snippet, Href: hit.href,
			Score: hit.combinedScore,
		})
	}
	return out, PublicRecallStats{
		Strategy: strategy, LexicalArticle: stats.lexicalArticle,
		LexicalWiki: stats.lexicalWiki, Semantic: stats.semantic,
	}, nil
}

// PublicChunk 公开文章中的一个分片。
type PublicChunk struct {
	ChunkID         int64
	ArticleID       int64
	KnowledgeBaseID int64
	ArticleTitle    string
	Heading         string
	Path            []string
	Content         string
	Href            string
}

// BestChunks 在一篇公开文章内挑选与 query 最相关的分片；文章尚未分片时返回空。
func (s *PublicKnowledgeScope) BestChunks(ctx context.Context, articleID int64, query string, limit int) ([]PublicChunk, error) {
	ref, err := requirePublicQaArticle(s.search.articles, articleID)
	if err != nil {
		return nil, err
	}
	rows, err := pool().Query(ctx,
		`SELECT id, heading, heading_path_json, content_md
		 FROM petrichor_kb_article_chunk
		 WHERE article_id = $1 AND user_id = $2 AND knowledge_base_id = $3
		 ORDER BY (CASE WHEN content_md ILIKE $5 THEN 1 ELSE 0 END)
		          + word_similarity($4, heading) * 2 + word_similarity($4, content_md) DESC,
		          "position" ASC
		 LIMIT $6`,
		articleID, ref.UserID, ref.KnowledgeBaseID, query, "%"+escapeLikePattern(query)+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicChunk{}
	for rows.Next() {
		chunk, scanErr := scanPublicChunk(rows, ref)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, chunk)
	}
	return out, rows.Err()
}

// Chunk 读取公开文章的单个分片；分片所属文章不在范围内时视为不存在。
func (s *PublicKnowledgeScope) Chunk(ctx context.Context, chunkID int64) (*PublicChunk, error) {
	if chunkID <= 0 {
		return nil, badReq("chunkId 必须是正整数")
	}
	var articleID int64
	if err := pool().QueryRow(ctx,
		`SELECT article_id FROM petrichor_kb_article_chunk WHERE id = $1`, chunkID).Scan(&articleID); err != nil {
		return nil, notFoundErr("分片不存在或不在公开范围内")
	}
	ref := s.search.articles[articleID]
	if ref == nil {
		return nil, notFoundErr("分片不存在或不在公开范围内")
	}
	row := pool().QueryRow(ctx,
		`SELECT id, heading, heading_path_json, content_md
		 FROM petrichor_kb_article_chunk
		 WHERE id = $1 AND article_id = $2 AND user_id = $3 AND knowledge_base_id = $4`,
		chunkID, articleID, ref.UserID, ref.KnowledgeBaseID)
	chunk, err := scanPublicChunk(row, ref)
	if err != nil {
		return nil, notFoundErr("分片不存在或不在公开范围内")
	}
	return &chunk, nil
}

func scanPublicChunk(scanner interface{ Scan(dest ...any) error }, ref *PublicArticleRef) (PublicChunk, error) {
	chunk := PublicChunk{ArticleID: ref.ArticleID, KnowledgeBaseID: ref.KnowledgeBaseID,
		ArticleTitle: ref.Title, Href: "/p/" + ref.ShareCode}
	var pathJSON string
	if err := scanner.Scan(&chunk.ChunkID, &chunk.Heading, &pathJSON, &chunk.Content); err != nil {
		return PublicChunk{}, err
	}
	chunk.Path = parsePublicStringList(pathJSON)
	if len(chunk.Path) == 0 && chunk.Heading != "" {
		chunk.Path = []string{chunk.Heading}
	}
	return chunk, nil
}

// PublicOutlineNode 公开文章的章节目录项（来自分片标题）。
type PublicOutlineNode struct {
	ChunkID       int64
	Depth         int
	Title         string
	Path          string
	TokenEstimate int
	Questions     []string
}

// ArticleOutline 返回公开文章按顺序的章节目录。
func (s *PublicKnowledgeScope) ArticleOutline(ctx context.Context, articleID int64, maxNodes int) (*PublicArticleRef, []PublicOutlineNode, error) {
	ref, err := requirePublicQaArticle(s.search.articles, articleID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := pool().Query(ctx,
		`SELECT id, heading, heading_path_json, length(content_md), recommended_questions_json
		 FROM petrichor_kb_article_chunk
		 WHERE article_id = $1 AND user_id = $2 AND knowledge_base_id = $3
		 ORDER BY "position" ASC LIMIT $4`, articleID, ref.UserID, ref.KnowledgeBaseID, maxNodes)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	nodes := []PublicOutlineNode{}
	for rows.Next() {
		var node PublicOutlineNode
		var pathJSON, questionsJSON string
		var contentLength int
		if err := rows.Scan(&node.ChunkID, &node.Title, &pathJSON, &contentLength, &questionsJSON); err != nil {
			return nil, nil, err
		}
		path := parsePublicStringList(pathJSON)
		node.Depth = len(path)
		if node.Depth > 0 {
			node.Depth--
			node.Path = strings.Join(path, " > ")
		}
		node.TokenEstimate = contentLength / 3
		node.Questions = parsePublicStringList(questionsJSON)
		if len(node.Questions) > 3 {
			node.Questions = node.Questions[:3]
		}
		nodes = append(nodes, node)
	}
	return ref, nodes, rows.Err()
}

// ReadArticle 读取公开文章全文。
func (s *PublicKnowledgeScope) ReadArticle(ctx context.Context, articleID int64) (map[string]any, error) {
	return readPublicQaSourceArticle(ctx, s.search.articles, articleID)
}

// ReadTreeNode 读取公开文章目录树节点。
func (s *PublicKnowledgeScope) ReadTreeNode(ctx context.Context, nodeKey string, articleID int64) (map[string]any, error) {
	return readPublicQaTreeNode(ctx, s.search.articles, strings.TrimSpace(nodeKey), articleID)
}

// ReadWikiPage 读取安全 Wiki 页面；关联链接只保留公开可达页面。
func (s *PublicKnowledgeScope) ReadWikiPage(ctx context.Context, pageKey string, knowledgeBaseID int64) (map[string]any, error) {
	return readPublicQaWikiDetail(ctx, s.search.articles, strings.TrimSpace(pageKey), knowledgeBaseID)
}

// PublicWikiPageCard Wiki 概览中的页面。
type PublicWikiPageCard struct {
	KnowledgeBaseID int64
	PageKey         string
	Title           string
	Kind            string
	Summary         string
	Href            string
}

// WikiPages 范围内全部安全 Wiki 页面，按知识库、类型与标题排序。
func (s *PublicKnowledgeScope) WikiPages() []PublicWikiPageCard {
	out := make([]PublicWikiPageCard, 0, len(s.search.pages))
	for _, page := range s.search.pages {
		summary := ""
		if page.summary != nil {
			summary = strings.TrimSpace(*page.summary)
		}
		if summary == "" {
			summary = summarizeWikiContent(page.contentMd, 120)
		}
		out = append(out, PublicWikiPageCard{
			KnowledgeBaseID: page.knowledgeBaseID, PageKey: page.pageKey, Title: page.title,
			Kind: page.kind, Summary: summary, Href: publicWikiPageHref(page.knowledgeBaseID, page.pageKey),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].KnowledgeBaseID != out[j].KnowledgeBaseID {
			return out[i].KnowledgeBaseID < out[j].KnowledgeBaseID
		}
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Title < out[j].Title
	})
	return out
}

// PublicArticleHref 公开文章链接。
func PublicArticleHref(ref *PublicArticleRef) string {
	if ref == nil {
		return ""
	}
	return "/p/" + ref.ShareCode
}

// PublicWikiHref 公开 Wiki 页面链接。
func PublicWikiHref(knowledgeBaseID int64, pageKey string) string {
	return publicWikiPageHref(knowledgeBaseID, pageKey)
}

func parsePublicStringList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var values []string
	if json.Unmarshal([]byte(raw), &values) != nil {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// SiteOwnerUserID 站点所有者（首个超级管理员）；公开问答用其默认对话模型作答。
func SiteOwnerUserID(ctx context.Context) (int64, error) {
	return loadSiteOwnerUserID(ctx)
}

// FormatPublicID 与公开接口一致的字符串 ID。
func FormatPublicID(id int64) string { return strconv.FormatInt(id, 10) }

// QaScopes GET /api/public/qa/scopes：前台问答可选的提问范围（含公开文章或安全 Wiki 的知识库）。
func QaScopes(c *gin.Context) {
	ctx := c.Request.Context()
	if !sitecontent.IsPublicQaEnabled(ctx) {
		httpx.ErrorJSON(c, http.StatusForbidden, "站长已关闭前台问答功能")
		return
	}
	scope, err := LoadPublicKnowledgeScope(ctx, 0)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	items := []map[string]any{}
	for _, base := range scope.KnowledgeBases() {
		items = append(items, map[string]any{
			"knowledgeBaseId": FormatPublicID(base.ID), "name": base.Name,
			"articleCount": base.ArticleCount, "wikiPageCount": base.WikiPageCount,
		})
	}
	c.Header("Cache-Control", "public, max-age=60")
	httpx.OK(c, map[string]any{"items": items})
}

// ===== 公开范围内的读取（每次调用都以实时加载的公开文章集合为边界） =====

func requirePublicQaArticle(scope map[int64]*PublicArticleRef, articleID int64) (*PublicArticleRef, error) {
	if articleID <= 0 {
		return nil, badReq("articleId 必须是正整数")
	}
	ref := scope[articleID]
	if ref == nil {
		return nil, notFoundErr("该文章不在公开范围内")
	}
	return ref, nil
}

func readPublicQaTreeNode(ctx context.Context, scope map[int64]*PublicArticleRef, nodeKey string, requestedArticleID int64) (map[string]any, error) {
	if nodeKey == "" {
		return nil, badReq("nodeKey 不能为空")
	}
	article, err := requirePublicQaArticle(scope, requestedArticleID)
	if err != nil {
		return nil, err
	}
	safeIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, &article.KnowledgeBaseID)
	if err != nil {
		return nil, err
	}
	targets, err := loadPublicWikiTargets(ctx, safeIDs)
	if err != nil {
		return nil, err
	}
	rows, err := pool().Query(ctx,
		`SELECT user_id, knowledge_base_id, article_id, title, coalesce(summary, ''), content_md, depth
		 FROM petrichor_kb_wiki_tree_node
		 WHERE node_key = $1 AND page_id = ANY($2) AND article_id = $3 ORDER BY id ASC`, nodeKey, safeIDs, requestedArticleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var userID, kbID, articleID int64
		var title, summary, content string
		var depth int32
		if err := rows.Scan(&userID, &kbID, &articleID, &title, &summary, &content, &depth); err != nil {
			return nil, err
		}
		ref := scope[articleID]
		if ref == nil || ref.UserID != userID || ref.KnowledgeBaseID != kbID {
			continue
		}
		summary = sanitizePublicWikiReferences(summary, kbID, targets)
		content = sanitizePublicWikiReferences(content, kbID, targets)
		return map[string]any{
			"nodeKey": nodeKey, "articleId": strconv.FormatInt(articleID, 10), "title": title,
			"path": []string{ref.Title, title}, "summary": summary, "contentMd": content,
			"depth": depth, "href": "/p/" + ref.ShareCode,
		}, nil
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return nil, notFoundErr("目录节点不存在或不在公开范围内")
}

func readPublicQaWikiDetail(ctx context.Context, scope map[int64]*PublicArticleRef, pageKey string, kbID int64) (map[string]any, error) {
	if pageKey == "" {
		return nil, badReq("pageKey 不能为空")
	}
	if kbID <= 0 {
		return nil, badReq("knowledgeBaseId 必须是正整数")
	}
	safePageIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, &kbID)
	if err != nil {
		return nil, err
	}
	page, err := resolveAccessiblePage(ctx, safePageIDs, &kbID, pageKey)
	if err != nil {
		return nil, err
	}
	return readPublicWikiPageDetail(ctx, scope, publicscope.IDSet(safePageIDs), page)
}

func readPublicQaSourceArticle(ctx context.Context, scope map[int64]*PublicArticleRef, articleID int64) (map[string]any, error) {
	ref, err := requirePublicQaArticle(scope, articleID)
	if err != nil {
		return nil, err
	}
	var title, content string
	if err := pool().QueryRow(ctx,
		`SELECT title, content_md FROM petrichor_kb_article
		 WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3`,
		articleID, ref.UserID, ref.KnowledgeBaseID).Scan(&title, &content); err != nil {
		return nil, err
	}
	return map[string]any{
		"articleId": strconv.FormatInt(articleID, 10), "title": title, "contentMd": content,
		"shareCode": ref.ShareCode, "href": "/p/" + ref.ShareCode,
	}, nil
}
