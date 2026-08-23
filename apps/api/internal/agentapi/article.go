// article.go 对照 handlers.ts：article create/update/delete/move/list。
package agentapi

import (
	"context"
	"regexp"
	"strconv"
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
	createdAt       time.Time
	updatedAt       time.Time
}

// loadOwnedArticle 对应 handlers.ts loadOwnedArticle：不存在返回 404。
func loadOwnedArticle(q querierLike, userID, articleID int64) (*articleLite, error) {
	row := q.QueryRow(context.Background(),
		`SELECT id, knowledge_base_id, node_id, title, content_md, created_at, updated_at
		 FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
		articleID, userID)
	var a articleLite
	err := row.Scan(&a.id, &a.knowledgeBaseID, &a.nodeID, &a.title, &a.contentMd, &a.createdAt, &a.updatedAt)
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
func replaceArticleTags(querier querierLike, articleID int64, tags []string) error {
	ctx := context.Background()
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
func loadTags(q querierLike, articleID int64) ([]string, error) {
	rows, err := q.Query(context.Background(),
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
	ctx := context.Background()
	tx, err := q.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())

	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(tx, actx.UserID, kbID); err != nil {
		return nil, err
	}
	if err := assertFolderParent(tx, actx.UserID, kbID, parentID, hasParent); err != nil {
		return nil, err
	}
	sortOrder, err := nextSortOrder(tx, actx.UserID, kbID, parentID, hasParent)
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
	if err := replaceArticleTags(tx, articleID, tags); err != nil {
		return nil, err
	}
	if err := tx.Commit(context.Background()); err != nil {
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
	ctx := context.Background()
	existingArticle, err := loadOwnedArticle(q, actx.UserID, articleID)
	if err != nil {
		return nil, err
	}

	publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicMetadata(contentMd)
	contentJSON := nullableString(raw, "contentJson")
	contentMetaJSON := nullableString(raw, "contentMetaJson")
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
	if err := replaceArticleTags(q, articleID, tags); err != nil {
		return nil, err
	}
	// TS 版此处会异步清理被移除的图片对象；Go 对象存储删除设施未迁移，暂不执行。
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
	ctx := context.Background()
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

	full, err := queryOwnedArticleRows(q, actx.UserID, a.id)
	if err != nil {
		return nil, err
	}
	if _, err := kb.DeleteArticleWikiPagesForAgent(q, actx.UserID, []kb.ArticleRow{*full}, true); err != nil {
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
	// TS 版此处还会异步清理无引用 S4 图片对象；Go 对象存储删除设施未迁移，暂不执行。
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
func queryOwnedArticleRows(q *pgxpool.Pool, userID, articleID int64) (*kb.ArticleRow, error) {
	return kb.QueryOwnedArticleForAgent(q, userID, articleID)
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
	ctx := context.Background()
	a, err := loadOwnedArticle(q, actx.UserID, articleID)
	if err != nil {
		return nil, err
	}
	if err := assertFolderParent(q, actx.UserID, a.knowledgeBaseID, targetParentID, hasTargetParent); err != nil {
		return nil, err
	}

	allNodes, err := loadMoveNodes(q, actx.UserID, a.knowledgeBaseID)
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

func loadMoveNodes(q *pgxpool.Pool, userID, knowledgeBaseID int64) ([]moveNodeLite, error) {
	rows, err := q.Query(context.Background(),
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

// ===== list =====

type listNodeLite struct {
	id       int64
	parentID *int64
	name     string
}

// AgentListArticles POST /api/agent/article/list（scope doc:read）。
func AgentListArticles(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "doc:read"); err != nil {
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
	parentID, hasParentFilter, err := optID(raw, "parentId")
	if err != nil {
		return nil, err
	}
	parentScope := trimmedString(raw, "parentScope")
	if parentScope == "" {
		parentScope = "ANY"
	}
	if parentScope != "ANY" && parentScope != "DIRECT" {
		return nil, badReq("parentScope 非法")
	}
	requiredTags, err := parseTagsInput(raw)
	if err != nil {
		return nil, err
	}
	keyword := trimmedString(raw, "keyword")
	if len([]rune(keyword)) > 200 {
		return nil, badReq("keyword 长度不能超过 200")
	}
	limit := int64(50)
	if v, ok := raw["limit"].(float64); ok && v >= 1 && v <= 200 && float64(int64(v)) == v {
		limit = int64(v)
	}

	q := dbPool()
	ctx := context.Background()
	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(q, actx.UserID, kbID); err != nil {
		return nil, err
	}

	sqlText := `SELECT a.id, a.knowledge_base_id, a.title, a.created_at, a.updated_at,
		       n.id, n.parent_id, n.name, n.sort_order
		FROM petrichor_kb_article a
		INNER JOIN petrichor_kb_node n ON n.id = a.node_id
		WHERE a.user_id = $1 AND a.knowledge_base_id = $2`
	args := []any{actx.UserID, kbID}
	if keyword != "" {
		args = append(args, "%"+escapeLike(keyword)+"%")
		sqlText += ` AND a.title ILIKE $` + strconv.Itoa(len(args))
	}
	sqlText += ` ORDER BY a.updated_at DESC, a.id DESC`
	rows, err := q.Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	type articleListRow struct {
		articleID int64
		title     string
		createdAt time.Time
		updatedAt time.Time
		nodeID    int64
		parentID  *int64
		nodeName  string
		nodeOrder int32
	}
	var rowsData []articleListRow
	for rows.Next() {
		var row articleListRow
		if err := rows.Scan(&row.articleID, new(int64), &row.title, &row.createdAt, &row.updatedAt,
			&row.nodeID, &row.parentID, &row.nodeName, &row.nodeOrder); err != nil {
			rows.Close()
			return nil, err
		}
		rowsData = append(rowsData, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	articleIDs := make([]int64, 0, len(rowsData))
	for i := range rowsData {
		articleIDs = append(articleIDs, rowsData[i].articleID)
	}
	tagsByArticle, err := loadTagsByArticleIDs(q, articleIDs)
	if err != nil {
		return nil, err
	}
	nodeMap, err := loadListNodeMap(q, actx.UserID, kbID)
	if err != nil {
		return nil, err
	}

	requiredTagSet := map[string]struct{}{}
	for _, tag := range requiredTags {
		requiredTagSet[tag] = struct{}{}
	}
	filteredByTag := []articleListRow{}
	for i := range rowsData {
		row := &rowsData[i]
		if len(requiredTagSet) == 0 {
			filteredByTag = append(filteredByTag, *row)
			continue
		}
		tags := map[string]struct{}{}
		for _, tag := range tagsByArticle[row.articleID] {
			tags[tag] = struct{}{}
		}
		allMatched := true
		for tag := range requiredTagSet {
			if _, ok := tags[tag]; !ok {
				allMatched = false
				break
			}
		}
		if allMatched {
			filteredByTag = append(filteredByTag, *row)
		}
	}

	filteredByParent := []articleListRow{}
	for i := range filteredByTag {
		row := filteredByTag[i]
		if !hasParentFilter {
			filteredByParent = append(filteredByParent, row)
			continue
		}
		if parentScope == "DIRECT" {
			if sameParentLite(row.parentID, optionalIDPtr(parentID, hasParentFilter)) {
				filteredByParent = append(filteredByParent, row)
			}
			continue
		}
		if !hasParentFilter || isNodeUnderAncestor(nodeMap, row.nodeID, parentID) {
			filteredByParent = append(filteredByParent, row)
		}
	}

	totalAfterFilter := len(filteredByParent)
	if int64(totalAfterFilter) > limit {
		filteredByParent = filteredByParent[:limit]
	}
	items := make([]map[string]any, 0, len(filteredByParent))
	for i := range filteredByParent {
		row := &filteredByParent[i]
		items = append(items, map[string]any{
			"articleId":       idStr(row.articleID),
			"nodeId":          idStr(row.nodeID),
			"knowledgeBaseId": idStr(kbID),
			"parentId":        nullableIDStr(row.parentID),
			"title":           row.title,
			"tags":            tagsFor(tagsByArticle, row.articleID),
			"path":            buildArticlePathLite(nodeMap, row.nodeID),
			"sortOrder":       row.nodeOrder,
			"createdAt":       iso(row.createdAt),
			"updatedAt":       iso(row.updatedAt),
		})
	}
	return map[string]any{
		"knowledgeBaseId": idStr(kbID),
		"items":           items,
		"hasMore":         int64(totalAfterFilter) > limit,
	}, nil
}

func tagsFor(tagsByArticle map[int64][]string, articleID int64) []string {
	if tags, ok := tagsByArticle[articleID]; ok {
		return tags
	}
	return []string{}
}

func loadTagsByArticleIDs(q *pgxpool.Pool, articleIDs []int64) (map[int64][]string, error) {
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

func loadListNodeMap(q *pgxpool.Pool, userID, knowledgeBaseID int64) (map[int64]listNodeLite, error) {
	rows, err := q.Query(context.Background(),
		`SELECT id, parent_id, name FROM petrichor_kb_node
		 WHERE user_id = $1 AND knowledge_base_id = $2`, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64]listNodeLite{}
	for rows.Next() {
		var node listNodeLite
		if err := rows.Scan(&node.id, &node.parentID, &node.name); err != nil {
			return nil, err
		}
		result[node.id] = node
	}
	return result, rows.Err()
}

// isNodeUnderAncestor 对照 handlers.ts 同名函数。
func isNodeUnderAncestor(nodeMap map[int64]listNodeLite, nodeID, ancestorID int64) bool {
	current, ok := nodeMap[nodeID]
	depth := 0
	for ok && depth < 100 {
		if current.parentID != nil && *current.parentID == ancestorID {
			return true
		}
		if current.parentID == nil {
			return false
		}
		current, ok = nodeMap[*current.parentID]
		depth++
	}
	return false
}

// buildArticlePathLite 对照 share-logic.ts buildArticlePath（"/a/b" 形式）。
func buildArticlePathLite(nodeMap map[int64]listNodeLite, nodeID int64) string {
	if nodeID <= 0 {
		return "/"
	}
	names := []string{}
	visited := map[int64]struct{}{}
	current, ok := nodeMap[nodeID]
	depth := 0
	for ok && depth <= 100 {
		if _, seen := visited[current.id]; seen {
			return "/"
		}
		visited[current.id] = struct{}{}
		names = append([]string{current.name}, names...)
		if current.parentID == nil {
			break
		}
		current, ok = nodeMap[*current.parentID]
		depth++
	}
	if len(names) == 0 {
		return "/"
	}
	return "/" + strings.Join(names, "/")
}
