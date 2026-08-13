package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

func TestRequestLoggerIncludesInternalError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	core, observed := observer.New(zap.DebugLevel)
	router := gin.New()
	router.Use(RequestLogger(zap.New(core)))
	router.GET("/failure", func(c *gin.Context) {
		response.Fail(c, errors.New("database write failed"))
	})

	request := httptest.NewRequest(http.MethodGet, "/failure", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	entries := observed.FilterMessage("http").All()
	if len(entries) != 1 {
		t.Fatalf("log entries = %d, want 1", len(entries))
	}
	if entries[0].Level != zap.ErrorLevel {
		t.Fatalf("log level = %s, want error", entries[0].Level)
	}
	errorsField, ok := entries[0].ContextMap()["errors"].([]any)
	if !ok || len(errorsField) != 1 || errorsField[0] != "database write failed" {
		t.Fatalf("errors field = %#v", entries[0].ContextMap()["errors"])
	}
}

func TestRequestLoggerKeepsSuccessfulRequestAtInfo(t *testing.T) {
	gin.SetMode(gin.TestMode)
	core, observed := observer.New(zap.DebugLevel)
	router := gin.New()
	router.Use(RequestLogger(zap.New(core)))
	router.GET("/success", func(c *gin.Context) {
		response.OK(c, gin.H{"ok": true})
	})

	request := httptest.NewRequest(http.MethodGet, "/success", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	entries := observed.FilterMessage("http").All()
	if len(entries) != 1 || entries[0].Level != zap.InfoLevel {
		t.Fatalf("entries = %#v, want one info log", entries)
	}
}
