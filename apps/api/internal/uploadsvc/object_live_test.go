package uploadsvc

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/config"
	"petrichor/api/internal/storage"
)

// 显式启用时用当前配置验证 Go -> 对象存储，仅读写本次生成的测试对象，不连接业务数据库。
func TestLiveGoUploadRoundTrip(t *testing.T) {
	if os.Getenv("PETRICHOR_UPLOAD_LIVE_TEST") != "1" {
		t.Skip("未启用真实对象存储上传测试")
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal("无法初始化测试配置")
	}
	key := "uploads/0/upload-verification-" + storage.NewUUID() + ".txt"
	const payload = "Petrichor Go upload verification"
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set("petrichor.user", &auth.User{ID: 0}) })
	router.PUT("/api/upload/object/*objectKey", UploadObject)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("PUT", "/api/upload/object/"+key, strings.NewReader(payload)))
	if w.Code != 204 {
		t.Fatalf("Go 上传失败：%d %s", w.Code, w.Body.String())
	}
	t.Cleanup(func() {
		if err := storage.DeleteObjectBounded(context.Background(), key); err != nil {
			t.Error("测试对象清理失败")
		}
	})
	data, err := storage.ReadObjectLimited(context.Background(), key, 1024)
	if err != nil || string(data) != payload {
		t.Fatal("对象存储回读与上传内容不一致")
	}
}
