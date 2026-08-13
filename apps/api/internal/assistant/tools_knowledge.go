package assistant

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/kb"
)

func registerKnowledgeTools() {
	registerTools([]ToolRegistration{
		{Name: "list_knowledge_bases", Domain: DomainKnowledge, Risk: RiskRead, Description: "列出当前用户拥有的知识库。", Factory: newListKnowledgeBasesTool},
		{Name: "search_knowledge", Domain: DomainKnowledge, Risk: RiskRead, Description: "混合检索知识库文件分片、Wiki 页面与文章。", Factory: newSearchKnowledgeTool},
		{Name: "read_knowledge_node", Domain: DomainKnowledge, Risk: RiskRead, Description: "读取文件分片、Wiki 页面或知识文章正文。", Factory: newReadKnowledgeNodeTool},
	})
}

func newListKnowledgeBasesTool() tool.InvokableTool {
	t, err := utils.InferTool("list_knowledge_bases", "列出当前用户拥有的知识库。", func(ctx context.Context, _ *struct{}) ([]map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		rows, err := client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(userID)).Order(ent.Asc(knowledgebase.FieldName)).All(ctx)
		if err != nil {
			return nil, err
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, map[string]any{
				"id": fmt.Sprintf("%d", row.ID), "name": row.Name, "description": row.Description,
			})
		}
		return items, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type searchKnowledgeInput struct {
	Query           string       `json:"query" jsonschema:"description=检索关键词"`
	KnowledgeBaseID *assistantID `json:"knowledgeBaseId,omitempty"`
	Limit           *int         `json:"limit,omitempty"`
}

type assistantCrossKnowledgeHit struct {
	payload  map[string]any
	score    int
	updated  time.Time
	dedupeID string
}

func assistantSearchScore(title, summary, content, query string) int {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return 1
	}
	terms := strings.Fields(query)
	if len(terms) == 0 {
		terms = []string{query}
	}
	score := 0
	fields := []struct {
		value  string
		weight int
	}{{title, 8}, {summary, 4}, {content, 1}}
	for _, field := range fields {
		value := strings.ToLower(field.value)
		if strings.Contains(value, query) {
			score += field.weight * 4
		}
		for _, term := range terms {
			if strings.Contains(value, term) {
				score += field.weight
			}
		}
	}
	return score
}

func assistantExcerpt(summary *string, content string) string {
	if summary != nil && strings.TrimSpace(*summary) != "" {
		return strings.TrimSpace(*summary)
	}
	plain := strings.Join(strings.Fields(content), " ")
	runes := []rune(plain)
	if len(runes) > 180 {
		return string(runes[:180]) + "…"
	}
	return plain
}

