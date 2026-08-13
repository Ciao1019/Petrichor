package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const timeRFC3339Nano = "2006-01-02T15:04:05.999999999Z07:00"

// DocumentSearchREST 关键词检索 Wiki 页面与源文章，返回 { items }。
func (h *Handler) DocumentSearchREST(c *gin.Context) {
	var req struct {
		KnowledgeBaseID *agentID `json:"knowledgeBaseId"`
		Query           string   `json:"query"`
		Limit           int      `json:"limit"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	query := strings.TrimSpace(req.Query)
	if query == "" || len([]rune(query)) > 200 {
		response.Fail(c, response.BadRequest("query 不能为空且不能超过 200 个字符"))
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 8
	}
	if limit < 1 || limit > 20 {
		response.Fail(c, response.BadRequest("limit 必须在 1 到 20 之间"))
		return
	}

	userID := agentUserID(c)
	ctx := c.Request.Context()
	var kbID *int64
	if req.KnowledgeBaseID != nil && strings.TrimSpace(string(*req.KnowledgeBaseID)) != "" {
		id, err := parseAgentID(string(*req.KnowledgeBaseID), "knowledgeBaseId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		kbID = &id
	}

	chunkHits, err := h.kbSvc.SearchDocumentChunks(ctx, userID, kbID, query, limit)
	if err != nil {
		response.Fail(c, err)
		return
	}
	wikiHits, err := h.kbSvc.SearchAgentWikiPages(ctx, userID, kbID, query, limit)
	if err != nil {
		response.Fail(c, err)
		return
	}
	articleHits, err := h.searchAgentArticles(ctx, userID, kbID, query, limit)
	if err != nil {
		response.Fail(c, err)
		return
	}

	items := make([]any, 0, len(chunkHits)+len(wikiHits)+len(articleHits))
	seen := map[string]struct{}{}
	appendHit := func(hit any, key string) {
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		items = append(items, hit)
	}
	for _, hit := range chunkHits {
		appendHit(hit, fmt.Sprintf("chunk:%s:%s", hit.DocumentID, hit.ChunkID))
		if len(items) >= limit {
			break
		}
	}
	for _, hit := range wikiHits {
		if len(items) >= limit {
			break
		}
		key := fmt.Sprintf("wiki:%s:%s:%s", hit.KnowledgeBaseID, hit.PageKey, hit.Title)
		appendHit(hit, key)
		if len(items) >= limit {
			break
		}
	}
	if len(items) < limit {
		for _, hit := range articleHits {
			key := fmt.Sprintf("article:%s:%s:%s", hit.KnowledgeBaseID, hit.ArticleID, hit.Title)
			appendHit(hit, key)
			if len(items) >= limit {
				break
			}
		}
	}
	response.OK(c, gin.H{"items": items})
}

type agentArticleHit struct {
	Type              string `json:"type"`
	KnowledgeBaseID   string `json:"knowledgeBaseId"`
	KnowledgeBaseName string `json:"knowledgeBaseName,omitempty"`
	ArticleID         string `json:"articleId"`
	PageKey           any    `json:"pageKey"`
	Title             string `json:"title"`
	Summary           string `json:"summary,omitempty"`
	UpdatedAt         string `json:"updatedAt,omitempty"`
}

func (h *Handler) searchAgentArticles(ctx context.Context, userID int64, knowledgeBaseID *int64, query string, limit int) ([]agentArticleHit, error) {
	q := h.client.KBArticle.Query().Where(
		kbarticle.UserIDEQ(userID),
		kbarticle.Or(
			kbarticle.TitleContainsFold(query),
			kbarticle.ContentMdContainsFold(query),
		),
	)
	if knowledgeBaseID != nil && *knowledgeBaseID > 0 {
		q = q.Where(kbarticle.KnowledgeBaseIDEQ(*knowledgeBaseID))
	}
	rows, err := q.Order(ent.Desc(kbarticle.FieldUpdatedAt)).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []agentArticleHit{}, nil
	}

	kbNames := map[int64]string{}
	for _, row := range rows {
		if _, ok := kbNames[row.KnowledgeBaseID]; ok {
			continue
		}
		kbRow, err := h.client.KnowledgeBase.Get(ctx, row.KnowledgeBaseID)
		if err == nil {
			kbNames[row.KnowledgeBaseID] = kbRow.Name
		}
	}

	out := make([]agentArticleHit, 0, len(rows))
	for _, row := range rows {
		out = append(out, agentArticleHit{
			Type:              "article",
			KnowledgeBaseID:   fmt.Sprintf("%d", row.KnowledgeBaseID),
			KnowledgeBaseName: kbNames[row.KnowledgeBaseID],
			ArticleID:         fmt.Sprintf("%d", row.ID),
			PageKey:           nil,
			Title:             row.Title,
			Summary:           summarizeAgentMarkdown(row.ContentMd, 220),
			UpdatedAt:         row.UpdatedAt.UTC().Format(timeRFC3339Nano),
		})
	}
	return out, nil
}

func summarizeAgentMarkdown(md string, max int) string {
	text := strings.Join(strings.Fields(md), " ")
	runes := []rune(text)
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return text
}
