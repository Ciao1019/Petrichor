package adminpanel

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestAdminReplayDeadLetterRejectsInvalidRequestBeforeDatabase(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name string
		body string
	}{
		{name: "missing fields", body: `{}`},
		{name: "unknown kind", body: `{"kind":"unknown","id":"1"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/api/admin/runtime/dead-letters/replay", strings.NewReader(test.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			AdminReplayDeadLetter(ctx)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
