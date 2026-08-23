// article.go 对照 handlers.ts 的文章 CRUD + search + public-cache/refresh。
package kb

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
)

// buildPublicArticleMetadata 对应 share-logic.ts 同名函数（保存文章时派生的公开元数据）。
func buildPublicArticleMetadata(contentMd string) (publicExcerpt *string, readingMinutes int32, tocJSON *string, publicContentHash *string) {
	excerpt := buildHomepageArticleExcerpt(contentMd, 120)
	hash := md5Hex(contentMd)
	toc := marshalJSON(buildToc(contentMd))
	return &excerpt, estimateReadingMinutes(contentMd), toc, &hash
}

var (
	tocSlugSpace = regexp.MustCompile(`\s+`)
	// slug 保留字母（含 CJK 等非 ASCII 字母）、数字、空格、- 和 _，其余剔除。
	tocSlugKeep = func(r rune) bool {
		return unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-' || r == '_'
	}
	inlineMdCleanup = regexp.MustCompile("[*_~`\\[\\]]")
)

// slugger 复刻 github-slugger 的去重行为：重复标题追加 -1、-2 …
type slugger struct {
	seen map[string]int
}

func newSlugger() *slugger { return &slugger{seen: map[string]int{}} }

func (s *slugger) slug(text string) string {
	lowered := strings.ToLower(trimSpace(text))
	var b strings.Builder
	for _, r := range lowered {
		if !tocSlugKeep(r) {
			continue
		}
		b.WriteRune(r)
	}
	base := tocSlugSpace.ReplaceAllString(strings.Trim(b.String(), " "), "-")
	if base == "" {
		base = "heading"
	}
	if count, ok := s.seen[base]; ok {
		s.seen[base] = count + 1
		return base + "-" + strconv.Itoa(count)
	}
	s.seen[base] = 0
	return base
}

// normalizeHeadingText 对应 markdown-toc.ts。
func normalizeHeadingText(text string) string {
	return trimSpace(spaceRe.ReplaceAllString(text, " "))
}

type tocItem struct {
	ID    string `json:"id"`
	Level int32  `json:"level"`
	Text  string `json:"text"`
}

// buildToc 简化版 Markdown TOC：按行扫描标题（围栏感知），slug 去重与 TS 版对齐。
// 偏差：TS 用 marked 词法器，行内标记清理更彻底；本实现做基础行内符号清理。
func buildToc(markdown string) []tocItem {
	if markdown == "" {
		return []tocItem{}
	}
	out := []tocItem{}
	sg := newSlugger()
	for _, heading := range extractHeadings(markdown) {
		text := normalizeHeadingText(inlineMdCleanup.ReplaceAllString(heading[1], ""))
		if text == "" {
			continue
		}
		level := int32(len(heading[0]))
		out = append(out, tocItem{ID: sg.slug(text), Level: level, Text: text})
	}
	return out
}

// ===== 输入解析 =====

func parseTitleField(raw map[string]any, maxRunes int) (string, error) {
	title := trimmedString(raw, "title")
	if title == "" || len([]rune(title)) > maxRunes {
		return "", badReq("标题必须在 1 到 200 个字符之间")
	}
	return title, nil
}

func parseTagsField(raw map[string]any) ([]string, error) {
	list, _ := raw["tags"].([]any)
	if list == nil {
		return []string{}, nil
	}
	return normalizeTags(list)
}

func nullableString(raw map[string]any, key string) *string {
	v, ok := raw[key]
	if !ok || v == nil {
		return nil
	}
	s := toStr(v)
	if s == "" {
		return nil
	}
	return &s
}

// ===== 端点 =====

