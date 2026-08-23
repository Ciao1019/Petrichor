package httpx

import (
	"time"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestErrorJSONShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/kb/article/detail", func(c *gin.Context) {
		ErrorJSON(c, http.StatusUnauthorized, "请先登录")
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/kb/article/detail", nil)
	r.ServeHTTP(w, req)

	body := w.Body.String()
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", w.Code)
	}
	for _, key := range []string{`"code":401`, `"msg":"请先登录"`, `"path":"/api/kb/article/detail"`, `"timestamp":`} {
		if !strings.Contains(body, key) {
			t.Fatalf("缺少字段 %s: %s", key, body)
		}
	}
}

func TestTableDataShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/notification/list", func(c *gin.Context) {
		TableData(c, []map[string]any{{"id": "1"}}, 10)
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/notification/list", nil)
	r.ServeHTTP(w, req)

	body := w.Body.String()
	for _, key := range []string{`"total":10`, `"code":200`, `"rows":[`} {
		if !strings.Contains(body, key) {
			t.Fatalf("缺少字段 %s: %s", key, body)
		}
	}
}

func TestResolvePagination(t *testing.T) {
	pageNum, pageSize := int64(3), int64(500)
	p := ResolvePagination(PaginationInput{PageNum: &pageNum, PageSize: &pageSize})
	if p.Limit != 100 || p.Offset != 200 {
		t.Fatalf("limit=%d offset=%d", p.Limit, p.Offset)
	}

	p2 := ResolvePagination(PaginationInput{})
	if p2.Limit != 20 || p2.Offset != 0 || p2.Asc {
		t.Fatalf("默认值错误: %+v", p2)
	}
}

func TestFlexID(t *testing.T) {
	var id FlexID
	if err := id.UnmarshalJSON([]byte(`"123"`)); err != nil || id != 123 {
		t.Fatalf("字符串 ID 解析失败: %v %d", err, id)
	}
	if err := id.UnmarshalJSON([]byte(`456`)); err != nil || id != 456 {
		t.Fatalf("数字 ID 解析失败: %v", err)
	}
	if err := id.UnmarshalJSON([]byte(`"-1"`)); err == nil {
		t.Fatal("负数应报错")
	}
	if err := id.UnmarshalJSON([]byte(`"abc"`)); err == nil {
		t.Fatal("非数字应报错")
	}
}

func TestFormatISO(t *testing.T) {
	// JS Date.toISOString() 毫秒精度
	got := FormatISO(mustTime(t, "2026-08-23T08:30:05Z"))
	if got != "2026-08-23T08:30:05.000Z" {
		t.Fatalf("格式不符: %s", got)
	}
}

func mustTime(t *testing.T, s string) time.Time {
	tm, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return tm
}
