package kb

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

const importTestUUID = "d65df230-e2fb-4daa-8d72-3df1a4630976"

func TestImportCreateOptionsContract(t *testing.T) {
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`{"idempotencyKey":"` + importTestUUID + `"}`, true},
		{`{}`, false}, {`{"idempotencyKey":""}`, false}, {`{"idempotencyKey":"bad"}`, false},
		{`{"idempotencyKey":"` + importTestUUID + `","pages":[]}`, false},
		{`{"idempotencyKey":"` + importTestUUID + `","pages":null}`, false},
		{`{"idempotencyKey":"` + importTestUUID + `","pages":[{"pageNo":1,"markdown":"注入"}]}`, false},
		{`{"idempotencyKey":"` + importTestUUID + `","markdown":"注入"}`, false},
	} {
		var raw map[string]any
		if err := json.Unmarshal([]byte(tc.body), &raw); err != nil {
			t.Fatal(err)
		}
		key, err := parseImportCreateOptions(raw)
		if (err == nil) != tc.valid {
			t.Fatalf("%s: %v", tc.body, err)
		}
		if tc.valid && key != importTestUUID {
			t.Fatalf("%s", key)
		}
	}
	if err, ok := importMutationError(taskqueue.ErrDocumentImportIdempotencyConflict).(*httpx.HttpError); !ok || err.Status != 409 {
		t.Fatal("幂等冲突必须返回409")
	}
}

func TestImportObjectPermissionsAndExtensions(t *testing.T) {
	for _, key := range []string{"uploads/7/a.pdf", "s4key:uploads/7/a.png"} {
		if err := validateImportObjectKey(7, key); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
	}
	for _, key := range []string{"uploads/70/a", "uploads/8/a", "uploads/7/../8/a", "uploads/7/a\\b", "https://x/uploads/7/a", "s4://uploads/7/a", "s4key:uploads/7/%2e%2e/x", "uploads/7/", "uploads/7//a", "uploads/7/./a"} {
		if err := validateImportObjectKey(7, key); err == nil {
			t.Fatalf("未拒绝 %s", key)
		}
	}
	for _, ext := range strings.Fields("md markdown doc docx docm ppt pps pot pptx pptm ppsx ppsm xls xlsx xlsm xlsb odt ods odp rtf epub csv pdf") {
		kind, err := importSourceType("FILE." + strings.ToUpper(ext))
		if err != nil || (ext == "markdown" && kind != "md") {
			t.Fatalf("%s %s %v", ext, kind, err)
		}
	}
	if _, err := importSourceType("bad.exe"); err == nil {
		t.Fatal("错误格式")
	}
}

func TestCreateImportHTTPRejectsInvalidPagesAndKeysBeforeDatabase(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set("petrichor.user", &auth.User{ID: 7}); c.Next() })
	router.POST("/create", CreateImportJob)
	for _, extra := range []string{
		``, `,"idempotencyKey":"invalid"`,
		`,"idempotencyKey":"` + importTestUUID + `","pages":null`,
		`,"idempotencyKey":"` + importTestUUID + `","pages":[{"pageNo":1,"markdown":"注入"}]`,
		`,"idempotencyKey":"` + importTestUUID + `","sourceKey":"uploads/8/a.pdf"`,
	} {
		body := `{"knowledgeBaseId":"1","fileName":"a.pdf","title":"A","sourceKey":"uploads/7/a.pdf"` + extra + `}`
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/create", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(response, request)
		if response.Code != 400 {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	}
}

func TestImportResponseHTTPContract(t *testing.T) {
	markdown := "正文"
	pages := []JobPageRow{{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &markdown}, {PageNo: 2, Status: "done", ExtractedBy: "multimodal", Markdown: &markdown}}
	stats := buildPageStats(pages)
	job := &JobRow{ID: 1, KnowledgeBaseID: 2, SourceType: "pdf", PageUnit: "page", Status: "processing", Stage: "finalizing", TotalPages: 2, ProcessedPages: 2}
	router := gin.New()
	router.GET("/detail", func(c *gin.Context) {
		c.JSON(200, map[string]any{"job": toJobResponse(job, nil, nil, &stats), "pages": []any{toPageResponse(&pages[0]), toPageResponse(&pages[1])}})
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("GET", "/detail", nil))
	for _, removed := range []string{"ocrPriority", "fallbackPages", "fallbackReasons", "fallbackUsed", "firecrawlPages"} {
		if strings.Contains(response.Body.String(), removed) {
			t.Fatalf("仍暴露停用字段: %s", removed)
		}
	}
	var data struct {
		Job struct {
			Status, Stage, PageUnit                 string
			DonePages, DirectPages, MultimodalPages int
			ActualMethods                           []string
		}
		Pages []struct {
			ExtractedBy string
		}
	}
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.Job.Status != "processing" || data.Job.Stage != "finalizing" || data.Job.PageUnit != "page" || data.Job.DonePages != 2 || data.Job.DirectPages != 1 || data.Job.MultimodalPages != 1 || len(data.Job.ActualMethods) != 2 {
		t.Fatalf("%s", response.Body.String())
	}
}
