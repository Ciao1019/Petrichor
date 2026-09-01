package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRequestIDPreservesValidValueAndReplacesUnsafeValue(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name     string
		incoming string
		want     string
	}{
		{name: "preserve", incoming: "request-12345678", want: "request-12345678"},
		{name: "replace", incoming: "bad\nvalue"},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := gin.New()
			engine.Use(RequestID())
			engine.GET("/", func(c *gin.Context) { c.String(http.StatusOK, RequestIDValue(c)) })
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("X-Request-ID", test.incoming)
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, request)
			got := recorder.Header().Get("X-Request-ID")
			if test.want != "" && got != test.want {
				t.Fatalf("request id = %q, want %q", got, test.want)
			}
			if !validRequestID.MatchString(got) || strings.ContainsAny(got, "\r\n") {
				t.Fatalf("generated unsafe request id: %q", got)
			}
		})
	}
}

func TestRequestBodyLimitReturnsContractForKnownAndStreamingLengths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(RequestBodyLimit(16, 32))
	engine.POST("/api/example", func(c *gin.Context) {
		var payload map[string]string
		if err := ReadJSON(c, &payload); err != nil {
			HandleError(c, err)
			return
		}
		OK(c, payload)
	})

	for _, streaming := range []bool{false, true} {
		body := []byte(`{"value":"this payload is too large"}`)
		request := httptest.NewRequest(http.MethodPost, "/api/example", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if streaming {
			request.ContentLength = -1
		}
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("streaming=%v status=%d body=%s", streaming, recorder.Code, recorder.Body.String())
		}
		var response map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response["code"] != float64(http.StatusRequestEntityTooLarge) {
			t.Fatalf("unexpected response: %v", response)
		}
	}
}

func TestAccessLoggerUpdatesRuntimeMetrics(t *testing.T) {
	before := SnapshotRequestMetrics()
	engine := gin.New()
	engine.Use(AccessLogger())
	engine.GET("/failure", func(c *gin.Context) { c.Status(http.StatusServiceUnavailable) })
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/failure", nil))
	after := SnapshotRequestMetrics()
	if after.Requests != before.Requests+1 || after.ServerErrors != before.ServerErrors+1 {
		t.Fatalf("metrics before=%+v after=%+v", before, after)
	}
	if after.Active != before.Active {
		t.Fatalf("active requests leaked: before=%d after=%d", before.Active, after.Active)
	}
}

func TestSecurityHeaders(t *testing.T) {
	engine := gin.New()
	engine.Use(SecurityHeaders())
	engine.GET("/", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}
