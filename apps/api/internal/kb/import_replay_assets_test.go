package kb

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/adminpanel"
	"petrichor/api/internal/taskqueue"
)

func TestUserRetryAndAdminReplayPreserveMixedPageContent(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	for _, admin := range []bool{false, true} {
		body, image := "# 原生标题\n正文", "uploads/7/page.png"
		job := safetyImportJob(t, store,
			JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &body},
			JobPageRow{PageNo: 2, Status: "dead_letter", ExtractedBy: "ocr", Markdown: &body, ImageKey: &image,
				Assets: []taskqueue.DocumentImportAsset{{ID: "image-1", ImageKey: image, Status: "done", Markdown: "已识别图片", Method: "multimodal"}}})
		if _, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error { j.Status = "dead_letter"; return nil }); err != nil {
			t.Fatal(err)
		}
		if admin {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest("POST", "/admin/replay", strings.NewReader(fmt.Sprintf(`{"kind":"document_import","id":"%d"}`, job.ID)))
			c.Request.Header.Set("Content-Type", "application/json")
			adminpanel.AdminReplayDeadLetter(c)
			if w.Code != 200 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		} else if _, err := retryFailedImportJob(ctx, store, job.ID); err != nil {
			t.Fatal(err)
		}
		pages, err := store.Pages(ctx, job.ID)
		if err != nil || pages[0].Status != "done" || derefStr(pages[1].Markdown) != body || pages[1].Status != "pending" || len(pages[1].Assets) != 1 || pages[1].Assets[0].Markdown != "已识别图片" {
			t.Fatalf("admin=%v 重试丢失图文：%+v %v", admin, pages, err)
		}
		dead, err := store.ListByStatus(ctx, "dead_letter", 100)
		if err != nil || len(dead) != 0 {
			t.Fatalf("重试后死信列表仍有任务：%v %v", dead, err)
		}
	}
}
