package typesafe

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testQuestions() map[string]Question {
	return map[string]Question{"base": {Type: "choice", Instructions: "选择归属", Criteria: map[string]string{"b0": "知识库", "none": "不匹配"}}, "tag": {Type: "noul", Instructions: "适合标签？"}}
}

const validResponse = `{"model":"jev-1.13.0","answers":{"base":{"type":"choice","choice":"b0","confidence":0.9,"probabilities":{"b0":0.95,"none":0.05}},"tag":{"type":"noul","noul":0.88}},"usage":{"input_tokens":130,"output_tokens":20}}`

func TestEvaluateProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/systemone" || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("请求协议不正确")
		}
		var body struct {
			State     map[string]string   `json:"state"`
			Model     string              `json:"model"`
			Questions map[string]Question `json:"questions"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.State["note"] != "我的随笔" || body.Model != "jev-1.13.0" || len(body.Questions) != 2 {
			t.Error("请求内容丢失")
		}
		_, _ = w.Write([]byte(validResponse))
	}))
	defer server.Close()
	result, err := Evaluate(context.Background(), server.URL, "test-key", "jev-1.13.0", map[string]string{"note": "我的随笔"}, testQuestions())
	if err != nil || result.Answers["base"].Choice != "b0" || result.Usage.InputTokens != 130 {
		t.Fatal(result, err)
	}
}

func TestEvaluateRejectsInvalidResultsAndSanitizesErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"unknown_choice", 200, strings.Replace(validResponse, `"choice":"b0"`, `"choice":"foreign-id"`, 1), ErrInvalid},
		{"missing_confidence", 200, strings.Replace(validResponse, `"confidence":0.9,`, "", 1), ErrInvalid},
		{"invalid_noul", 200, strings.Replace(validResponse, `"noul":0.88`, `"noul":2`, 1), ErrInvalid},
		{"missing_answer", 200, `{"model":"jev","answers":{}}`, ErrInvalid},
		{"invalid_distribution", 200, strings.Replace(validResponse, `"none":0.05`, `"none":0.9`, 1), ErrInvalid},
		{"oversize", 200, strings.Repeat("x", 513<<10), ErrInvalid},
		{"rate_limit", 429, "secret provider body", ErrRateLimited},
		{"unauthorized", 401, "secret key=123", ErrUnavailable},
		{"server_error", 500, "secret note", ErrUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			_, err := Evaluate(context.Background(), server.URL, "test-key", "jev", "note", testQuestions())
			if !errors.Is(err, tc.want) || calls != 1 {
				t.Fatal("应验证结果并避免收费重试", err, calls)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("泄漏了上游错误")
			}
		})
	}
}

func TestEvaluateDoesNotFollowRedirectAndHonorsCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/credential-leak")
		w.WriteHeader(302)
	}))
	defer server.Close()
	if _, err := Evaluate(context.Background(), server.URL, "test-key", "jev", "note", testQuestions()); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	<-ctx.Done()
	if _, err := Evaluate(ctx, server.URL, "test-key", "jev", "note", testQuestions()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if _, err := Evaluate(context.Background(), server.URL, "test-key", "jev", strings.Repeat("字", 24000), testQuestions()); !errors.Is(err, ErrTooLarge) {
		t.Fatal(err)
	}
}