// CreateArticle 新建文章节点 + 文章记录 + 标签。
func CreateArticle(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		title, err := parseTitleField(raw, 200)
		if err != nil {
			return nil, err
		}
		contentMd, _ := raw["contentMd"].(string)
		parentID := parseOptionalID(raw, "parentId")
		tags, err := parseTagsField(raw)
		if err != nil {
			return nil, err
		}

		q := pool()
		ctx := c
		tx, err := q.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(context.Background())

		if _, err := assertKnowledgeBaseOwner(tx, user.ID, kbID); err != nil {
			return nil, err
		}
		if _, err := assertFolderParent(tx, user.ID, kbID, parentID); err != nil {
			return nil, err
		}
		sortOrder, err := nextSortOrder(tx, user.ID, kbID, parentID)
		if err != nil {
			return nil, err
		}
		var nodeID int64
		if err := tx.QueryRow(ctx,
			`INSERT INTO petrichor_kb_node (user_id, knowledge_base_id, parent_id, type, name, sort_order)
			 VALUES ($1, $2, $3, 'ARTICLE', $4, $5) RETURNING id`,
			user.ID, kbID, parentID, title, sortOrder).Scan(&nodeID); err != nil {
			return nil, err
		}
		publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicArticleMetadata(contentMd)
		contentJson := nullableString(raw, "contentJson")
		contentMetaJson := nullableString(raw, "contentMetaJson")
		var articleID int64
		if err := tx.QueryRow(ctx,
			`INSERT INTO petrichor_kb_article (user_id, knowledge_base_id, node_id, title,
			 content_md, content_json, content_meta_json, public_excerpt, reading_minutes,
			 toc_json, public_content_hash)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
			user.ID, kbID, nodeID, title, contentMd, contentJson, contentMetaJson,
			publicExcerpt, readingMinutes, tocJSON, contentHash).Scan(&articleID); err != nil {
			return nil, err
		}
		if err := replaceArticleTags(tx, articleID, tags); err != nil {
			return nil, err
		}
		if err := tx.Commit(context.Background()); err != nil {
			return nil, err
		}
		return map[string]any{
			"articleId": strconv.FormatInt(articleID, 10),
			"nodeId":    strconv.FormatInt(nodeID, 10),
		}, nil
	})
}

// DetailArticle 文章详情（含 AI 摘要新鲜度判定与路径）。
func DetailArticle(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
			articleID, user.ID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}
		node, err := assertNodeOwner(q, user.ID, article.NodeID)
		if err != nil {
			return nil, err
		}
		graph, err := loadKnowledgeBaseGraph(q, user.ID, article.KnowledgeBaseID)
		if err != nil {
			return nil, err
		}
		idx := indexGraph(graph)
		tags, err := loadTags(q, article.ID)
		if err != nil {
			return nil, err
		}
		currentHash := md5Hex(article.ContentMd)
		aiSummaryStale := derefStr(article.AiSummary) != "" &&
			resolveUsableAiSummary(article.AiSummary, article.AiSummaryContentHash, &currentHash) == ""

		return map[string]any{
			"articleId":            strconv.FormatInt(article.ID, 10),
			"nodeId":               strconv.FormatInt(article.NodeID, 10),
			"knowledgeBaseId":      strconv.FormatInt(article.KnowledgeBaseID, 10),
			"parentId":             nullableIDString(node.ParentID),
			"title":                article.Title,
			"contentMd":            article.ContentMd,
			"contentJson":          article.ContentJson,
			"contentMetaJson":      article.ContentMetaJson,
			"aiSummary":            displaySummary(article.AiSummary),
			"aiSummaryGeneratedAt": isoPtr(article.AiSummaryGeneratedAt),
			"aiSummaryStale":       aiSummaryStale,
			"tags":                 tags,
			"path":                 buildPath(idx.nodeByID, node.ID),
			"permission":           "OWNER",
			"readOnly":             false,
			"createdAt":            iso(article.CreatedAt),
			"updatedAt":            iso(article.UpdatedAt),
		}, nil
	})
}

func displaySummary(s *string) any {
	trimmed := derefStr(s)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

// resolveUsableAiSummary 对应 article-summary-logic.ts 的 resolveUsableArticleAiSummary。
func resolveUsableAiSummary(summary, summaryHash, currentHash *string) string {
	trimmed := derefStr(summary)
	if trimmed == "" {
		return ""
	}
	stored := derefStr(summaryHash)
	cur := derefStr(currentHash)
	if stored == "" || cur == "" || stored != cur {
		return ""
	}
	return trimmed
}

func queryArticle(q execQuerier, sql string, args ...any) (*ArticleRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanArticleRows(rows)
}

// UpdateArticle 更新正文/标题/标签并刷新公开元数据；同步目录树节点名。
func UpdateArticle(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		title, err := parseTitleField(raw, 200)
		if err != nil {
			return nil, err
		}
		contentMd, _ := raw["contentMd"].(string)
		tags, err := parseTagsField(raw)
		if err != nil {
			return nil, err
		}
		q := pool()
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
			articleID, user.ID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}

		publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicArticleMetadata(contentMd)
		contentJson := nullableString(raw, "contentJson")
		contentMetaJson := nullableString(raw, "contentMetaJson")
		ctx := c
		if _, err := q.Exec(ctx,
			`UPDATE petrichor_kb_article SET title = $1, content_md = $2, content_json = $3,
			 content_meta_json = $4, public_excerpt = $5, reading_minutes = $6, toc_json = $7,
			 public_content_hash = $8, updated_at = now()
			 WHERE id = $9 AND user_id = $10`,
			title, contentMd, contentJson, contentMetaJson, publicExcerpt, readingMinutes,
			tocJSON, contentHash, articleID, user.ID); err != nil {
			return nil, err
		}
		if _, err := q.Exec(ctx,
			`UPDATE petrichor_kb_node SET name = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
			title, article.NodeID, user.ID); err != nil {
			return nil, err
		}
		if err := replaceArticleTags(q, article.ID, tags); err != nil {
			return nil, err
		}
		// TS 版此处会异步清理被移除的图片对象；Go 对象存储删除设施未迁移，暂不执行。

		invalidatePublicArticleListCache()
		invalidatePublicArticleDetailCache("")
		return map[string]any{
			"articleId": strconv.FormatInt(article.ID, 10),
			"nodeId":    strconv.FormatInt(article.NodeID, 10),
		}, nil
	})
}

