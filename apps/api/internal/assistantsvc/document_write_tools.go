package assistantsvc

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/kb"
)

const (
	createArticleSchema = `{"type":"object","additionalProperties":false,"properties":{"knowledgeBaseId":{"type":["string","integer"]},"title":{"type":"string","minLength":1,"maxLength":200},"contentMd":{"type":"string"},"parentId":{"type":["string","integer","null"]}},"required":["knowledgeBaseId","title"]}`
	updateArticleSchema = `{"type":"object","additionalProperties":false,"properties":{"articleId":{"type":["string","integer"]},"title":{"type":"string","minLength":1,"maxLength":200},"contentMd":{"type":"string"}},"required":["articleId"],"anyOf":[{"required":["title"]},{"required":["contentMd"]}]}`
	moveArticleSchema   = `{"type":"object","additionalProperties":false,"properties":{"articleId":{"type":["string","integer"]},"targetKnowledgeBaseId":{"type":["string","integer"]},"parentId":{"type":["string","integer","null"]},"targetIndex":{"type":"integer","minimum":0}},"required":["articleId","targetKnowledgeBaseId"]}`
	articleIDSchema     = `{"type":"object","additionalProperties":false,"properties":{"articleId":{"type":["string","integer"]}},"required":["articleId"]}`
)

var strictPositiveID = regexp.MustCompile(`^[1-9][0-9]*$`)

func registerDocumentWriteTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	noSubAgent := toolPtr(false)
	registry.Register(&rt.AgentToolDefinition{
		ID: "document.create", Name: "create_article", Namespace: rt.NamespaceDocument,
		Description: "在指定知识库创建一篇新文章。只有用户明确要求落库时才调用。",
		InputSchema: schemaJSON(createArticleSchema), RiskLevel: rt.RiskMedium,
		SideEffect: true, Permissions: []string{rt.PermissionWrite}, AllowedInSubAgent: noSubAgent,
		Execute: executeCreateArticle, Normalize: normalizeArticleWrite("已创建文章"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "document.update", Name: "update_article", Namespace: rt.NamespaceDocument,
		Description: "更新文章标题和/或 Markdown 正文并落库。大段正文改写前必须先调用 preview_article_update。",
		InputSchema: schemaJSON(updateArticleSchema), RiskLevel: rt.RiskMedium,
		SideEffect: true, Permissions: []string{rt.PermissionWrite}, AllowedInSubAgent: noSubAgent,
		Execute: executeUpdateArticle, Normalize: normalizeArticleWrite("已更新文章"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "document.preview_update", Name: "preview_article_update", Namespace: rt.NamespaceDocument,
		Description: "预览文章标题变更与正文 unified diff，不落库。大段改写必须先调用本工具。",
		InputSchema: schemaJSON(updateArticleSchema), RiskLevel: rt.RiskLow,
		AllowedInSubAgent: noSubAgent, Execute: executePreviewArticleUpdate,
		Normalize: normalizeArticlePreview,
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "document.move", Name: "move_article", Namespace: rt.NamespaceDocument,
		Description: "移动文章到目标知识库，可同库调整父目录/排序，也可跨库迁移。",
		InputSchema: schemaJSON(moveArticleSchema), RiskLevel: rt.RiskMedium,
		SideEffect: true, Permissions: []string{rt.PermissionWrite}, AllowedInSubAgent: noSubAgent,
		Execute: executeMoveArticle, Normalize: normalizeArticleWrite("已移动文章"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "document.share", Name: "create_article_share", Namespace: rt.NamespaceDocument,
		Description: "开启文章公开分享链接；已有且启用的链接会保持原 shareCode。",
		InputSchema: schemaJSON(articleIDSchema), RiskLevel: rt.RiskMedium,
		SideEffect: true, Permissions: []string{rt.PermissionWrite}, AllowedInSubAgent: noSubAgent,
		Execute: executeCreateArticleShare, Normalize: normalizeArticleWrite("已开启文章分享"),
	})
}

func requiredToolID(value any, field string) (int64, error) {
	text := strings.TrimSpace(fmt.Sprint(value))
	if !strictPositiveID.MatchString(text) {
		return 0, rt.ValidationError(field + " 必须是正整数")
	}
	var id int64
	if _, err := fmt.Sscan(text, &id); err != nil || id <= 0 {
		return 0, rt.ValidationError(field + " 必须是正整数")
	}
	return id, nil
}

func optionalToolID(params map[string]any, field string) (int64, bool, error) {
	value, exists := params[field]
	if !exists || value == nil {
		return 0, false, nil
	}
	id, err := requiredToolID(value, field)
	return id, err == nil, err
}

func articleHref(knowledgeBaseID, articleID int64) string {
	return fmt.Sprintf("/dashboard/knowledge/%d/articles/%d", knowledgeBaseID, articleID)
}

func assertAssistantFolderParent(q kb.Querier, ctx *rt.ToolExecutionContext, knowledgeBaseID, parentID int64, hasParent bool) error {
	if !hasParent {
		return nil
	}
	var gotKnowledgeBaseID int64
	var nodeType string
	err := q.QueryRow(toolContext(ctx), `
		SELECT knowledge_base_id, type FROM petrichor_kb_node
		WHERE id=$1 AND user_id=$2 LIMIT 1`, parentID, ctx.UserID).Scan(&gotKnowledgeBaseID, &nodeType)
	if err == pgx.ErrNoRows || (err == nil && (gotKnowledgeBaseID != knowledgeBaseID || nodeType != "FOLDER")) {
		return rt.ValidationError("父节点必须是目标知识库下的文件夹")
	}
	return err
}

func nextAssistantSortOrder(q kb.Querier, ctx *rt.ToolExecutionContext, knowledgeBaseID, parentID int64, hasParent bool) (int32, error) {
	query := `SELECT COALESCE(MAX(sort_order),0) FROM petrichor_kb_node WHERE user_id=$1 AND knowledge_base_id=$2`
	args := []any{ctx.UserID, knowledgeBaseID}
	if hasParent {
		query += ` AND parent_id=$3`
		args = append(args, parentID)
	} else {
		query += ` AND parent_id IS NULL`
	}
	var order int32
	err := q.QueryRow(toolContext(ctx), query, args...).Scan(&order)
	return order + 1, err
}

func executeCreateArticle(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	knowledgeBaseID, err := requiredToolID(params["knowledgeBaseId"], "knowledgeBaseId")
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(stringValue(params["title"]))
	if title == "" || len([]rune(title)) > 200 {
		return nil, rt.ValidationError("标题必须在 1 到 200 个字符之间")
	}
	contentMd := stringValue(params["contentMd"])
	parentID, hasParent, err := optionalToolID(params, "parentId")
	if err != nil {
		return nil, err
	}

	tx, err := dbPool().Begin(toolContext(ctx))
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(toolContext(ctx))
	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(tx, ctx.UserID, knowledgeBaseID); err != nil {
		return nil, rt.ValidationError("知识库不存在或不属于当前用户")
	}
	if err := assertAssistantFolderParent(tx, ctx, knowledgeBaseID, parentID, hasParent); err != nil {
		return nil, err
	}
	sortOrder, err := nextAssistantSortOrder(tx, ctx, knowledgeBaseID, parentID, hasParent)
	if err != nil {
		return nil, err
	}
	var nodeID int64
	if err := tx.QueryRow(toolContext(ctx), `
		INSERT INTO petrichor_kb_node
		(user_id,knowledge_base_id,parent_id,type,name,sort_order)
		VALUES ($1,$2,$3,'ARTICLE',$4,$5) RETURNING id`,
		ctx.UserID, knowledgeBaseID, nullableToolID(parentID, hasParent), title, sortOrder).Scan(&nodeID); err != nil {
		return nil, err
	}
	metadata := kb.BuildPublicArticleMetadata(contentMd)
	var articleID int64
	if err := tx.QueryRow(toolContext(ctx), `
		INSERT INTO petrichor_kb_article
		(user_id,knowledge_base_id,node_id,title,content_md,public_excerpt,reading_minutes,toc_json,public_content_hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		ctx.UserID, knowledgeBaseID, nodeID, title, contentMd, metadata.PublicExcerpt,
		metadata.ReadingMinutes, metadata.TocJSON, metadata.PublicContentHash).Scan(&articleID); err != nil {
		return nil, err
	}
	if err := tx.Commit(toolContext(ctx)); err != nil {
		return nil, err
	}
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{
		"articleId": idStr(articleID), "nodeId": idStr(nodeID), "knowledgeBaseId": idStr(knowledgeBaseID),
		"title": title, "href": articleHref(knowledgeBaseID, articleID),
	}, nil
}

type assistantArticleWriteRow struct {
	ID, KnowledgeBaseID, NodeID int64
	Title, ContentMd            string
}

func loadAssistantArticleForUpdate(q kb.Querier, ctx *rt.ToolExecutionContext, articleID int64, lock bool) (*assistantArticleWriteRow, error) {
	query := `SELECT id,knowledge_base_id,node_id,title,content_md FROM petrichor_kb_article WHERE id=$1 AND user_id=$2 LIMIT 1`
	if lock {
		query += ` FOR UPDATE`
	}
	var row assistantArticleWriteRow
	err := q.QueryRow(toolContext(ctx), query, articleID, ctx.UserID).Scan(
		&row.ID, &row.KnowledgeBaseID, &row.NodeID, &row.Title, &row.ContentMd)
	if err == pgx.ErrNoRows {
		return nil, rt.ValidationError("文章不存在或不属于当前用户")
	}
	return &row, err
}

func parseArticleUpdate(params map[string]any, current *assistantArticleWriteRow) (title, contentMd string, titleChanged, contentChanged bool, err error) {
	title, contentMd = current.Title, current.ContentMd
	rawTitle, hasTitle := params["title"]
	rawContent, hasContent := params["contentMd"]
	if !hasTitle && !hasContent {
		err = rt.ValidationError("至少提供 title 或 contentMd")
		return
	}
	if hasTitle {
		title = strings.TrimSpace(stringValue(rawTitle))
		if title == "" || len([]rune(title)) > 200 {
			err = rt.ValidationError("标题必须在 1 到 200 个字符之间")
			return
		}
		titleChanged = title != current.Title
	}
	if hasContent {
		contentMd = stringValue(rawContent)
		contentChanged = contentMd != current.ContentMd
	}
	return
}

func executeUpdateArticle(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	articleID, err := requiredToolID(params["articleId"], "articleId")
	if err != nil {
		return nil, err
	}
	tx, err := dbPool().Begin(toolContext(ctx))
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(toolContext(ctx))
	article, err := loadAssistantArticleForUpdate(tx, ctx, articleID, true)
	if err != nil {
		return nil, err
	}
	title, contentMd, titleChanged, contentChanged, err := parseArticleUpdate(params, article)
	if err != nil {
		return nil, err
	}
	if titleChanged || contentChanged {
		metadata := kb.BuildPublicArticleMetadata(contentMd)
		if _, err := tx.Exec(toolContext(ctx), `
			UPDATE petrichor_kb_article SET title=$1,content_md=$2,public_excerpt=$3,
			reading_minutes=$4,toc_json=$5,public_content_hash=$6,updated_at=now()
			WHERE id=$7 AND user_id=$8`, title, contentMd, metadata.PublicExcerpt,
			metadata.ReadingMinutes, metadata.TocJSON, metadata.PublicContentHash, article.ID, ctx.UserID); err != nil {
			return nil, err
		}
		if titleChanged {
			if _, err := tx.Exec(toolContext(ctx), `UPDATE petrichor_kb_node SET name=$1,updated_at=now() WHERE id=$2 AND user_id=$3`, title, article.NodeID, ctx.UserID); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(toolContext(ctx)); err != nil {
		return nil, err
	}
	if titleChanged || contentChanged {
		kb.InvalidatePublicArticleCaches("")
	}
	return map[string]any{
		"articleId": idStr(article.ID), "nodeId": idStr(article.NodeID), "knowledgeBaseId": idStr(article.KnowledgeBaseID),
		"title": title, "changed": titleChanged || contentChanged, "href": articleHref(article.KnowledgeBaseID, article.ID),
	}, nil
}

func executePreviewArticleUpdate(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	articleID, err := requiredToolID(params["articleId"], "articleId")
	if err != nil {
		return nil, err
	}
	article, err := loadAssistantArticleForUpdate(dbPool(), ctx, articleID, false)
	if err != nil {
		return nil, err
	}
	title, contentMd, titleChanged, contentChanged, err := parseArticleUpdate(params, article)
	if err != nil {
		return nil, err
	}
	output := map[string]any{
		"ok": true, "dryRun": true, "articleId": idStr(article.ID),
		"changed": titleChanged || contentChanged,
	}
	if !titleChanged && !contentChanged {
		output["message"] = "与当前内容相同，无需更新"
		return output, nil
	}
	output["title"] = map[string]any{"before": article.Title, "after": title, "changed": titleChanged}
	if contentChanged {
		output["contentDiff"] = buildUnifiedDiff(article.ContentMd, contentMd, "content.md")
	} else {
		output["contentDiff"] = nil
	}
	output["contentStats"] = map[string]any{"beforeChars": len([]rune(article.ContentMd)), "afterChars": len([]rune(contentMd))}
	output["href"] = articleHref(article.KnowledgeBaseID, article.ID)
	output["message"] = "预览未落库；确认内容无误后请调用 update_article"
	return output, nil
}

// buildUnifiedDiff 对齐 TS 的简单行级 diff；它的目标是可审核预览，不冒充完整 Myers diff。
func buildUnifiedDiff(before, after, label string) string {
	beforeLines := strings.Split(strings.ReplaceAll(before, "\r\n", "\n"), "\n")
	afterLines := strings.Split(strings.ReplaceAll(after, "\r\n", "\n"), "\n")
	lines := []string{"--- a/" + label, "+++ b/" + label}
	maxLines := len(beforeLines)
	if len(afterLines) > maxLines {
		maxLines = len(afterLines)
	}
	hunkOpen := false
	for index := 0; index < maxLines; index++ {
		var left, right string
		hasLeft, hasRight := index < len(beforeLines), index < len(afterLines)
		if hasLeft {
			left = beforeLines[index]
		}
		if hasRight {
			right = afterLines[index]
		}
		if hasLeft && hasRight && left == right {
			if hunkOpen {
				lines = append(lines, " "+left)
			}
			continue
		}
		if !hunkOpen {
			lines = append(lines, fmt.Sprintf("@@ line %d @@", index+1))
			hunkOpen = true
		}
		if hasLeft {
			lines = append(lines, "-"+left)
		}
		if hasRight {
			lines = append(lines, "+"+right)
		}
	}
	if len(lines) == 2 {
		return lines[0] + "\n" + lines[1] + "\n@@ unchanged @@\n"
	}
	return strings.Join(lines, "\n")
}

type assistantMoveNode struct {
	ID        int64
	ParentID  *int64
	SortOrder int32
}

func executeMoveArticle(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	articleID, err := requiredToolID(params["articleId"], "articleId")
	if err != nil {
		return nil, err
	}
	targetKnowledgeBaseID, err := requiredToolID(params["targetKnowledgeBaseId"], "targetKnowledgeBaseId")
	if err != nil {
		return nil, err
	}
	parentID, hasParent, err := optionalToolID(params, "parentId")
	if err != nil {
		return nil, err
	}
	var targetIndex *int
	if value, ok := params["targetIndex"]; ok {
		index := intValue(value)
		if index < 0 {
			return nil, rt.ValidationError("targetIndex 不能小于 0")
		}
		targetIndex = &index
	}

	tx, err := dbPool().Begin(toolContext(ctx))
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(toolContext(ctx))
	article, err := loadAssistantArticleForUpdate(tx, ctx, articleID, true)
	if err != nil {
		return nil, err
	}
	if _, err := kb.AssertKnowledgeBaseOwnerForAgent(tx, ctx.UserID, targetKnowledgeBaseID); err != nil {
		return nil, rt.ValidationError("目标知识库不存在或不属于当前用户")
	}
	if err := assertAssistantFolderParent(tx, ctx, targetKnowledgeBaseID, parentID, hasParent); err != nil {
		return nil, err
	}
	var sourceParentID *int64
	if err := tx.QueryRow(toolContext(ctx), `SELECT parent_id FROM petrichor_kb_node WHERE id=$1 AND user_id=$2 FOR UPDATE`, article.NodeID, ctx.UserID).Scan(&sourceParentID); err != nil {
		if err == pgx.ErrNoRows {
			return nil, rt.ValidationError("文章节点不存在")
		}
		return nil, err
	}
	crossKnowledgeBase := article.KnowledgeBaseID != targetKnowledgeBaseID
	sourceNodes, err := loadAssistantMoveNodes(tx, ctx, article.KnowledgeBaseID)
	if err != nil {
		return nil, err
	}
	targetNodes := sourceNodes
	if crossKnowledgeBase {
		targetNodes, err = loadAssistantMoveNodes(tx, ctx, targetKnowledgeBaseID)
		if err != nil {
			return nil, err
		}
	} else if hasParent && (parentID == article.NodeID || assistantNodeDescendsFrom(sourceNodes, article.NodeID, parentID)) {
		return nil, rt.ValidationError("不能把节点移动到自身或子文件夹中")
	}
	targetParent := nullableToolIDPtr(parentID, hasParent)
	sourceOrder := assistantSiblingIDs(sourceNodes, sourceParentID, article.NodeID, true)
	targetSiblingIDs := assistantSiblingIDs(targetNodes, targetParent, article.NodeID, false)
	targetOrder := insertAssistantNodeAt(targetSiblingIDs, article.NodeID, targetIndex)
	if !crossKnowledgeBase && sameAssistantParent(sourceParentID, targetParent) {
		sourceOrder = targetOrder
	}
	updatedAt := time.Now()
	if crossKnowledgeBase || !sameAssistantParent(sourceParentID, targetParent) {
		if err := rewriteAssistantSiblingOrders(tx, ctx, sourceOrder, 0, nil, nil, updatedAt); err != nil {
			return nil, err
		}
	}
	moveKnowledgeBaseID := (*int64)(nil)
	if crossKnowledgeBase {
		moveKnowledgeBaseID = &targetKnowledgeBaseID
	}
	if err := rewriteAssistantSiblingOrders(tx, ctx, targetOrder, article.NodeID, targetParent, moveKnowledgeBaseID, updatedAt); err != nil {
		return nil, err
	}
	if crossKnowledgeBase {
		updates := []struct {
			query string
			args  []any
		}{
			{`UPDATE petrichor_kb_article SET knowledge_base_id=$1,updated_at=$2 WHERE id=$3 AND user_id=$4`, []any{targetKnowledgeBaseID, updatedAt, article.ID, ctx.UserID}},
			{`UPDATE petrichor_kb_article_chunk SET knowledge_base_id=$1,updated_at=$2 WHERE article_id=$3 AND user_id=$4`, []any{targetKnowledgeBaseID, updatedAt, article.ID, ctx.UserID}},
			{`UPDATE petrichor_kb_article_chunk_index SET knowledge_base_id=$1,updated_at=$2 WHERE article_id=$3 AND user_id=$4`, []any{targetKnowledgeBaseID, updatedAt, article.ID, ctx.UserID}},
			{`UPDATE petrichor_kb_wiki_tree_node SET knowledge_base_id=$1,updated_at=$2 WHERE article_id=$3 AND user_id=$4`, []any{targetKnowledgeBaseID, updatedAt, article.ID, ctx.UserID}},
		}
		for _, update := range updates {
			if _, err := tx.Exec(toolContext(ctx), update.query, update.args...); err != nil {
				return nil, err
			}
		}
		var sourcePageID int64
		err := tx.QueryRow(toolContext(ctx), `
			UPDATE petrichor_kb_wiki_page SET knowledge_base_id=$1,updated_at=$2
			WHERE user_id=$3 AND knowledge_base_id=$4 AND page_key=$5 RETURNING id`,
			targetKnowledgeBaseID, updatedAt, ctx.UserID, article.KnowledgeBaseID, fmt.Sprintf("source-%d", article.ID)).Scan(&sourcePageID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, err
		}
		if sourcePageID > 0 {
			if _, err := tx.Exec(toolContext(ctx), `UPDATE petrichor_kb_wiki_link SET knowledge_base_id=$1 WHERE from_page_id=$2 AND user_id=$3`, targetKnowledgeBaseID, sourcePageID, ctx.UserID); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(toolContext(ctx)); err != nil {
		return nil, err
	}
	if crossKnowledgeBase || !sameAssistantParent(sourceParentID, targetParent) {
		kb.InvalidatePublicArticleCaches("")
	}
	return map[string]any{
		"articleId": idStr(article.ID), "nodeId": idStr(article.NodeID),
		"fromKnowledgeBaseId": idStr(article.KnowledgeBaseID), "knowledgeBaseId": idStr(targetKnowledgeBaseID),
		"parentId": nullableToolIDString(targetParent), "crossKnowledgeBase": crossKnowledgeBase,
		"href": articleHref(targetKnowledgeBaseID, article.ID),
	}, nil
}

func loadAssistantMoveNodes(q kb.Querier, ctx *rt.ToolExecutionContext, knowledgeBaseID int64) ([]assistantMoveNode, error) {
	rows, err := q.Query(toolContext(ctx), `SELECT id,parent_id,sort_order FROM petrichor_kb_node WHERE user_id=$1 AND knowledge_base_id=$2 ORDER BY sort_order,id`, ctx.UserID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := []assistantMoveNode{}
	for rows.Next() {
		var node assistantMoveNode
		if err := rows.Scan(&node.ID, &node.ParentID, &node.SortOrder); err != nil {
			return nil, err
		}
		nodes = append(nodes, node)
	}
	return nodes, rows.Err()
}

func assistantSiblingIDs(nodes []assistantMoveNode, parentID *int64, movingID int64, excludeMoving bool) []int64 {
	siblings := append([]assistantMoveNode{}, nodes...)
	sort.SliceStable(siblings, func(i, j int) bool {
		if siblings[i].SortOrder == siblings[j].SortOrder {
			return siblings[i].ID < siblings[j].ID
		}
		return siblings[i].SortOrder < siblings[j].SortOrder
	})
	ids := []int64{}
	for _, node := range siblings {
		if !sameAssistantParent(node.ParentID, parentID) || (excludeMoving && node.ID == movingID) {
			continue
		}
		ids = append(ids, node.ID)
	}
	return ids
}

func insertAssistantNodeAt(ids []int64, movingID int64, targetIndex *int) []int64 {
	withoutMoving := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id != movingID {
			withoutMoving = append(withoutMoving, id)
		}
	}
	index := len(withoutMoving)
	if targetIndex != nil {
		index = *targetIndex
		if index > len(withoutMoving) {
			index = len(withoutMoving)
		}
	}
	result := append([]int64{}, withoutMoving[:index]...)
	result = append(result, movingID)
	return append(result, withoutMoving[index:]...)
}

func rewriteAssistantSiblingOrders(q kb.Querier, ctx *rt.ToolExecutionContext, ids []int64, movingID int64, parentID, knowledgeBaseID *int64, updatedAt time.Time) error {
	for index, id := range ids {
		if id == movingID {
			if knowledgeBaseID != nil {
				if _, err := q.Exec(toolContext(ctx), `UPDATE petrichor_kb_node SET knowledge_base_id=$1,parent_id=$2,sort_order=$3,updated_at=$4 WHERE id=$5 AND user_id=$6`, *knowledgeBaseID, parentID, index+1, updatedAt, id, ctx.UserID); err != nil {
					return err
				}
			} else if _, err := q.Exec(toolContext(ctx), `UPDATE petrichor_kb_node SET parent_id=$1,sort_order=$2,updated_at=$3 WHERE id=$4 AND user_id=$5`, parentID, index+1, updatedAt, id, ctx.UserID); err != nil {
				return err
			}
			continue
		}
		if _, err := q.Exec(toolContext(ctx), `UPDATE petrichor_kb_node SET sort_order=$1,updated_at=$2 WHERE id=$3 AND user_id=$4`, index+1, updatedAt, id, ctx.UserID); err != nil {
			return err
		}
	}
	return nil
}

func assistantNodeDescendsFrom(nodes []assistantMoveNode, ancestorID, nodeID int64) bool {
	parents := map[int64]*int64{}
	for _, node := range nodes {
		parents[node.ID] = node.ParentID
	}
	seen := map[int64]bool{}
	current := &nodeID
	for current != nil && !seen[*current] {
		seen[*current] = true
		if *current == ancestorID {
			return true
		}
		current = parents[*current]
	}
	return false
}

func sameAssistantParent(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func executeCreateArticleShare(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	articleID, err := requiredToolID(params["articleId"], "articleId")
	if err != nil {
		return nil, err
	}
	article, err := loadAssistantArticleForUpdate(dbPool(), ctx, articleID, false)
	if err != nil {
		return nil, err
	}
	candidateCode, err := newAssistantShareCode()
	if err != nil {
		return nil, err
	}
	var shareCode string
	err = dbPool().QueryRow(toolContext(ctx), `
		INSERT INTO petrichor_kb_article_share (user_id,article_id,share_code,enabled)
		VALUES ($1,$2,$3,true)
		ON CONFLICT (article_id) DO UPDATE SET
		 user_id=excluded.user_id,
		 share_code=CASE
		   WHEN petrichor_kb_article_share.enabled AND btrim(petrichor_kb_article_share.share_code)<>''
		   THEN petrichor_kb_article_share.share_code ELSE excluded.share_code END,
		 enabled=true,revoked_at=NULL,updated_at=now()
		RETURNING share_code`, ctx.UserID, articleID, candidateCode).Scan(&shareCode)
	if err != nil {
		return nil, err
	}
	// shareCode 可能在恢复分享时变化，清空详情前缀可避免并发下遗漏旧键。
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{
		"articleId": idStr(article.ID), "knowledgeBaseId": idStr(article.KnowledgeBaseID),
		"shareCode": shareCode, "shareUrl": "/p/" + shareCode, "enabled": true,
	}, nil
}

func newAssistantShareCode() (string, error) {
	buffer := make([]byte, 18)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func normalizeArticleWrite(prefix string) rt.ToolNormalizer {
	return func(output any, _ any) rt.ToolNormalizerResult {
		raw, _ := json.Marshal(output)
		var result map[string]any
		_ = json.Unmarshal(raw, &result)
		title := strings.TrimSpace(stringValue(result["title"]))
		summary := prefix
		if title != "" {
			summary += "「" + title + "」"
		}
		return rt.ToolNormalizerResult{Summary: summary, Data: mustJSON(output), Progress: boolPtr(true)}
	}
}

func normalizeArticlePreview(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var result struct {
		Changed bool   `json:"changed"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &result)
	summary := result.Message
	if summary == "" {
		summary = "已生成文章更新预览"
	}
	return rt.ToolNormalizerResult{Summary: summary, Data: mustJSON(output), Progress: boolPtr(result.Changed)}
}

func nullableToolID(id int64, valid bool) any {
	if !valid {
		return nil
	}
	return id
}

func nullableToolIDPtr(id int64, valid bool) *int64 {
	if !valid {
		return nil
	}
	return &id
}

func nullableToolIDString(id *int64) any {
	if id == nil {
		return nil
	}
	return idStr(*id)
}
