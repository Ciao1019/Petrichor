// article.go 对照 handlers.ts：article create/update/delete/move/list。
package agentapi

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/kb"
)

type articleLite struct {
	id              int64
	knowledgeBaseID int64
	nodeID          int64
	title           string
	contentMd       string
	contentJSON     *string
	createdAt       time.Time
	updatedAt       time.Time
}

// loadOwnedArticle 对应 handlers.ts loadOwnedArticle：不存在返回 404。
func loadOwnedArticle(ctx context.Context, q querierLike, userID, articleID int64) (*articleLite, error) {
	row := q.QueryRow(ctx,
		`SELECT id, knowledge_base_id, node_id, title, content_md, content_json, created_at, updated_at
		 FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
		articleID, userID)
	var a articleLite
	err := row.Scan(&a.id, &a.knowledgeBaseID, &a.nodeID, &a.title, &a.contentMd, &a.contentJSON, &a.createdAt, &a.updatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, notFoundErr("文章不存在")
		}
		return nil, err
	}
	return &a, nil
}

// buildPublicMetadata 公开文章派生元数据（复用 internal/kb 实现）。
func buildPublicMetadata(contentMd string) (*string, int32, *string, *string) {
	meta := kb.BuildPublicArticleMetadata(contentMd)
	return meta.PublicExcerpt, meta.ReadingMinutes, meta.TocJSON, meta.PublicContentHash
}

// parseTagsInput 对照 agentArticleCreateSchema 的 tags 字段（每项 1..40 字符，最多 50 项）。
func parseTagsInput(raw map[string]any) ([]string, error) {
	list, ok := raw["tags"].([]any)
	if !ok {
		return []string{}, nil
	}
	tags := []string{}
	for _, item := range list {
		s, _ := item.(string)
		s = strings.TrimSpace(s)
		if len([]rune(s)) < 1 || len([]rune(s)) > 40 {
			return nil, badReq("标签长度必须在 1 到 40 个字符之间")
		}
		tags = append(tags, s)
	}
	if len(tags) > 50 {
		return nil, badReq("标签数量不能超过 50")
	}
	return tags, nil
}

// parseTitleInput 对照 title 字段（trim 后 1..200）。
func parseTitleInput(raw map[string]any) (string, error) {
	title := trimmedString(raw, "title")
	if title == "" || len([]rune(title)) > 200 {
		return "", badReq("标题必须在 1 到 200 个字符之间")
	}
	return title, nil
}

// replaceArticleTags 对应 handlers.ts replaceArticleTags（全量重建，去重限 50）。
func replaceArticleTags(ctx context.Context, querier querierLike, articleID int64, tags []string) error {
	if _, err := querier.Exec(ctx,
		`DELETE FROM petrichor_kb_article_tag WHERE article_id = $1`, articleID); err != nil {
		return err
	}
	seen := map[string]struct{}{}
	normalized := []string{}
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if _, dup := seen[tag]; dup {
			continue
		}
		seen[tag] = struct{}{}
		normalized = append(normalized, tag)
	}
	if len(normalized) > 50 {
		normalized = normalized[:50]
	}
	for _, tag := range normalized {
		if _, err := querier.Exec(ctx,
			`INSERT INTO petrichor_kb_article_tag (article_id, tag) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`, articleID, tag); err != nil {
			return err
		}
	}
	return nil
}

// loadTags 按标签名排序加载文章标签。
func loadTags(ctx context.Context, q querierLike, articleID int64) ([]string, error) {
	rows, err := q.Query(ctx,
		`SELECT tag FROM petrichor_kb_article_tag WHERE article_id = $1 ORDER BY tag ASC`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []string{}
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

var likeEscapeRe = regexp.MustCompile(`[\\%_]`)

func escapeLike(value string) string {
	return likeEscapeRe.ReplaceAllStringFunc(value, func(ch string) string {
		return "\\" + ch
	})
}

// AgentCreateArticle POST /api/agent/article/create（scope article:write）。
func AgentCreateArticle(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "article:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	title, err := parseTitleInput(raw)
	if err != nil {
		return nil, err
	}
	contentMd, _ := raw["contentMd"].(string)
	if contentMd == "" {
		return nil, badReq("contentMd 不能为空")
	}
	parentID, hasParent, err := optID(raw, "parentId")
	if err != nil {
		return nil, err
	}
	tags, err := parseTagsInput(raw)
	if err != nil {
		return nil, err
	}

	q := dbPool()
	ctx := c.Request.Context()
	tx, err := q.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(ctx, tx, actx.UserID, kbID); err != nil {
		return nil, err
	}
	if err := assertFolderParent(ctx, tx, actx.UserID, kbID, parentID, hasParent); err != nil {
		return nil, err
	}
	sortOrder, err := nextSortOrder(ctx, tx, actx.UserID, kbID, parentID, hasParent)
	if err != nil {
		return nil, err
	}
	var nodeID int64
	if err := tx.QueryRow(ctx,
		`INSERT INTO petrichor_kb_node (user_id, knowledge_base_id, parent_id, type, name, sort_order)
		 VALUES ($1,$2,$3,'ARTICLE',$4,$5) RETURNING id`,
		actx.UserID, kbID, optionalIDArg(parentID, hasParent), title, sortOrder).Scan(&nodeID); err != nil {
		return nil, err
	}

	publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicMetadata(contentMd)
	contentJSON := nullableString(raw, "contentJson")
	contentMetaJSON := nullableString(raw, "contentMetaJson")
	var articleID int64
	var createdAt time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO petrichor_kb_article (user_id, knowledge_base_id, node_id, title,
		 content_md, content_json, content_meta_json, public_excerpt, reading_minutes,
		 toc_json, public_content_hash)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
		actx.UserID, kbID, nodeID, title, contentMd, contentJSON, contentMetaJSON,
		publicExcerpt, readingMinutes, tocJSON, contentHash).Scan(&articleID, &createdAt); err != nil {
		return nil, err
	}
	if err := replaceArticleTags(ctx, tx, articleID, tags); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{
		"articleId":       idStr(articleID),
		"nodeId":          idStr(nodeID),
		"knowledgeBaseId": idStr(kbID),
		"title":           title,
		"createdAt":       iso(createdAt),
	}, nil
}

// AgentUpdateArticle POST /api/agent/article/update（scope article:write）。
func AgentUpdateArticle(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "article:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	title, err := parseTitleInput(raw)
	if err != nil {
		return nil, err
	}
	contentMd, _ := raw["contentMd"].(string)
	if contentMd == "" {
		return nil, badReq("contentMd 不能为空")
	}
	tags, err := parseTagsInput(raw)
	if err != nil {
		return nil, err
	}

	q := dbPool()
	ctx := c.Request.Context()
	existingArticle, err := loadOwnedArticle(ctx, q, actx.UserID, articleID)
	if err != nil {
		return nil, err
	}

	publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicMetadata(contentMd)
	contentJSON := nullableString(raw, "contentJson")
	contentMetaJSON := nullableString(raw, "contentMetaJson")
	previousImageObjectKeys := kb.ExtractS4ObjectKeysFromArticleContent(existingArticle.contentJSON, existingArticle.contentMd, actx.UserID)
	nextImageObjectKeys := kb.ExtractS4ObjectKeysFromArticleContent(contentJSON, contentMd, actx.UserID)
	removedImageObjectKeys := kb.RemovedS4ObjectKeys(previousImageObjectKeys, nextImageObjectKeys)
	nodeID := int64(0)
	if err := q.QueryRow(ctx,
		`UPDATE petrichor_kb_article SET title = $1, content_md = $2, content_json = $3,
		 content_meta_json = $4, public_excerpt = $5, reading_minutes = $6, toc_json = $7,
		 public_content_hash = $8, updated_at = now()
		 WHERE id = $9 AND user_id = $10 RETURNING node_id`,
		title, contentMd, contentJSON, contentMetaJSON, publicExcerpt, readingMinutes,
		tocJSON, contentHash, articleID, actx.UserID).Scan(&nodeID); err != nil {
		if err == pgx.ErrNoRows {
			return nil, notFoundErr("文章不存在")
		}
		return nil, err
	}
	if _, err := q.Exec(ctx,
		`UPDATE petrichor_kb_node SET name = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
		title, nodeID, actx.UserID); err != nil {
		return nil, err
	}
	if err := replaceArticleTags(ctx, q, articleID, tags); err != nil {
		return nil, err
	}
	kb.ScheduleUnreferencedS4Cleanup(actx.UserID, removedImageObjectKeys, "agentUpdateArticle")
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{
		"articleId":       idStr(articleID),
		"nodeId":          idStr(nodeID),
		"knowledgeBaseId": idStr(existingArticle.knowledgeBaseID),
		"title":           title,
		"updatedAt":       iso(time.Now()),
	}, nil
}