func searchKnowledgeAcrossLibraries(ctx context.Context, client *ent.Client, runtime *Runtime, userID int64, query string, limit int) (map[string]any, error) {
	kbRows, err := client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(userID)).All(ctx)
	if err != nil {
		return nil, err
	}
	kbNames := make(map[int64]string, len(kbRows))
	for _, row := range kbRows {
		kbNames[row.ID] = row.Name
	}
	pages, err := client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.ArchivedAtIsNil(),
	).Order(ent.Desc(kbwikipage.FieldUpdatedAt)).Limit(500).All(ctx)
	if err != nil {
		return nil, err
	}
	articles, err := client.KBArticle.Query().Where(kbarticle.UserIDEQ(userID)).
		Order(ent.Desc(kbarticle.FieldUpdatedAt)).Limit(500).All(ctx)
	if err != nil {
		return nil, err
	}
	byKey := map[string]assistantCrossKnowledgeHit{}
	put := func(hit assistantCrossKnowledgeHit) {
		if existing, ok := byKey[hit.dedupeID]; !ok || hit.score > existing.score || (hit.score == existing.score && hit.updated.After(existing.updated)) {
			byKey[hit.dedupeID] = hit
		}
	}
	if runtime != nil {
		kbSvc := kb.NewService(client, runtime.sql, runtime.log, runtime.cfg)
		chunkHits, chunkErr := kbSvc.SearchDocumentChunks(ctx, userID, nil, query, limit)
		if chunkErr == nil {
			for _, hit := range chunkHits {
				put(assistantCrossKnowledgeHit{
					dedupeID: "chunk:" + hit.DocumentID + ":" + hit.ChunkID, score: int(hit.Score * 100), updated: time.Now(),
					payload: map[string]any{
						"kind": "document_chunk", "knowledgeBaseId": hit.KnowledgeBaseID,
						"knowledgeBaseName": hit.KnowledgeBaseName, "documentId": hit.DocumentID,
						"chunkIndex": hit.ChunkIndex, "page": hit.Page, "locator": hit.Locator,
						"href":  fmt.Sprintf("/dashboard/knowledge/%s/documents/%s?chunk=%d", hit.KnowledgeBaseID, hit.DocumentID, hit.ChunkIndex),
						"title": hit.DocumentTitle, "snippet": hit.Text, "sources": hit.Sources,
					},
				})
			}
		}
	}
	for _, page := range pages {
		summary := assistantExcerpt(page.Summary, page.ContentMd)
		score := assistantSearchScore(page.Title, summary, page.ContentMd, query)
		if score <= 0 {
			continue
		}
		dedupe := fmt.Sprintf("page:%d:%s", page.KnowledgeBaseID, page.PageKey)
		put(assistantCrossKnowledgeHit{
			dedupeID: dedupe, score: score, updated: page.UpdatedAt,
			payload: map[string]any{
				"knowledgeBaseId":   fmt.Sprintf("%d", page.KnowledgeBaseID),
				"knowledgeBaseName": kbNames[page.KnowledgeBaseID], "pageKey": page.PageKey,
				"articleId": nil, "href": assistantKnowledgeBasePath(page.KnowledgeBaseID), "title": page.Title, "snippet": summary,
			},
		})
	}
	for _, article := range articles {
		summary := assistantExcerpt(article.AiSummary, article.ContentMd)
		if strings.TrimSpace(summary) == "" {
			summary = assistantExcerpt(article.PublicExcerpt, article.ContentMd)
		}
		score := assistantSearchScore(article.Title, summary, article.ContentMd, query)
		if score <= 0 {
			continue
		}
		id := fmt.Sprintf("%d", article.ID)
		put(assistantCrossKnowledgeHit{
			dedupeID: fmt.Sprintf("article:%d:%d", article.KnowledgeBaseID, article.ID),
			score:    score, updated: article.UpdatedAt,
			payload: map[string]any{
				"knowledgeBaseId":   fmt.Sprintf("%d", article.KnowledgeBaseID),
				"knowledgeBaseName": kbNames[article.KnowledgeBaseID], "pageKey": nil,
				"articleId": id, "href": assistantArticlePath(article.KnowledgeBaseID, article.ID),
				"title": article.Title, "snippet": summary,
			},
		})
	}
	hits := make([]assistantCrossKnowledgeHit, 0, len(byKey))
	for _, hit := range byKey {
		hits = append(hits, hit)
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].updated.After(hits[j].updated)
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		out = append(out, hit.payload)
	}
	return map[string]any{"mode": "cross_kb", "hits": out}, nil
}

func mustPositiveID(raw string) int64 {
	id, _ := parsePositiveID(raw, "id")
	return id
}

func assistantKnowledgeBasePath(knowledgeBaseID int64) string {
	return fmt.Sprintf("/dashboard/knowledge/%d", knowledgeBaseID)
}

