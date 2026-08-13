package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type agentDocumentContext struct {
	Type              string
	KnowledgeBaseID   string
	KnowledgeBaseName string
	ArticleID         *string
	PageKey           *string
	Title             string
	Summary           string
	UpdatedAt         string
	ContentMd         string
	DocumentID        *string
	ChunkIndex        *int
	Page              *int
	Locator           *string
}

func (h *Handler) answerAgentDocuments(
	ctx context.Context,
	userID int64,
	configID, knowledgeBaseID *int64,
	question string,
	limit int,
) (gin.H, error) {
	contexts, err := h.loadAgentDocumentContexts(ctx, userID, knowledgeBaseID, question, limit)
	if err != nil {
		return nil, err
	}
	if len(contexts) == 0 {
		return gin.H{
			"answer": "未找到足够的文档依据回答这个问题。", "citations": []gin.H{},
			"usage": nil, "modelName": nil,
		}, nil
	}
	modelConfig, err := h.resolveAgentChatConfig(ctx, userID, configID)
	if err != nil {
		return nil, err
	}
	completion, err := h.gen.Chat(ctx, modelConfig, []ai.ChatMessage{
		{
			Role: "system",
			Content: strings.Join([]string{
				"你是 Petrichor 的外部文档问答接口。",
				"只基于用户提供的文档上下文回答。",
				"如果上下文不足，明确说明无法从现有文档确认。",
				"用中文回答，保持简洁，并在答案末尾列出依据标题。",
			}, "\n"),
		},
		{Role: "user", Content: buildAgentQAPrompt(question, contexts)},
	})
	if err != nil {
		return nil, err
	}
	citations := make([]gin.H, 0, len(contexts))
	for _, item := range contexts {
		var kbName any
		if strings.TrimSpace(item.KnowledgeBaseName) != "" {
			kbName = item.KnowledgeBaseName
		}
		citations = append(citations, gin.H{
			"type": item.Type, "knowledgeBaseId": item.KnowledgeBaseID,
			"knowledgeBaseName": kbName, "articleId": item.ArticleID, "pageKey": item.PageKey,
			"title": item.Title, "summary": item.Summary, "updatedAt": item.UpdatedAt,
			"documentId": item.DocumentID, "chunkIndex": item.ChunkIndex, "page": item.Page, "locator": item.Locator,
		})
	}
	return gin.H{
		"answer": completion.Content, "citations": citations, "modelName": completion.ModelName,
		"reasoning": completion.Reasoning, "usage": completion.Usage,
	}, nil
}

func (h *Handler) resolveAgentChatConfig(ctx context.Context, userID int64, configID *int64) (*ent.AIModelConfig, error) {
	if configID == nil {
		return ai.ResolveChatConfig(ctx, h.client, userID)
	}
	row, err := h.client.AIModelConfig.Query().Where(
		aimodelconfig.IDEQ(*configID), aimodelconfig.UserIDEQ(userID),
	).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("CHAT 配置不存在")
		}
		return nil, err
	}
	if row.ConfigType != "CHAT" {
		return nil, response.BadRequest("配置类型不是 CHAT")
	}
	if !row.Enabled {
		return nil, response.BadRequest("CHAT 配置未启用")
	}
	return row, nil
}

