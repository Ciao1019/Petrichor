// wiki.go 对照 handlers.ts：wiki/page/list、page/detail、lint、ingest。
package agentapi

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/kb"
)

// AgentWikiPageList POST /api/agent/wiki/page/list（scope wiki:read）。
func AgentWikiPageList(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "wiki:read"); err != nil {
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
	pages, err := kb.ListWikiPagesForAgent(dbPool(), actx.UserID, kbID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"knowledgeBaseId": idStr(kbID),
		"pages":           pages,
	}, nil
}

// AgentWikiPageDetail POST /api/agent/wiki/page/detail（scope wiki:read）。
func AgentWikiPageDetail(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "wiki:read"); err != nil {
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
	pageKey := trimmedString(raw, "pageKey")
	if pageKey == "" || len([]rune(pageKey)) > 200 {
		return nil, badReq("pageKey 必须在 1 到 200 个字符之间")
	}
	return kb.LoadWikiPageDetailForAgent(dbPool(), actx.UserID, kbID, pageKey)
}

// AgentWikiLint POST /api/agent/wiki/lint（scope wiki:read）。
func AgentWikiLint(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "wiki:read"); err != nil {
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
	return kb.RunWikiLintForAgent(dbPool(), actx.UserID, kbID)
}

// AgentWikiIngest POST /api/agent/wiki/ingest（scope wiki:write）。
func AgentWikiIngest(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "wiki:write"); err != nil {
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
	var articleIDs []int64
	if list, ok := raw["articleIds"].([]any); ok {
		if len(list) > 500 {
			return nil, badReq("articleIds 数量不能超过 500")
		}
		for _, item := range list {
			id, err := reqID(item, "ID 必须是正整数")
			if err != nil {
				return nil, err
			}
			articleIDs = append(articleIDs, id)
		}
	}
	result, err := kb.IngestWikiCore(dbPool(), kb.IngestWikiInput{
		UserID:          actx.UserID,
		KnowledgeBaseID: kbID,
		ArticleIDs:      articleIDs,
		ForceRebuild:    rawBool(raw, "forceRebuild"),
		FullRebuild:     rawBool(raw, "fullRebuild"),
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
