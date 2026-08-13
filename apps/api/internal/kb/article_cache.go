package kb

import (
	"fmt"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

func (h *Handler) RefreshArticlePublicCache(c *gin.Context) {
	var req struct {
		ArticleID string `json:"articleId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	articleID, err := parsePositiveID(req.ArticleID, "articleId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if _, err := h.svc.client.KBArticle.Query().
		Where(kbarticle.IDEQ(articleID), kbarticle.UserIDEQ(u.ID)).
		Only(c.Request.Context()); err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("文章不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"articleId":   fmt.Sprintf("%d", articleID),
		"refreshedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
}