// RefreshArticlePublicCache 校验归属后失效公开缓存。
func RefreshArticlePublicCache(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
			articleID, user.ID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}
		invalidatePublicArticleListCache()
		invalidatePublicArticleDetailCache("")
		return map[string]any{
			"articleId":   strconv.FormatInt(article.ID, 10),
			"refreshedAt": iso(time.Now()),
		}, nil
	})
}

// DeleteArticle 删除文章及其 Wiki 派生页、标签与目录树节点。
func DeleteArticle(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
			articleID, user.ID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}
		ctx := context.Background()

		if _, err := deleteArticleWikiPages(q, user.ID, []ArticleRow{*article}, true); err != nil {
			return nil, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_article_tag WHERE article_id = $1`, article.ID); err != nil {
			return nil, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_article WHERE id = $1 AND user_id = $2`, article.ID, user.ID); err != nil {
			return nil, err
		}
		if _, err := q.Exec(ctx,
			`DELETE FROM petrichor_kb_node WHERE id = $1 AND user_id = $2`, article.NodeID, user.ID); err != nil {
			return nil, err
		}
		// TS 版此处还会异步清理无引用 S4 图片对象；Go 对象存储删除设施未迁移，暂不执行。

		invalidatePublicArticleListCache()
		invalidatePublicArticleDetailCache("")
		return map[string]any{
			"articleId": strconv.FormatInt(article.ID, 10),
			"nodeId":    strconv.FormatInt(article.NodeID, 10),
		}, nil
	})
}

