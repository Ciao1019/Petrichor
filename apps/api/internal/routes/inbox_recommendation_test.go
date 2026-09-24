package routes

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestInboxRecommendationRoutesRequireUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 路由契约测试不初始化真实 Session 存储；在执行前检查受保护的处理链。
	r.Use(func(c *gin.Context) {
		protected := false
		for _, name := range c.HandlerNames() {
			protected = protected || strings.Contains(name, "RequireUser")
		}
		if !protected {
			t.Error("推荐端点缺少登录中间件")
		}
		c.AbortWithStatus(204)
	})
	registerInboxRoutes(r.Group("/api"))
	for _, path := range []string{"/api/inbox/recommendation/config", "/api/inbox/recommendation"} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", path, strings.NewReader(`{"id":"1","version":1}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		if w.Code != 204 {
			t.Fatalf("检查推荐路由 %s 返回 %d", path, w.Code)
		}
	}
}