func newSearchKnowledgeTool() tool.InvokableTool {
	t, err := utils.InferTool("search_knowledge", "检索用户知识库文章。", func(ctx context.Context, input *searchKnowledgeInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		query := strings.TrimSpace(input.Query)
		if query == "" || len([]rune(query)) > 200 {
			return nil, fmt.Errorf("query 不能为空且不能超过 200 个字符")
		}
		limit := 8
		if input.Limit != nil {
			limit = *input.Limit
		}
		if limit < 1 || limit > 12 {
			return nil, fmt.Errorf("limit 必须在 1 到 12 之间")
		}
		kbID := int64(0)
		if input.KnowledgeBaseID != nil {
			kbID, err = parsePositiveID(string(*input.KnowledgeBaseID), "knowledgeBaseId")
			if err != nil {
				return nil, err
			}
		} else if focus := focusFrom(ctx); focus != nil {
			if id, ok := focusID(focus.KnowledgeBaseID); ok {
				kbID = id
			}
		}
		runtime := runtimeFrom(ctx)
		if runtime == nil {
			return nil, fmt.Errorf("缺少 Assistant Runtime")
		}
		if kbID <= 0 {
			return searchKnowledgeAcrossLibraries(ctx, client, runtime, userID, query, limit)
		}
		kbSvc := kb.NewService(client, runtime.sql, runtime.log, runtime.cfg)
		documentHits, err := kbSvc.SearchDocumentChunks(ctx, userID, &kbID, query, limit)
		if err != nil {
			return nil, err
		}
		wikiHits, err := kbSvc.SearchAgentWikiPages(ctx, userID, &kbID, query, limit)
		if err != nil {
			return nil, err
		}
		merged := make([]map[string]any, 0, limit)
		seen := map[string]bool{}
		for _, hit := range documentHits {
			key := "document:" + hit.DocumentID + ":" + hit.ChunkID
			seen[key] = true
			merged = append(merged, map[string]any{
				"kind": "document_chunk", "knowledgeBaseId": hit.KnowledgeBaseID,
				"documentId": hit.DocumentID, "chunkIndex": hit.ChunkIndex, "page": hit.Page, "locator": hit.Locator,
				"href":  fmt.Sprintf("/dashboard/knowledge/%d/documents/%s?chunk=%d", kbID, hit.DocumentID, hit.ChunkIndex),
				"title": hit.DocumentTitle, "snippet": hit.Text, "sources": hit.Sources,
			})
			if len(merged) >= limit {
				break
			}
		}
		for _, hit := range wikiHits {
			if len(merged) >= limit {
				break
			}
			key := "wiki:" + hit.PageKey
			if seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, map[string]any{
				"kind": "wiki_page", "knowledgeBaseId": fmt.Sprintf("%d", kbID), "pageKey": hit.PageKey,
				"articleId": nil, "href": assistantKnowledgeBasePath(kbID),
				"title": hit.Title, "snippet": hit.Summary,
			})
			if len(merged) >= limit {
				break
			}
		}
		kbRow, err := client.KnowledgeBase.Query().Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"mode": "document+wiki", "knowledgeBaseId": fmt.Sprintf("%d", kbID),
			"knowledgeBaseName": kbRow.Name, "hits": merged,
		}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type readKnowledgeNodeInput struct {
	ArticleID       *assistantID `json:"articleId,omitempty"`
	KnowledgeBaseID *assistantID `json:"knowledgeBaseId,omitempty"`
	PageKey         *string      `json:"pageKey,omitempty"`
	DocumentID      *assistantID `json:"documentId,omitempty"`
	ChunkIndex      *int         `json:"chunkIndex,omitempty"`
}

func newReadKnowledgeNodeTool() tool.InvokableTool {
	t, err := utils.InferTool("read_knowledge_node", "按 articleId 读取知识库文章正文。", func(ctx context.Context, input *readKnowledgeNodeInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		var kbID int64
		if input.KnowledgeBaseID != nil {
			kbID, err = parsePositiveID(string(*input.KnowledgeBaseID), "knowledgeBaseId")
			if err != nil {
				return nil, err
			}
		} else if focus := focusFrom(ctx); focus != nil {
			if id, ok := focusID(focus.KnowledgeBaseID); ok {
				kbID = id
			}
		}
		if kbID <= 0 {
			return nil, fmt.Errorf("缺少 knowledgeBaseId：请把 search_knowledge 命中项的 knowledgeBaseId 一并传入")
		}
		addressCount := 0
		if input.PageKey != nil && strings.TrimSpace(*input.PageKey) != "" {
			addressCount++
		}
		if input.ArticleID != nil && strings.TrimSpace(string(*input.ArticleID)) != "" {
			addressCount++
		}
		if input.DocumentID != nil && strings.TrimSpace(string(*input.DocumentID)) != "" {
			addressCount++
		}
		if addressCount != 1 {
			return nil, fmt.Errorf("pageKey、articleId、documentId 必须且只能提供一个")
		}
		runtime := runtimeFrom(ctx)
		if runtime == nil {
			return nil, fmt.Errorf("缺少 Assistant Runtime")
		}
		kbSvc := kb.NewService(client, runtime.sql, runtime.log, runtime.cfg)
		if input.DocumentID != nil {
			documentID, parseErr := parsePositiveID(string(*input.DocumentID), "documentId")
			if parseErr != nil {
				return nil, parseErr
			}
			chunkIndex := 0
			if input.ChunkIndex != nil {
				chunkIndex = *input.ChunkIndex
			}
			return kbSvc.LoadDocumentChunkForAgent(ctx, userID, kbID, documentID, chunkIndex, 1)
		}
		if input.PageKey != nil && strings.TrimSpace(*input.PageKey) != "" {
			result, err := kbSvc.LoadWikiPageDetailForAgent(ctx, userID, kbID, *input.PageKey)
			if err != nil {
				return nil, err
			}
			media, err := kbSvc.LoadWikiPageMediaForAgent(ctx, userID, kbID, result)
			if err != nil {
				return nil, err
			}
			pageKind := result["kind"]
			result["kind"] = "wiki_page"
			result["pageKind"] = pageKind
			result["articleId"] = nil
			result["href"] = assistantKnowledgeBasePath(kbID)
			result["media"] = media
			return result, nil
		}
		articleID, err := parsePositiveID(string(*input.ArticleID), "articleId")
		if err != nil {
			return nil, err
		}
		row, err := client.KBArticle.Query().Where(
			kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID), kbarticle.KnowledgeBaseIDEQ(kbID),
		).Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return nil, fmt.Errorf("源文档不存在")
			}
			return nil, err
		}
		articleIDText := fmt.Sprintf("%d", row.ID)
		return map[string]any{
			"kind": "article", "knowledgeBaseId": fmt.Sprintf("%d", kbID),
			"articleId": articleIDText, "href": assistantArticlePath(kbID, row.ID),
			"title": row.Title, "contentMd": row.ContentMd,
			"media":     kb.ExtractAgentMediaReferences(row.ContentMd, &articleIDText, &row.Title),
			"updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

// 保留 article 创建/更新 direct helpers 供确认执行复用。
func createArticleDirect(ctx context.Context, client *ent.Client, userID int64, kbID int64, title, contentMd string, parentID *int64) (map[string]any, error) {
	exists, err := client.KnowledgeBase.Query().Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("知识库不存在")
	}
	if parentID != nil {
		validParent, err := client.KBNode.Query().Where(
			kbnode.IDEQ(*parentID), kbnode.UserIDEQ(userID),
			kbnode.KnowledgeBaseIDEQ(kbID), kbnode.TypeEQ("FOLDER"),
		).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !validParent {
			return nil, fmt.Errorf("父节点不存在或不属于该知识库")
		}
	}
	query := client.KBNode.Query().Where(kbnode.UserIDEQ(userID), kbnode.KnowledgeBaseIDEQ(kbID))
	if parentID == nil {
		query = query.Where(kbnode.ParentIDIsNil())
	} else {
		query = query.Where(kbnode.ParentIDEQ(*parentID))
	}
	sortOrder := 1
	last, err := query.Order(ent.Desc(kbnode.FieldSortOrder), ent.Desc(kbnode.FieldID)).First(ctx)
	if err == nil {
		sortOrder = last.SortOrder + 1
	} else if !ent.IsNotFound(err) {
		return nil, err
	}
	metadata := kb.DerivePublicArticleMetadata(contentMd)
	tx, err := client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	nb := tx.KBNode.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).SetType("ARTICLE").SetName(title).SetSortOrder(sortOrder)
	if parentID != nil && *parentID > 0 {
		nb.SetParentID(*parentID)
	}
	node, err := nb.Save(ctx)
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	article, err := tx.KBArticle.Create().
		SetUserID(userID).SetKnowledgeBaseID(kbID).SetNodeID(node.ID).
		SetTitle(title).SetContentMd(contentMd).
		SetPublicExcerpt(metadata.Excerpt).SetReadingMinutes(metadata.ReadingMinutes).
		SetTocJSON(metadata.TOCJSON).SetPublicContentHash(metadata.ContentHash).
		Save(ctx)
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{
		"articleId": fmt.Sprintf("%d", article.ID), "nodeId": fmt.Sprintf("%d", node.ID),
		"title": article.Title, "href": assistantArticlePath(kbID, article.ID),
	}, nil
}

