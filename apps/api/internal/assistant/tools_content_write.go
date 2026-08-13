package assistant

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/agentapikey"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantconfirmation"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikidocumentref"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/ent/siteappearance"
	"github.com/Ciao1019/Petrichor/apps/api/internal/crypto"
	"github.com/Ciao1019/Petrichor/apps/api/internal/kb"
)

func registerContentWriteTools() {
	registerTools([]ToolRegistration{
		{Name: "request_user_confirmation", Domain: DomainContentWrite, Risk: RiskRead, Description: "对危险操作发起用户确认。", Factory: newRequestUserConfirmationTool},
		{Name: "preview_article_update", Domain: DomainContentWrite, Risk: RiskRead, Description: "预览文章更新 diff，不落库。", Factory: newPreviewArticleUpdateTool},
		{Name: "create_article", Domain: DomainContentWrite, Risk: RiskWrite, Description: "创建文章。", Factory: newCreateArticleTool},
		{Name: "update_article", Domain: DomainContentWrite, Risk: RiskWrite, Description: "更新文章。", Factory: newUpdateArticleTool},
		{Name: "create_article_share", Domain: DomainContentWrite, Risk: RiskWrite, Description: "开启文章公开分享。", Factory: newCreateArticleShareTool},
		{Name: "move_article", Domain: DomainContentWrite, Risk: RiskWrite, Description: "移动文章到目标知识库。", Factory: newMoveArticleTool},
		{Name: "delete_article", Domain: DomainContentWrite, Risk: RiskDangerous, Description: "删除文章（危险）。", Factory: newDeleteArticleTool},
		{Name: "revoke_article_share", Domain: DomainContentWrite, Risk: RiskDangerous, Description: "撤销文章分享（危险）。", Factory: newRevokeArticleShareTool},
		{Name: "delete_document", Domain: DomainContentWrite, Risk: RiskDangerous, Description: "删除文档（危险）。", Factory: newDeleteDocumentTool},
	})
}

type createArticleInput struct {
	KnowledgeBaseID assistantID  `json:"knowledgeBaseId"`
	Title           string       `json:"title"`
	ContentMd       string       `json:"contentMd,omitempty"`
	ParentID        *assistantID `json:"parentId,omitempty"`
}

func newCreateArticleTool() tool.InvokableTool {
	t, err := utils.InferTool("create_article", "创建文章。", func(ctx context.Context, input *createArticleInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		kbID, err := parsePositiveID(string(input.KnowledgeBaseID), "knowledgeBaseId")
		if err != nil {
			return nil, err
		}
		title := strings.TrimSpace(input.Title)
		if title == "" || len([]rune(title)) > 200 {
			return nil, fmt.Errorf("title 不能为空且不能超过 200 个字符")
		}
		var parentID *int64
		if input.ParentID != nil {
			id, err := parsePositiveID(string(*input.ParentID), "parentId")
			if err != nil {
				return nil, err
			}
			parentID = &id
		}
		return createArticleDirect(ctx, client, userID, kbID, title, input.ContentMd, parentID)
	})
	if err != nil {
		panic(err)
	}
	return t
}

type updateArticleInput struct {
	ArticleID assistantID `json:"articleId"`
	Title     *string     `json:"title,omitempty"`
	ContentMd *string     `json:"contentMd,omitempty"`
}