func (h *Handler) loadAgentDocumentContexts(
	ctx context.Context,
	userID int64,
	knowledgeBaseID *int64,
	question string,
	limit int,
) ([]agentDocumentContext, error) {
	chunkHits, err := h.kbSvc.SearchDocumentChunks(ctx, userID, knowledgeBaseID, question, limit)
	if err != nil {
		return nil, err
	}
	wikiHits, err := h.kbSvc.SearchAgentWikiPages(ctx, userID, knowledgeBaseID, question, limit)
	if err != nil {
		return nil, err
	}
	articleHits, err := h.searchAgentArticles(ctx, userID, knowledgeBaseID, question, limit)
	if err != nil {
		return nil, err
	}
	kbRows, err := h.client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(userID)).All(ctx)
	if err != nil {
		return nil, err
	}
	kbNames := make(map[int64]string, len(kbRows))
	for _, row := range kbRows {
		kbNames[row.ID] = row.Name
	}

	contexts := make([]agentDocumentContext, 0, limit)
	seen := make(map[string]bool)
	for _, hit := range chunkHits {
		documentID, chunkIndex := hit.DocumentID, hit.ChunkIndex
		contexts = append(contexts, agentDocumentContext{
			Type: "document_chunk", KnowledgeBaseID: hit.KnowledgeBaseID, KnowledgeBaseName: hit.KnowledgeBaseName,
			Title: hit.DocumentTitle, Summary: summarizeAgentMarkdown(hit.Text, 220), ContentMd: hit.Text,
			DocumentID: &documentID, ChunkIndex: &chunkIndex, Page: hit.Page, Locator: hit.Locator,
		})
		seen["chunk:"+hit.DocumentID+":"+hit.ChunkID] = true
		if len(contexts) >= limit {
			return contexts, nil
		}
	}
	for _, hit := range wikiHits {
		kbID, err := parseAgentID(hit.KnowledgeBaseID, "knowledgeBaseId")
		if err != nil {
			continue
		}
		key := fmt.Sprintf("wiki:%d:%s", kbID, hit.PageKey)
		if seen[key] {
			continue
		}
		page, err := h.client.KBWikiPage.Query().Where(
			kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID),
			kbwikipage.PageKeyEQ(hit.PageKey), kbwikipage.ArchivedAtIsNil(),
		).Only(ctx)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		pageKey := page.PageKey
		var articleID *string
		if text := strings.TrimSpace(fmt.Sprint(hit.ArticleID)); hit.ArticleID != nil && text != "" && text != "<nil>" {
			articleID = &text
		}
		contexts = append(contexts, agentDocumentContext{
			Type: "wiki", KnowledgeBaseID: fmt.Sprintf("%d", kbID), KnowledgeBaseName: kbNames[kbID],
			ArticleID: articleID, PageKey: &pageKey, Title: page.Title, Summary: hit.Summary,
			UpdatedAt: page.UpdatedAt.UTC().Format(timeRFC3339Nano), ContentMd: page.ContentMd,
		})
		seen[key] = true
		if len(contexts) >= limit {
			return contexts, nil
		}
	}
	for _, hit := range articleHits {
		key := "article:" + hit.KnowledgeBaseID + ":" + hit.ArticleID
		if seen[key] {
			continue
		}
		articleID, err := parseAgentID(hit.ArticleID, "articleId")
		if err != nil {
			continue
		}
		article, err := h.client.KBArticle.Query().Where(
			kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(userID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		articleIDText := fmt.Sprintf("%d", article.ID)
		contexts = append(contexts, agentDocumentContext{
			Type: "article", KnowledgeBaseID: fmt.Sprintf("%d", article.KnowledgeBaseID),
			KnowledgeBaseName: kbNames[article.KnowledgeBaseID], ArticleID: &articleIDText,
			Title: article.Title, Summary: hit.Summary,
			UpdatedAt: article.UpdatedAt.UTC().Format(timeRFC3339Nano), ContentMd: article.ContentMd,
		})
		seen[key] = true
		if len(contexts) >= limit {
			break
		}
	}
	return contexts, nil
}

func buildAgentQAPrompt(question string, contexts []agentDocumentContext) string {
	parts := make([]string, 0, len(contexts))
	for index, item := range contexts {
		lines := []string{
			fmt.Sprintf("## 文档 %d: %s", index+1, item.Title),
			"类型：" + map[string]string{"wiki": "Wiki 页面", "article": "知识文章", "document_chunk": "文件分片"}[item.Type],
			"知识库 ID：" + item.KnowledgeBaseID,
		}
		if item.DocumentID != nil {
			lines = append(lines, "文件 ID："+*item.DocumentID)
		}
		if item.ChunkIndex != nil {
			lines = append(lines, fmt.Sprintf("分片：%d", *item.ChunkIndex))
		}
		if item.ArticleID != nil {
			lines = append(lines, "文章 ID："+*item.ArticleID)
		}
		if item.PageKey != nil {
			lines = append(lines, "页面 Key："+*item.PageKey)
		}
		lines = append(lines, "", truncateAgentRunes(item.ContentMd, 6000))
		parts = append(parts, strings.Join(lines, "\n"))
	}
	return "问题：" + question + "\n\n文档上下文：\n" + strings.Join(parts, "\n\n---\n\n")
}

func truncateAgentRunes(value string, maxLength int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= maxLength {
		return value
	}
	return string(runes[:maxLength-1]) + "…"
}
