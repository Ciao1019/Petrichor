package uploadsvc

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/config"
	"petrichor/api/internal/storage"
)

func TestLocalUploadThroughReverseProxy(t *testing.T) {
	t.Chdir(t.TempDir())
	storageDir := t.TempDir()
	fixture := fmt.Sprintf("[database]\nurl = \"postgres://localhost/test_unused\"\n[storage]\nlocal_directory = %q\n", storageDir)
	if err := os.WriteFile("config.toml", []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set("petrichor.user", &auth.User{ID: 7}) })
	router.POST("/api/upload/presign-put", PresignPutObject)
	router.POST("/api/upload/presign-get", PresignGetObject)
	router.PUT("/api/upload/object/*objectKey", UploadObject)
	router.GET("/api/upload/local/*objectKey", ServeLocalObject)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1:8080"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-Host", "localhost:3000")
		req.Header.Set("X-Forwarded-Proto", "http")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	response := request(http.MethodPost, "/api/upload/presign-put", `{"filename":"示例 文档.md"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("获取上传地址失败：%d %s", response.Code, response.Body.String())
	}
	var presign struct {
		ObjectKey    string `json:"objectKey"`
		PresignedURL string `json:"presignedUrl"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &presign); err != nil {
		t.Fatal(err)
	}
	// 代理改写 Host 后，浏览器仍应通过页面源站上传，而不是直连内部端口。
	page, _ := url.Parse("http://localhost:3000/dashboard/imports")
	ref, err := url.Parse(presign.PresignedURL)
	if err != nil {
		t.Fatal(err)
	}
	resolved := page.ResolveReference(ref)
	if resolved.Scheme != page.Scheme || resolved.Host != page.Host {
		t.Fatalf("上传地址跨域：%s", resolved)
	}
	const content = "# 本地导入\n正文"
	if response := request(http.MethodPut, resolved.RequestURI(), content); response.Code != http.StatusNoContent {
		t.Fatalf("上传失败：%d %s", response.Code, response.Body.String())
	}
	if data, err := os.ReadFile(filepath.Join(storageDir, presign.ObjectKey)); err != nil || string(data) != content {
		t.Fatalf("文件未完整落盘：%q %v", data, err)
	}
	body, _ := json.Marshal(map[string]string{"objectKey": presign.ObjectKey})
	response = request(http.MethodPost, "/api/upload/presign-get", string(body))
	var download struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &download); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || download.URL != storage.LocalObjectURL(presign.ObjectKey) {
		t.Fatalf("下载地址未保持同源：%d %s", response.Code, download.URL)
	}
	if response := request(http.MethodGet, download.URL, ""); response.Code != http.StatusOK || response.Body.String() != content {
		t.Fatalf("文件读取失败：%d %s", response.Code, response.Body.String())
	}
}
