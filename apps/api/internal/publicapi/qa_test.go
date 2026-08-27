package publicapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
)

func TestStreamPublicQaAnswerRunsToolLoop(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("POST", "/api/public/qa/chat", nil)

	originalWithTools := publicQaChatWithTools
	originalStream := publicQaChatStream
	defer func() {
		publicQaChatWithTools = originalWithTools
		publicQaChatStream = originalStream
	}()

	modelCalls := 0
	publicQaChatWithTools = func(_ context.Context, _ aicore.RuntimeConfig, _ string,
		messages []aicore.ChatMessage, _ aicore.GenerationOptions, tools []aicore.ToolDefinition,
		onDelta func(string) error,
	) (*aicore.ChatResult, error) {
		modelCalls++
		if len(tools) != 1 || tools[0].Name != "lookup" {
			t.Fatalf("tools = %#v", tools)
		}
		if modelCalls == 1 {
			return &aicore.ChatResult{
				HasToolCalls: true,
				ToolCalls:    []aicore.ToolCall{{ID: "call-1", Name: "lookup", ArgsJSON: `{"query":"测试"}`}},
			}, nil
		}
		if len(messages) < 4 || messages[len(messages)-1].Role != "tool" || messages[len(messages)-1].ToolCallID != "call-1" {
			t.Fatalf("第二轮没有收到工具结果：%#v", messages)
		}
		if err := onDelta("最终答案"); err != nil {
			return nil, err
		}
		return &aicore.ChatResult{Answer: "最终答案"}, nil
	}
	publicQaChatStream = func(_ context.Context, _ aicore.RuntimeConfig, _ string,
		_ []aicore.ChatMessage, _ aicore.GenerationOptions, _ func(string) error,
	) (*aicore.ChatResult, error) {
		t.Fatal("不应走到第 8 步兜底")
		return nil, nil
	}

	executed := 0
	tools := &publicQaToolSet{items: []publicQaTool{{
		definition: qaToolDefinition("lookup", "测试检索", `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`),
		execute: func(_ context.Context, args map[string]any) (any, error) {
			executed++
			return map[string]any{"found": args["query"]}, nil
		},
	}}}
	userMessage, _ := json.Marshal(map[string]any{"role": "user", "content": "请检索"})
	streamPublicQaAnswer(c, streamPublicQaParams{
		resolved: &aicore.ResolvedModel{ModelRef: "test", Runtime: aicore.RuntimeConfig{ProviderKey: "openai"}},
		messages: []json.RawMessage{userMessage}, systemPrompt: "system", tools: tools,
		quotaRemaining: 9, quotaLimit: 10,
	})

	if modelCalls != 2 || executed != 1 {
		t.Fatalf("modelCalls=%d executed=%d", modelCalls, executed)
	}
	body := recorder.Body.String()
	for _, expected := range []string{"tool-input-start", "tool-output-available", "最终答案", `data: [DONE]`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("响应缺少 %q：%s", expected, body)
		}
	}
}