func newPreviewArticleUpdateTool() tool.InvokableTool {
	t, err := utils.InferTool("preview_article_update", "预览更新。", func(ctx context.Context, input *updateArticleInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		row, err := client.KBArticle.Query().Where(kbarticle.IDEQ(id), kbarticle.UserIDEQ(userID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		nextTitle := row.Title
		if input.Title != nil {
			nextTitle = strings.TrimSpace(*input.Title)
			if nextTitle == "" || len([]rune(nextTitle)) > 200 {
				return nil, fmt.Errorf("title 不能为空且不能超过 200 个字符")
			}
		}
		nextContent := row.ContentMd
		if input.ContentMd != nil {
			nextContent = *input.ContentMd
		}
		titleChanged := input.Title != nil && nextTitle != row.Title
		contentChanged := input.ContentMd != nil && nextContent != row.ContentMd
		if !titleChanged && !contentChanged {
			return map[string]any{
				"ok": true, "dryRun": true, "articleId": fmt.Sprintf("%d", id),
				"changed": false, "message": "与当前内容相同，无需更新",
			}, nil
		}
		var contentDiff any
		if contentChanged {
			contentDiff = buildUnifiedDiff(row.ContentMd, nextContent, "content.md")
		}
		return map[string]any{
			"ok": true, "dryRun": true, "articleId": fmt.Sprintf("%d", id), "changed": true,
			"title":       map[string]any{"before": row.Title, "after": nextTitle, "changed": titleChanged},
			"contentDiff": contentDiff,
			"contentStats": map[string]any{
				"beforeChars": len([]rune(row.ContentMd)), "afterChars": len([]rune(nextContent)),
			},
			"href":    assistantArticlePath(row.KnowledgeBaseID, row.ID),
			"message": "预览未落库；确认后请调用 update_article",
		}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func newUpdateArticleTool() tool.InvokableTool {
	t, err := utils.InferTool("update_article", "更新文章。", func(ctx context.Context, input *updateArticleInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		if input.Title == nil && input.ContentMd == nil {
			return nil, fmt.Errorf("至少提供 title 或 contentMd")
		}
		if input.Title != nil {
			title := strings.TrimSpace(*input.Title)
			if title == "" || len([]rune(title)) > 200 {
				return nil, fmt.Errorf("title 不能为空且不能超过 200 个字符")
			}
		}
		return updateArticleDirect(ctx, client, userID, id, input.Title, input.ContentMd)
	})
	if err != nil {
		panic(err)
	}
	return t
}

type articleIDInput struct {
	ArticleID assistantID `json:"articleId"`
}

func newCreateArticleShareTool() tool.InvokableTool {
	t, err := utils.InferTool("create_article_share", "开启分享。", func(ctx context.Context, input *articleIDInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		articleID, err := parsePositiveID(string(input.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		_, err = client.KBArticle.Query().Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).Only(ctx)
		if err != nil {
			return nil, fmt.Errorf("文章不存在")
		}
		existing, err := client.KBArticleShare.Query().Where(kbarticleshare.ArticleIDEQ(articleID)).Only(ctx)
		if ent.IsNotFound(err) {
			code, err := generateAssistantShareCode()
			if err != nil {
				return nil, err
			}
			row, err := client.KBArticleShare.Create().SetUserID(userID).SetArticleID(articleID).SetShareCode(code).SetEnabled(true).Save(ctx)
			if err != nil {
				return nil, err
			}
			return assistantShareResult(fmt.Sprintf("%d", articleID), row.ShareCode), nil
		}
		if err != nil {
			return nil, err
		}
		code := strings.TrimSpace(existing.ShareCode)
		if !existing.Enabled || code == "" {
			code, err = generateAssistantShareCode()
			if err != nil {
				return nil, err
			}
		}
		row, err := existing.Update().SetShareCode(code).SetEnabled(true).ClearRevokedAt().Save(ctx)
		if err != nil {
			return nil, err
		}
		return assistantShareResult(fmt.Sprintf("%d", articleID), row.ShareCode), nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type moveArticleInput struct {
	ArticleID             assistantID  `json:"articleId"`
	TargetKnowledgeBaseID assistantID  `json:"targetKnowledgeBaseId"`
	ParentID              *assistantID `json:"parentId,omitempty"`
	TargetIndex           *int         `json:"targetIndex,omitempty"`
}

func newMoveArticleTool() tool.InvokableTool {
	t, err := utils.InferTool("move_article", "移动文章。", func(ctx context.Context, input *moveArticleInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		articleID, err := parsePositiveID(string(input.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		targetKbID, err := parsePositiveID(string(input.TargetKnowledgeBaseID), "targetKnowledgeBaseId")
		if err != nil {
			return nil, err
		}
		if input.TargetIndex != nil && *input.TargetIndex < 0 {
			return nil, fmt.Errorf("targetIndex 不能小于 0")
		}
		var parentID *int64
		if input.ParentID != nil {
			id, err := parsePositiveID(string(*input.ParentID), "parentId")
			if err != nil {
				return nil, err
			}
			parentID = &id
		}
		return moveArticleDirect(ctx, client, userID, articleID, targetKbID, parentID, input.TargetIndex)
	})
	if err != nil {
		panic(err)
	}
	return t
}

func assistantArticlePath(knowledgeBaseID, articleID int64) string {
	return fmt.Sprintf("/dashboard/knowledge/%d/articles/%d", knowledgeBaseID, articleID)
}

func generateAssistantShareCode() (string, error) {
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return fmt.Sprintf("s%x%s", time.Now().UTC().UnixMilli(), hex.EncodeToString(raw)), nil
}

func assistantShareResult(articleID, shareCode string) map[string]any {
	return map[string]any{
		"articleId": articleID, "shareCode": shareCode,
		"shareUrl": "/p/" + shareCode, "enabled": true,
	}
}

// buildUnifiedDiff 保留旧版助手预览使用的轻量行级 diff 语义。
func buildUnifiedDiff(before, after, label string) string {
	left := strings.Split(strings.ReplaceAll(before, "\r\n", "\n"), "\n")
	right := strings.Split(strings.ReplaceAll(after, "\r\n", "\n"), "\n")
	lines := []string{"--- a/" + label, "+++ b/" + label}
	limit := max(len(left), len(right))
	hunkOpen := false
	for i := 0; i < limit; i++ {
		var a, b string
		hasA, hasB := i < len(left), i < len(right)
		if hasA {
			a = left[i]
		}
		if hasB {
			b = right[i]
		}
		if hasA && hasB && a == b {
			if hunkOpen {
				lines = append(lines, " "+a)
			}
			continue
		}
		if !hunkOpen {
			lines = append(lines, fmt.Sprintf("@@ line %d @@", i+1))
			hunkOpen = true
		}
		if hasA {
			lines = append(lines, "-"+a)
		}
		if hasB {
			lines = append(lines, "+"+b)
		}
	}
	if len(lines) == 2 {
		return strings.Join(lines, "\n") + "\n@@ unchanged @@\n"
	}
	return strings.Join(lines, "\n")
}

func assistantMoveNodeOrder(siblingIDs []int64, movingID int64, targetIndex *int) []int64 {
	ordered := make([]int64, 0, len(siblingIDs)+1)
	for _, id := range siblingIDs {
		if id != movingID {
			ordered = append(ordered, id)
		}
	}
	index := len(ordered)
	if targetIndex != nil {
		index = *targetIndex
		if index > len(ordered) {
			index = len(ordered)
		}
	}
	ordered = append(ordered, 0)
	copy(ordered[index+1:], ordered[index:])
	ordered[index] = movingID
	return ordered
}

func assistantSiblingIDs(nodes []*ent.KBNode, parentID *int64) []int64 {
	rows := make([]*ent.KBNode, 0)
	for _, node := range nodes {
		sameParent := parentID == nil && node.ParentID == nil
		if parentID != nil && node.ParentID != nil {
			sameParent = *parentID == *node.ParentID
		}
		if sameParent {
			rows = append(rows, node)
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].SortOrder != rows[j].SortOrder {
			return rows[i].SortOrder < rows[j].SortOrder
		}
		return rows[i].ID < rows[j].ID
	})
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func assistantIsDescendant(nodes []*ent.KBNode, ancestorID int64, candidateID *int64) bool {
	if candidateID == nil {
		return false
	}
	byID := make(map[int64]*ent.KBNode, len(nodes))
	for _, node := range nodes {
		byID[node.ID] = node
	}
	current := *candidateID
	visited := map[int64]bool{}
	for current > 0 && !visited[current] {
		if current == ancestorID {
			return true
		}
		visited[current] = true
		node := byID[current]
		if node == nil || node.ParentID == nil {
			return false
		}
		current = *node.ParentID
	}
	return false
}

func rewriteAssistantSiblingOrder(ctx context.Context, tx *ent.Tx, userID, movingID int64, ordered []int64, parentID *int64, knowledgeBaseID *int64) error {
	now := time.Now().UTC()
	for index, id := range ordered {
		update := tx.KBNode.Update().Where(kbnode.IDEQ(id), kbnode.UserIDEQ(userID)).SetSortOrder(index + 1).SetUpdatedAt(now)
		if id == movingID {
			if parentID == nil {
				update.ClearParentID()
			} else {
				update.SetParentID(*parentID)
			}
			if knowledgeBaseID != nil {
				update.SetKnowledgeBaseID(*knowledgeBaseID)
			}
		}
		if _, err := update.Save(ctx); err != nil {
			return err
		}
	}
	return nil
}

func moveArticleDirect(ctx context.Context, client *ent.Client, userID, articleID, targetKnowledgeBaseID int64, targetParentID *int64, targetIndex *int) (map[string]any, error) {
	article, err := client.KBArticle.Query().Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, fmt.Errorf("文章不存在")
		}
		return nil, err
	}
	exists, err := client.KnowledgeBase.Query().Where(knowledgebase.IDEQ(targetKnowledgeBaseID), knowledgebase.UserIDEQ(userID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("目标知识库不存在")
	}
	if targetParentID != nil {
		valid, err := client.KBNode.Query().Where(
			kbnode.IDEQ(*targetParentID), kbnode.UserIDEQ(userID),
			kbnode.KnowledgeBaseIDEQ(targetKnowledgeBaseID), kbnode.TypeEQ("FOLDER"),
		).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !valid {
			return nil, fmt.Errorf("父节点必须是目标知识库下的文件夹")
		}
	}
	node, err := client.KBNode.Query().Where(kbnode.IDEQ(article.NodeID), kbnode.UserIDEQ(userID)).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, fmt.Errorf("文章节点不存在")
		}
		return nil, err
	}
	sourceNodes, err := client.KBNode.Query().Where(kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(article.KnowledgeBaseID)).All(ctx)
	if err != nil {
		return nil, err
	}
	crossKnowledgeBase := article.KnowledgeBaseID != targetKnowledgeBaseID
	targetNodes := sourceNodes
	if crossKnowledgeBase {
		targetNodes, err = client.KBNode.Query().Where(kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(targetKnowledgeBaseID)).All(ctx)
		if err != nil {
			return nil, err
		}
	} else if targetParentID != nil && (*targetParentID == node.ID || assistantIsDescendant(sourceNodes, node.ID, targetParentID)) {
		return nil, fmt.Errorf("不能把节点移动到自身或子文件夹中")
	}

	sourceParentID := node.ParentID
	sourceOrder := assistantSiblingIDs(sourceNodes, sourceParentID)
	targetOrder := assistantMoveNodeOrder(assistantSiblingIDs(targetNodes, targetParentID), node.ID, targetIndex)
	sameParent := !crossKnowledgeBase && ((sourceParentID == nil && targetParentID == nil) ||
		(sourceParentID != nil && targetParentID != nil && *sourceParentID == *targetParentID))
	if sameParent {
		sourceOrder = targetOrder
	} else {
		filtered := sourceOrder[:0]
		for _, id := range sourceOrder {
			if id != node.ID {
				filtered = append(filtered, id)
			}
		}
		sourceOrder = filtered
	}

	tx, err := client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	rollback := func(err error) (map[string]any, error) {
		_ = tx.Rollback()
		return nil, err
	}
	if !sameParent {
		if err := rewriteAssistantSiblingOrder(ctx, tx, userID, node.ID, sourceOrder, sourceParentID, nil); err != nil {
			return rollback(err)
		}
	}
	var targetKnowledgeBaseUpdate *int64
	if crossKnowledgeBase {
		targetKnowledgeBaseUpdate = &targetKnowledgeBaseID
	}
	if err := rewriteAssistantSiblingOrder(ctx, tx, userID, node.ID, targetOrder, targetParentID, targetKnowledgeBaseUpdate); err != nil {
		return rollback(err)
	}
	if crossKnowledgeBase {
		now := time.Now().UTC()
		if _, err := tx.KBArticle.Update().Where(kbarticle.IDEQ(article.ID), kbarticle.UserIDEQ(userID)).
			SetKnowledgeBaseID(targetKnowledgeBaseID).SetUpdatedAt(now).Save(ctx); err != nil {
			return rollback(err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	var parent any
	if targetParentID != nil {
		parent = fmt.Sprintf("%d", *targetParentID)
	}
	return map[string]any{
		"articleId": fmt.Sprintf("%d", article.ID), "nodeId": fmt.Sprintf("%d", node.ID),
		"fromKnowledgeBaseId": fmt.Sprintf("%d", article.KnowledgeBaseID),
		"knowledgeBaseId":     fmt.Sprintf("%d", targetKnowledgeBaseID), "parentId": parent,
		"crossKnowledgeBase": crossKnowledgeBase,
		"href":               assistantArticlePath(targetKnowledgeBaseID, article.ID),
	}, nil
}

func newDeleteArticleTool() tool.InvokableTool {
	t, err := utils.InferTool("delete_article", "删除文章。", func(ctx context.Context, input *articleIDInput) (map[string]any, error) {
		if !confirmExecFrom(ctx) {
			return nil, fmt.Errorf("危险操作必须先通过 request_user_confirmation")
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		return deleteArticleDirect(ctx, client, userID, id)
	})
	if err != nil {
		panic(err)
	}
	return t
}

func newRevokeArticleShareTool() tool.InvokableTool {
	t, err := utils.InferTool("revoke_article_share", "撤销分享。", func(ctx context.Context, input *articleIDInput) (map[string]any, error) {
		if !confirmExecFrom(ctx) {
			return nil, fmt.Errorf("危险操作必须先通过 request_user_confirmation")
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		articleID, err := parsePositiveID(string(input.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		share, err := client.KBArticleShare.Query().Where(kbarticleshare.ArticleIDEQ(articleID), kbarticleshare.UserIDEQ(userID)).Only(ctx)
		if ent.IsNotFound(err) {
			return map[string]any{"articleId": fmt.Sprintf("%d", articleID), "revoked": false}, nil
		}
		if err != nil {
			return nil, err
		}
		now := time.Now().UTC()
		_, err = share.Update().SetEnabled(false).SetRevokedAt(now).Save(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"articleId": fmt.Sprintf("%d", articleID), "revoked": true}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type documentIDInput struct {
	DocumentID assistantID `json:"documentId"`
}

func newDeleteDocumentTool() tool.InvokableTool {
	t, err := utils.InferTool("delete_document", "删除文档。", func(ctx context.Context, input *documentIDInput) (map[string]any, error) {
		if !confirmExecFrom(ctx) {
			return nil, fmt.Errorf("危险操作必须先通过 request_user_confirmation")
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.DocumentID), "documentId")
		if err != nil {
			return nil, err
		}
		return deleteDocumentDirect(ctx, client, runtimeFrom(ctx), userID, id)
	})
	if err != nil {
		panic(err)
	}
	return t
}

func deleteDocumentDirect(ctx context.Context, client *ent.Client, runtime *Runtime, userID, documentID int64) (map[string]any, error) {
	doc, err := client.KBDocument.Query().Where(kbdocument.IDEQ(documentID), kbdocument.UserIDEQ(userID)).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, fmt.Errorf("文件不存在")
		}
		return nil, err
	}
	tx, err := client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.KBWikiDocumentRef.Delete().Where(kbwikidocumentref.DocumentIDEQ(documentID)).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if _, err := tx.KBDocumentChunk.Delete().Where(kbdocumentchunk.DocumentIDEQ(documentID)).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := tx.KBDocument.DeleteOneID(documentID).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	wikiCleanup := map[string]any{"rebuilt": false}
	if runtime != nil {
		kbSvc := kb.NewService(client, runtime.sql, runtime.log, runtime.cfg)
		if result, cleanupErr := kbSvc.CleanupWikiAfterDocumentDelete(ctx, userID, doc.KnowledgeBaseID); cleanupErr != nil {
			wikiCleanup["error"] = cleanupErr.Error()
		} else {
			wikiCleanup = result
		}
	}
	return map[string]any{
		"documentId": fmt.Sprintf("%d", documentID), "knowledgeBaseId": fmt.Sprintf("%d", doc.KnowledgeBaseID),
		"deleted": true, "wikiCleanup": wikiCleanup,
	}, nil
}

type confirmationAction struct {
	ToolName string         `json:"toolName"`
	Input    map[string]any `json:"input"`
}

type requestUserConfirmationInput struct {
	ID           string             `json:"id"`
	Title        string             `json:"title"`
	Description  string             `json:"description,omitempty"`
	Variant      string             `json:"variant,omitempty"`
	ConfirmLabel string             `json:"confirmLabel,omitempty"`
	Action       confirmationAction `json:"action"`
	Risk         string             `json:"risk,omitempty"`
}

func newRequestUserConfirmationTool() tool.InvokableTool {
	t, err := utils.InferTool("request_user_confirmation", "请求用户确认危险操作。", func(ctx context.Context, input *requestUserConfirmationInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		if err := assertConfirmationAction(input.Action.ToolName); err != nil {
			return nil, err
		}
		key := strings.TrimSpace(input.ID)
		if key == "" {
			return nil, fmt.Errorf("id 不能为空")
		}
		if strings.TrimSpace(input.Title) == "" {
			return nil, fmt.Errorf("title 不能为空")
		}
		if input.Variant != "" && input.Variant != "default" && input.Variant != "destructive" {
			return nil, fmt.Errorf("variant 必须是 default 或 destructive")
		}
		if input.Risk != "dangerous" {
			return nil, fmt.Errorf("risk 必须是 dangerous")
		}
		threadID := threadIDFrom(ctx)
		allowlisted, err := isToolInThreadDangerAllowlist(ctx, client, threadID, userID, input.Action.ToolName)
		if err != nil {
			return nil, err
		}
		if allowlisted {
			outcome, execErr := executeConfirmedDangerousAction(ctx, client, userID, input.Action)
			if execErr != nil {
				return nil, execErr
			}
			return map[string]any{
				"id":               key,
				"confirmationId":   key,
				"title":            input.Title,
				"description":      input.Description,
				"action":           input.Action,
				"autoApproved":     true,
				"confirmed":        true,
				"executionOutcome": outcome,
			}, nil
		}
		payload, err := json.Marshal(input.Action.Input)
		if err != nil {
			return nil, err
		}
		if err := issueAssistantConfirmation(ctx, client, key, threadID, userID, input.Action.ToolName, string(payload)); err != nil {
			return nil, err
		}
		result := map[string]any{
			"id": key, "title": input.Title, "action": input.Action, "risk": input.Risk,
		}
		if input.Description != "" {
			result["description"] = input.Description
		}
		if input.Variant != "" {
			result["variant"] = input.Variant
		}
		if input.ConfirmLabel != "" {
			result["confirmLabel"] = input.ConfirmLabel
		}
		return result, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

// issueAssistantConfirmation 与旧版 onConflictDoUpdate 契约一致：模型用同一 key
// 重提确认时覆盖服务端票据，并重新置为 pending。
func issueAssistantConfirmation(ctx context.Context, client *ent.Client, key string, threadID, userID int64, toolName, inputJSON string) error {
	refresh := func() (int, error) {
		return client.AssistantConfirmation.Update().
			Where(assistantconfirmation.ConfirmationKeyEQ(key)).
			SetThreadID(threadID).
			SetUserID(userID).
			SetToolName(toolName).
			SetInputJSON(inputJSON).
			SetStatus("pending").
			ClearConsumedAt().
			Save(ctx)
	}
	if updated, err := refresh(); err != nil {
		return err
	} else if updated > 0 {
		return nil
	}
	_, err := client.AssistantConfirmation.Create().
		SetConfirmationKey(key).
		SetThreadID(threadID).
		SetUserID(userID).
		SetToolName(toolName).
		SetInputJSON(inputJSON).
		SetStatus("pending").
		Save(ctx)
	if ent.IsConstraintError(err) {
		_, err = refresh()
	}
	return err
}

func executeConfirmedDangerousAction(ctx context.Context, client *ent.Client, userID int64, action confirmationAction) (map[string]any, error) {
	if err := assertConfirmationAction(action.ToolName); err != nil {
		return nil, err
	}
	toolCtx := withToolContext(ctx, ToolContext{
		UserID: userID, ThreadID: threadIDFrom(ctx),
		SystemRole: systemRoleFrom(ctx), ConfirmExec: true,
	}, client, cfgFrom(ctx))
	return executeStoredActionMap(toolCtx, client, userID, action)
}

func executeStoredActionMap(ctx context.Context, client *ent.Client, userID int64, action confirmationAction) (map[string]any, error) {
	raw, _ := json.Marshal(action.Input)
	switch action.ToolName {
	case "create_article":
		var in createArticleInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		kbID, err := parsePositiveID(string(in.KnowledgeBaseID), "knowledgeBaseId")
		if err != nil {
			return nil, err
		}
		var parentID *int64
		if in.ParentID != nil {
			id, err := parsePositiveID(string(*in.ParentID), "parentId")
			if err != nil {
				return nil, err
			}
			parentID = &id
		}
		return createArticleDirect(ctx, client, userID, kbID, in.Title, in.ContentMd, parentID)
	case "update_article":
		var in updateArticleInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(in.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		return updateArticleDirect(ctx, client, userID, id, in.Title, in.ContentMd)
	case "delete_article":
		var in articleIDInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(in.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		return deleteArticleDirect(ctx, client, userID, id)
	case "delete_document":
		var in documentIDInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(in.DocumentID), "documentId")
		if err != nil {
			return nil, err
		}
		return deleteDocumentDirect(ctx, client, runtimeFrom(ctx), userID, id)
	case "revoke_article_share":
		var in articleIDInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(in.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		share, err := client.KBArticleShare.Query().Where(kbarticleshare.ArticleIDEQ(id), kbarticleshare.UserIDEQ(userID)).Only(ctx)
		if ent.IsNotFound(err) {
			return map[string]any{"articleId": fmt.Sprintf("%d", id), "revoked": false}, nil
		}
		if err != nil {
			return nil, err
		}
		now := time.Now().UTC()
		if _, err := share.Update().SetEnabled(false).SetRevokedAt(now).Save(ctx); err != nil {
			return nil, err
		}
		return map[string]any{"articleId": fmt.Sprintf("%d", id), "revoked": true}, nil
	case "delete_ai_config":
		var in configIDInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(in.ConfigID), "configId")
		if err != nil {
			return nil, err
		}
		n, err := client.AIModelConfig.Delete().Where(aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(userID)).Exec(ctx)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, fmt.Errorf("配置不存在")
		}
		return map[string]any{"configId": fmt.Sprintf("%d", id), "deleted": true}, nil
	case "update_ai_config_credentials":
		var in updateCredentialsInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(in.ConfigID), "configId")
		if err != nil {
			return nil, err
		}
		cfg, err := client.AIModelConfig.Query().Where(aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(userID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		key := strings.TrimSpace(in.APIKey)
		if key == "" {
			return nil, fmt.Errorf("apiKey 不能为空")
		}
		c := cfgFrom(ctx)
		if c == nil || strings.TrimSpace(c.EncryptKey) == "" || strings.TrimSpace(c.EncryptSalt) == "" {
			return nil, fmt.Errorf("缺少 PETRICHOR_ENCRYPT_KEY/SALT，无法加密 API Key")
		}
		enc, err := crypto.EncryptText(c.EncryptKey, c.EncryptSalt, key)
		if err != nil {
			return nil, err
		}
		key = enc
		upd := cfg.Update().SetAPIKeyEnc(key)
		if in.Enabled != nil {
			upd.SetEnabled(*in.Enabled)
		}
		updated, err := upd.Save(ctx)
		if err != nil {
			return nil, err
		}
		return assistantAIConfigDTO(updated, cfgFrom(ctx))
	case "revoke_agent_api_key":
		var in apiKeyIDInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(in.APIKeyID), "apiKeyId")
		if err != nil {
			return nil, err
		}
		row, err := client.AgentAPIKey.Query().Where(
			agentapikey.IDEQ(id), agentapikey.UserIDEQ(userID), agentapikey.RevokedAtIsNil(),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, fmt.Errorf("API Key 不存在")
		}
		if err != nil {
			return nil, err
		}
		updated, err := row.Update().SetRevokedAt(time.Now().UTC()).Save(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"item": assistantAgentAPIKeyDTO(updated)}, nil
	case "set_public_qa_enabled":
		if !isSuperAdmin(systemRoleFrom(ctx)) {
			return nil, fmt.Errorf("仅超级管理员可执行")
		}
		var in setPublicQAInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		row, err := client.SiteAppearance.Query().Where(siteappearance.IDEQ(1)).Only(ctx)
		if ent.IsNotFound(err) {
			_, err = client.SiteAppearance.Create().SetID(1).SetPublicQaEnabled(in.Enabled).Save(ctx)
		} else if err == nil {
			_, err = row.Update().SetPublicQaEnabled(in.Enabled).Save(ctx)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"publicQaEnabled": in.Enabled}, nil
	default:
		return map[string]any{"executed": false, "toolName": action.ToolName}, nil
	}
}

func consumeConfirmedAction(ctx context.Context, client *ent.Client, userID, threadID int64, confirmationID string) (confirmationAction, map[string]any, error) {
	row, err := client.AssistantConfirmation.Query().
		Where(
			assistantconfirmation.ConfirmationKeyEQ(confirmationID),
			assistantconfirmation.UserIDEQ(userID),
			assistantconfirmation.ThreadIDEQ(threadID),
			assistantconfirmation.StatusEQ("pending"),
			assistantconfirmation.ConsumedAtIsNil(),
		).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return confirmationAction{}, nil, fmt.Errorf("确认票据不存在或已消费")
		}
		return confirmationAction{}, nil, err
	}
	now := time.Now().UTC()
	consumed, err := client.AssistantConfirmation.Update().
		Where(
			assistantconfirmation.IDEQ(row.ID),
			assistantconfirmation.ConfirmationKeyEQ(confirmationID),
			assistantconfirmation.UserIDEQ(userID),
			assistantconfirmation.ThreadIDEQ(threadID),
			assistantconfirmation.StatusEQ("pending"),
			assistantconfirmation.ConsumedAtIsNil(),
		).
		SetStatus("consumed").
		SetConsumedAt(now).
		Save(ctx)
	if err != nil {
		return confirmationAction{}, nil, err
	}
	if consumed != 1 {
		return confirmationAction{}, nil, fmt.Errorf("确认票据不存在或已消费")
	}

	// 新票据只保存 action.input；兼容迁移早期保存的 {action:{...}} 结构。
	action := confirmationAction{ToolName: row.ToolName}
	var payload struct {
		Action confirmationAction `json:"action"`
	}
	if err := json.Unmarshal([]byte(row.InputJSON), &payload); err != nil {
		return confirmationAction{}, nil, fmt.Errorf("确认票据参数损坏")
	}
	if payload.Action.ToolName != "" {
		action = payload.Action
	} else if err := json.Unmarshal([]byte(row.InputJSON), &action.Input); err != nil || action.Input == nil {
		return confirmationAction{}, nil, fmt.Errorf("确认票据参数无效")
	}
	if err := assertConfirmationAction(action.ToolName); err != nil {
		return confirmationAction{}, nil, err
	}
	outcome, execErr := executeConfirmedDangerousAction(ctx, client, userID, action)
	if execErr != nil {
		return action, nil, execErr
	}
	return action, outcome, nil
}