// AgentDeleteArticle POST /api/agent/article/delete（scope article:delete）。
func AgentDeleteArticle(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "article:delete"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	q := dbPool()
	ctx := c.Request.Context()
	row := q.QueryRow(ctx,
		`SELECT id, knowledge_base_id, node_id, title, content_md FROM petrichor_kb_article
		 WHERE id = $1 AND user_id = $2 LIMIT 1`, articleID, actx.UserID)
	var a articleLite
	if err := row.Scan(&a.id, &a.knowledgeBaseID, &a.nodeID, &a.title, &a.contentMd); err != nil {
		if err == pgx.ErrNoRows {
			return nil, notFoundErr("文章不存在")
		}
		return nil, err
	}

	full, err := queryOwnedArticleRows(ctx, q, actx.UserID, a.id)
	if err != nil {
		return nil, err
	}
	imageObjectKeys := kb.ExtractS4ObjectKeysFromArticleContent(full.ContentJson, full.ContentMd, actx.UserID)
	if _, err := kb.DeleteArticleWikiPagesForAgent(c.Request.Context(), q, actx.UserID, []kb.ArticleRow{*full}, true); err != nil {
		return nil, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_article_tag WHERE article_id = $1`, a.id); err != nil {
		return nil, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_article WHERE id = $1 AND user_id = $2`, a.id, actx.UserID); err != nil {
		return nil, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_node WHERE id = $1 AND user_id = $2`, a.nodeID, actx.UserID); err != nil {
		return nil, err
	}
	kb.ScheduleUnreferencedS4Cleanup(actx.UserID, imageObjectKeys, "agentDeleteArticle")
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{
		"articleId":       idStr(a.id),
		"nodeId":          idStr(a.nodeID),
		"knowledgeBaseId": idStr(a.knowledgeBaseID),
		"title":           a.title,
		"deletedAt":       iso(time.Now()),
	}, nil
}

// queryOwnedArticleRows 取完整行供 Wiki 派生数据清理使用。
func queryOwnedArticleRows(ctx context.Context, q *pgxpool.Pool, userID, articleID int64) (*kb.ArticleRow, error) {
	return kb.QueryOwnedArticleForAgent(ctx, q, userID, articleID)
}

// ===== move =====

type moveNodeLite struct {
	id        int64
	parentID  *int64
	sortOrder int32
}

// AgentMoveArticle POST /api/agent/article/move（scope article:write）。
func AgentMoveArticle(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "article:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	targetParentID, hasTargetParent, err := optID(raw, "parentId")
	if err != nil {
		return nil, err
	}
	var targetIndex *int
	if v, ok := raw["targetIndex"]; ok && v != nil {
		fv, isNum := v.(float64)
		n := int(fv)
		if !isNum || fv < 0 || float64(n) != fv {
			return nil, badReq("targetIndex 非法")
		}
		targetIndex = &n
	}

	q := dbPool()
	ctx := c.Request.Context()
	a, err := loadOwnedArticle(ctx, q, actx.UserID, articleID)
	if err != nil {
		return nil, err
	}
	if err := assertFolderParent(ctx, q, actx.UserID, a.knowledgeBaseID, targetParentID, hasTargetParent); err != nil {
		return nil, err
	}

	allNodes, err := loadMoveNodes(ctx, q, actx.UserID, a.knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	nodeID := a.nodeID
	if hasTargetParent && (targetParentID == nodeID || isDescendantNodeLite(allNodes, nodeID, targetParentID)) {
		return nil, badReq("不能把节点移动到自身或子文件夹中")
	}
	var moving *moveNodeLite
	for i := range allNodes {
		if allNodes[i].id == nodeID {
			moving = &allNodes[i]
			break
		}
	}
	if moving == nil {
		return nil, notFoundErr("文章节点不存在")
	}

	sourceParentID := moving.parentID
	var sourceSiblings, targetSiblings []moveNodeLite
	for i := range allNodes {
		node := &allNodes[i]
		if sameParentLite(node.parentID, sourceParentID) {
			sourceSiblings = append(sourceSiblings, *node)
		}
		if sameParentLite(node.parentID, optionalIDPtr(targetParentID, hasTargetParent)) {
			targetSiblings = append(targetSiblings, *node)
		}
	}
	sortMoveNodes(sourceSiblings)
	sortMoveNodes(targetSiblings)

	targetOrder := moveIntoSiblingOrder(idsOfMoveNodes(targetSiblings), nodeID, targetIndex)
	var sourceOrder []int64
	if sameParentLite(sourceParentID, optionalIDPtr(targetParentID, hasTargetParent)) {
		sourceOrder = targetOrder
	} else {
		for _, id := range idsOfMoveNodes(sourceSiblings) {
			if id != nodeID {
				sourceOrder = append(sourceOrder, id)
			}
		}
	}

	updatedAt := time.Now()
	parentArg := optionalIDArg(targetParentID, hasTargetParent)
	if !sameParentLite(sourceParentID, optionalIDPtr(targetParentID, hasTargetParent)) {
		for index, id := range sourceOrder {
			if _, err := q.Exec(ctx,
				`UPDATE petrichor_kb_node SET sort_order = $1, updated_at = $2 WHERE id = $3 AND user_id = $4`,
				int32(index+1), updatedAt, id, actx.UserID); err != nil {
				return nil, err
			}
		}
	}
	for index, id := range targetOrder {
		if id == nodeID {
			if _, err := q.Exec(ctx,
				`UPDATE petrichor_kb_node SET parent_id = $1, sort_order = $2, updated_at = $3
				 WHERE id = $4 AND user_id = $5`,
				parentArg, int32(index+1), updatedAt, id, actx.UserID); err != nil {
				return nil, err
			}
			continue
		}
		if _, err := q.Exec(ctx,
			`UPDATE petrichor_kb_node SET sort_order = $1, updated_at = $2 WHERE id = $3 AND user_id = $4`,
			int32(index+1), updatedAt, id, actx.UserID); err != nil {
			return nil, err
		}
	}

	if !sameParentLite(sourceParentID, optionalIDPtr(targetParentID, hasTargetParent)) {
		kb.InvalidatePublicArticleCaches("")
	}

	return map[string]any{
		"articleId":       idStr(a.id),
		"nodeId":          idStr(nodeID),
		"knowledgeBaseId": idStr(a.knowledgeBaseID),
		"parentId":        nullableIDStr(optionalIDPtr(targetParentID, hasTargetParent)),
		"updatedAt":       iso(updatedAt),
	}, nil
}

func loadMoveNodes(ctx context.Context, q *pgxpool.Pool, userID, knowledgeBaseID int64) ([]moveNodeLite, error) {
	rows, err := q.Query(ctx,
		`SELECT id, parent_id, sort_order FROM petrichor_kb_node
		 WHERE user_id = $1 AND knowledge_base_id = $2`, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var nodes []moveNodeLite
	for rows.Next() {
		var n moveNodeLite
		if err := rows.Scan(&n.id, &n.parentID, &n.sortOrder); err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	return nodes, rows.Err()
}

func isDescendantNodeLite(allNodes []moveNodeLite, ancestorID int64, nodeID int64) bool {
	parentByNode := map[int64]*int64{}
	for i := range allNodes {
		parentByNode[allNodes[i].id] = allNodes[i].parentID
	}
	visited := map[int64]struct{}{}
	current := &nodeID
	for current != nil {
		if _, seen := visited[*current]; seen {
			return false
		}
		visited[*current] = struct{}{}
		if *current == ancestorID {
			return true
		}
		parent, ok := parentByNode[*current]
		if !ok {
			return false
		}
		current = parent
	}
	return false
}

func sameParentLite(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func sortMoveNodes(nodes []moveNodeLite) {
	for i := 1; i < len(nodes); i++ {
		for j := i; j > 0; j-- {
			if nodes[j-1].sortOrder < nodes[j].sortOrder ||
				(nodes[j-1].sortOrder == nodes[j].sortOrder && nodes[j-1].id <= nodes[j].id) {
				break
			}
			nodes[j-1], nodes[j] = nodes[j], nodes[j-1]
		}
	}
}

func idsOfMoveNodes(nodes []moveNodeLite) []int64 {
	out := make([]int64, 0, len(nodes))
	for i := range nodes {
		out = append(out, nodes[i].id)
	}
	return out
}

// moveIntoSiblingOrder 对照 node-move-logic.ts moveNodeIdIntoSiblingOrder。
func moveIntoSiblingOrder(siblingIDs []int64, movingNodeID int64, targetIndex *int) []int64 {
	withoutMoving := make([]int64, 0, len(siblingIDs))
	for _, id := range siblingIDs {
		if id != movingNodeID {
			withoutMoving = append(withoutMoving, id)
		}
	}
	safeIndex := len(withoutMoving)
	if targetIndex != nil {
		safeIndex = *targetIndex
		if safeIndex < 0 {
			safeIndex = 0
		}
		if safeIndex > len(withoutMoving) {
			safeIndex = len(withoutMoving)
		}
	}
	out := make([]int64, 0, len(withoutMoving)+1)
	out = append(out, withoutMoving[:safeIndex]...)
	out = append(out, movingNodeID)
	out = append(out, withoutMoving[safeIndex:]...)
	return out
}