func updateArticleDirect(ctx context.Context, client *ent.Client, userID, articleID int64, title, contentMd *string) (map[string]any, error) {
	article, err := client.KBArticle.Query().Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, fmt.Errorf("文章不存在")
		}
		return nil, err
	}
	nextTitle := article.Title
	if title != nil {
		nextTitle = strings.TrimSpace(*title)
	}
	nextContent := article.ContentMd
	if contentMd != nil {
		nextContent = *contentMd
	}
	metadata := kb.DerivePublicArticleMetadata(nextContent)
	tx, err := client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.KBArticle.Update().Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).
		SetTitle(nextTitle).SetContentMd(nextContent).
		SetPublicExcerpt(metadata.Excerpt).SetReadingMinutes(metadata.ReadingMinutes).
		SetTocJSON(metadata.TOCJSON).SetPublicContentHash(metadata.ContentHash).
		Save(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if title != nil {
		if _, err := tx.KBNode.Update().Where(kbnode.IDEQ(article.NodeID), kbnode.UserIDEQ(userID)).SetName(nextTitle).Save(ctx); err != nil {
			_ = tx.Rollback()
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{
		"articleId": fmt.Sprintf("%d", articleID), "title": nextTitle,
		"href": assistantArticlePath(article.KnowledgeBaseID, articleID),
	}, nil
}

func deleteArticleDirect(ctx context.Context, client *ent.Client, userID, articleID int64) (map[string]any, error) {
	article, err := client.KBArticle.Query().Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.KBArticleTag.Delete().Where(kbarticletag.ArticleIDEQ(articleID)).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if _, err := tx.KBArticleShare.Delete().Where(kbarticleshare.ArticleIDEQ(articleID)).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if _, err := tx.KBArticle.Delete().Where(kbarticle.IDEQ(articleID)).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if _, err := tx.KBNode.Delete().Where(kbnode.IDEQ(article.NodeID)).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"articleId": fmt.Sprintf("%d", articleID), "deleted": true}, nil
}
