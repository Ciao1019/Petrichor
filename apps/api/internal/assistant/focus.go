package assistant

import (
	"context"

	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

func (r *Runtime) assertAssistantFocusOwnership(ctx context.Context, userID int64, focus *AssistantFocus) error {
	if focus == nil {
		return nil
	}
	type check struct {
		label string
		value *string
		owned func(int64) (bool, error)
	}
	checks := []check{
		{label: "knowledgeBaseId", value: focus.KnowledgeBaseID, owned: func(id int64) (bool, error) {
			return r.client.KnowledgeBase.Query().Where(knowledgebase.IDEQ(id), knowledgebase.UserIDEQ(userID)).Exist(ctx)
		}},
		{label: "articleId", value: focus.ArticleID, owned: func(id int64) (bool, error) {
			return r.client.KBArticle.Query().Where(kbarticle.IDEQ(id), kbarticle.UserIDEQ(userID)).Exist(ctx)
		}},
		{label: "documentId", value: focus.DocumentID, owned: func(id int64) (bool, error) {
			return r.client.KBDocument.Query().Where(kbdocument.IDEQ(id), kbdocument.UserIDEQ(userID)).Exist(ctx)
		}},
	}
	for _, item := range checks {
		if item.value == nil {
			continue
		}
		id, err := parsePositiveID(*item.value, "focus."+item.label)
		if err != nil {
			return response.BadRequest("focus." + item.label + " 不合法")
		}
		owned, err := item.owned(id)
		if err != nil {
			return err
		}
		if !owned {
			return response.Forbidden("无权访问 focus." + item.label + " 指向的实体")
		}
	}
	return nil
}
