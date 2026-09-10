package publicapi

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/config"
)

// 直接调用只读公开处理器，验证全站接口和详情契约；不启动服务，不执行迁移。
func TestPublicWikiEndpointsLive(t *testing.T) {
	if os.Getenv("PETRICHOR_PUBLIC_WIKI_LIVE_TEST") != "1" {
		t.Skip("设置 PETRICHOR_PUBLIC_WIKI_LIVE_TEST=1 运行只读公开接口测试")
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal("无法加载本地配置")
	}
	request := func(path string, handler gin.HandlerFunc, wantStatus int) map[string]json.RawMessage {
		t.Helper()
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("GET", path, nil)
		handler(c)
		if w.Code != wantStatus {
			t.Fatalf("公开接口状态码 got %d, want %d", w.Code, wantStatus)
		}
		if wantStatus != 200 {
			return nil
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("公开 Wiki 不应缓存已撤销内容")
		}
		var data map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
			t.Fatal("响应 JSON 无效")
		}
		return data
	}
	data := request("/api/public/wiki/pages?limit=2", WikiPageList, 200)
	var items []struct {
		Href string `json:"href"`
	}
	if err := json.Unmarshal(data["items"], &items); err != nil {
		t.Fatal("全站目录 items 无效")
	}
	for _, item := range items {
		parts := strings.SplitN(strings.TrimPrefix(item.Href, "/wiki/"), "/", 2)
		if len(parts) != 2 || parts[0] == "0" {
			t.Fatal("全站目录未保留稳定详情地址")
		}
		request("/api/public/wiki/page?knowledgeBaseId="+url.QueryEscape(parts[0])+"&pageKey="+parts[1], WikiPageDetail, 200)
	}
	request("/api/public/wiki/pages?knowledgeBaseId=-1", WikiPageList, 400)
	request("/api/public/wiki/page?knowledgeBaseId=1&pageKey=__missing_public_test__", WikiPageDetail, 404)
	t.Logf("全站目录与详情检查 %d 页", len(items))
}