// SearchArticles 知识库内按标题关键字 + 标签过滤搜索（对应 share-handlers.ts 的 searchArticles）。
func SearchArticles(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "知识库ID非法")
		if err != nil {
			return nil, err
		}
		keyword := trimmedString(raw, "keyword")
		tagFilter := []string{}
		if list, ok := raw["tags"].([]any); ok {
			tagFilter, err = normalizeTags(list)
			if err != nil {
				return nil, err
			}
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}

		sql := `SELECT ` + articleColumns + ` FROM petrichor_kb_article
			 WHERE user_id = $1 AND knowledge_base_id = $2`
		args := []any{user.ID, kbID}
		if keyword != "" {
			sql += ` AND title ILIKE $3`
			args = append(args, "%"+keyword+"%")
		}
		sql += ` ORDER BY updated_at DESC, id DESC`
		articles, err := queryArticles(q, sql, args...)
		if err != nil {
			return nil, err
		}

		articleIDs := make([]int64, 0, len(articles))
		for i := range articles {
			articleIDs = append(articleIDs, articles[i].ID)
		}
		tagsByArticle, err := loadTagsByArticleIDs(q, articleIDs)
		if err != nil {
			return nil, err
		}
		nodeMap, err := loadNodeMap(q, kbID)
		if err != nil {
			return nil, err
		}

		requiredTags := map[string]struct{}{}
		for _, tag := range tagFilter {
			requiredTags[tag] = struct{}{}
		}
		items := []map[string]any{}
		for i := range articles {
			article := &articles[i]
			if len(requiredTags) > 0 {
				tags := tagsByArticle[article.ID]
				ok := true
				for tag := range requiredTags {
					found := false
					for _, t := range tags {
						if t == tag {
							found = true
							break
						}
					}
					if !found {
						ok = false
						break
					}
				}
				if !ok {
					continue
				}
			}
			items = append(items, map[string]any{
				"articleId": strconv.FormatInt(article.ID, 10),
				"nodeId":    strconv.FormatInt(article.NodeID, 10),
				"title":     article.Title,
				"tags":      tagsOrEmpty(tagsByArticle, article.ID),
				"path":      buildArticlePath(nodeMap, article.NodeID),
				"updatedAt": iso(article.UpdatedAt),
			})
		}
		return map[string]any{"items": items}, nil
	})
}

func tagsOrEmpty(tagsByArticle map[int64][]string, articleID int64) []string {
	if tags, ok := tagsByArticle[articleID]; ok && tags != nil {
		return tags
	}
	return []string{}
}

func loadTagsByArticleIDs(q execQuerier, articleIDs []int64) (map[int64][]string, error) {
	result := map[int64][]string{}
	if len(articleIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(context.Background(),
		`SELECT article_id, tag FROM petrichor_kb_article_tag
		 WHERE article_id = ANY($1) ORDER BY tag ASC`, articleIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var articleID int64
		var tag string
		if err := rows.Scan(&articleID, &tag); err != nil {
			return nil, err
		}
		result[articleID] = append(result[articleID], tag)
	}
	return result, rows.Err()
}

// pathNode 搜索路径构建所需的最小节点信息。
type pathNode struct {
	ID       int64
	ParentID *int64
	Name     string
}

// buildArticlePath 对应 share-logic.ts 的 buildArticlePath（带循环防护）。
func buildArticlePath(nodeMap map[int64]*pathNode, nodeID int64) string {
	if nodeID <= 0 {
		return "/"
	}
	names := make([]string, 0, 16)
	visited := map[int64]struct{}{}
	current, ok := nodeMap[nodeID]
	depth := 0
	for ok {
		if depth > 100 {
			return "/"
		}
		if _, seen := visited[current.ID]; seen {
			return "/"
		}
		visited[current.ID] = struct{}{}
		names = append([]string{current.Name}, names...)
		if current.ParentID == nil {
			break
		}
		current, ok = nodeMap[*current.ParentID]
		depth++
	}
	if len(names) == 0 {
		return "/"
	}
	return "/" + strings.Join(names, "/")
}

func loadNodeMap(q execQuerier, knowledgeBaseID int64) (map[int64]*pathNode, error) {
	rows, err := q.Query(context.Background(),
		`SELECT id, parent_id, name FROM petrichor_kb_node WHERE knowledge_base_id = $1`, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64]*pathNode{}
	for rows.Next() {
		var n pathNode
		if err := rows.Scan(&n.ID, &n.ParentID, &n.Name); err != nil {
			return nil, err
		}
		result[n.ID] = &n
	}
	return result, rows.Err()
}
