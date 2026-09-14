package uploadsvc

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/config"
	"petrichor/api/internal/httpx"
)

func TestGoUploadToS3AndFailureContract(t *testing.T) {
	upstreamStatus, calls := 204, 0
	payload := strings.Repeat("%PDF-test-object", 12)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		if r.Method != "PUT" || string(body) != payload || r.ContentLength != int64(len(payload)) || r.URL.Query().Get("X-Amz-Signature") == "" {
			t.Errorf("Go 未完整签名上传文件：method=%s size=%d", r.Method, len(body))
		}
		w.WriteHeader(upstreamStatus)
		_, _ = w.Write([]byte("secret upstream error must not leak"))
	}))
	defer upstream.Close()
	t.Chdir(t.TempDir())
	fixture := fmt.Sprintf("[database]\nurl = \"postgres://localhost/test_unused\"\n[storage.s3]\nendpoint = %q\nbucket = \"127.0.0.1\"\naccess_key_id = \"test-key\"\nsecret_access_key = \"test-secret\"\n", upstream.URL)
	if err := os.WriteFile("config.toml", []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(httpx.RequestBodyLimit(128, 256))
	router.Use(func(c *gin.Context) { c.Set("petrichor.user", &auth.User{ID: 7}) })
	router.POST("/api/upload/presign-put", PresignPutObject)
	router.PUT("/api/upload/object/*objectKey", UploadObject)
	request := func(method, path, body string, streaming bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if streaming {
			r.ContentLength = -1
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	w := request("POST", "/api/upload/presign-put", `{"filename":"example.pdf"}`, false)
	var target struct {
		URL string `json:"presignedUrl"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &target); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || !strings.HasPrefix(target.URL, "/api/upload/object/uploads/7/") || strings.Contains(w.Body.String(), "X-Amz") {
		t.Fatalf("浏览器必须只获得同源上传地址：%d %s", w.Code, w.Body.String())
	}
	for _, test := range []struct {
		path, body                  string
		streaming                   bool
		status, upstream, wantCalls int
	}{
		{target.URL, payload, false, 204, 204, 1},
		{target.URL, payload, true, 204, 204, 2},
		{target.URL, payload, false, 502, 403, 3},
		{target.URL, strings.Repeat("x", 257), false, 413, 204, 3},
		{target.URL, strings.Repeat("x", 257), true, 413, 204, 3},
		{"/api/upload/object/uploads/8/other.pdf", payload, false, 403, 204, 3},
		{"/api/upload/object/uploads/7/../other.pdf", payload, false, 400, 204, 3},
	} {
		upstreamStatus = test.upstream
		w := request("PUT", test.path, test.body, test.streaming)
		if w.Code != test.status || calls != test.wantCalls || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body.String())
		}
		if test.status == 502 && !strings.Contains(w.Body.String(), "对象存储保存失败（HTTP 403）") {
			t.Fatal(w.Body.String())
		}
	}
}
