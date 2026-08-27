package aicore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	bedrockdocument "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	bedrocktypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

func TestBedrockConversationPreservesToolsResultsAndImages(t *testing.T) {
	t.Parallel()
	system, messages, err := bedrockConversation([]ChatMessage{
		{Role: "system", Content: "系统指令"},
		{Role: "user", Parts: []MediaPart{{Type: "image_url", MIMEType: "image/jpeg", Data: []byte{1, 2}}, {Type: "text", Text: "识别"}}},
		{Role: "assistant", Content: "先查", ToolCalls: []ToolCall{{ID: "tool-1", Name: "search_knowledge", ArgsJSON: `{"query":"Bedrock"}`}}},
		{Role: "tool", ToolCallID: "tool-1", Content: `{"ok":true}`},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(system) != 1 || len(messages) != 3 {
		t.Fatalf("system/messages = %d/%d", len(system), len(messages))
	}
	image, ok := messages[0].Content[0].(*bedrocktypes.ContentBlockMemberImage)
	if !ok || image.Value.Format != bedrocktypes.ImageFormatJpeg {
		t.Fatalf("image = %#v", messages[0].Content[0])
	}
	toolUse, ok := messages[1].Content[1].(*bedrocktypes.ContentBlockMemberToolUse)
	if !ok || aws.ToString(toolUse.Value.ToolUseId) != "tool-1" || aws.ToString(toolUse.Value.Name) != "search_knowledge" {
		t.Fatalf("tool use = %#v", messages[1].Content[1])
	}
	inputValue, err := bedrockDocumentValue(toolUse.Value.Input)
	input, _ := inputValue.(map[string]any)
	if err != nil || input["query"] != "Bedrock" {
		t.Fatalf("tool input = %#v, err = %v", input, err)
	}
	result, ok := messages[2].Content[0].(*bedrocktypes.ContentBlockMemberToolResult)
	if !ok || aws.ToString(result.Value.ToolUseId) != "tool-1" {
		t.Fatalf("tool result = %#v", messages[2].Content[0])
	}
	jsonResult, ok := result.Value.Content[0].(*bedrocktypes.ToolResultContentBlockMemberJson)
	if !ok {
		t.Fatalf("tool result content = %#v", result.Value.Content[0])
	}
	outputValue, err := bedrockDocumentValue(jsonResult.Value)
	output, _ := outputValue.(map[string]any)
	if err != nil || output["ok"] != true {
		t.Fatalf("tool output = %#v, err = %v", output, err)
	}
}

func TestParseBedrockConverseOutput(t *testing.T) {
	t.Parallel()
	result, err := parseBedrockConverseOutput(&bedrockruntime.ConverseOutput{
		Output: &bedrocktypes.ConverseOutputMemberMessage{Value: bedrocktypes.Message{
			Role: bedrocktypes.ConversationRoleAssistant,
			Content: []bedrocktypes.ContentBlock{
				&bedrocktypes.ContentBlockMemberText{Value: "先检索"},
				&bedrocktypes.ContentBlockMemberReasoningContent{Value: &bedrocktypes.ReasoningContentBlockMemberReasoningText{Value: bedrocktypes.ReasoningTextBlock{Text: aws.String("需要资料")}}},
				&bedrocktypes.ContentBlockMemberToolUse{Value: bedrocktypes.ToolUseBlock{
					ToolUseId: aws.String("tool-2"), Name: aws.String("search_knowledge"),
					Input: bedrockdocument.NewLazyDocument(map[string]any{"query": "Eino"}),
				}},
			},
		}},
		Usage: &bedrocktypes.TokenUsage{InputTokens: aws.Int32(21), OutputTokens: aws.Int32(7), TotalTokens: aws.Int32(28)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Answer != "先检索" || result.Reasoning == nil || *result.Reasoning != "需要资料" {
		t.Fatalf("result = %#v", result)
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "tool-2" || result.ToolCalls[0].ArgsJSON != `{"query":"Eino"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
	if result.InputTokens != 21 || result.OutputTokens != 7 {
		t.Fatalf("usage = %d/%d", result.InputTokens, result.OutputTokens)
	}
}

type fakeBedrockStreamReader struct {
	events chan bedrocktypes.ConverseStreamOutput
	err    error
	closed atomic.Bool
}

func newFakeBedrockStreamReader(events ...bedrocktypes.ConverseStreamOutput) *fakeBedrockStreamReader {
	channel := make(chan bedrocktypes.ConverseStreamOutput, len(events))
	for _, event := range events {
		channel <- event
	}
	close(channel)
	return &fakeBedrockStreamReader{events: channel}
}

func (r *fakeBedrockStreamReader) Events() <-chan bedrocktypes.ConverseStreamOutput { return r.events }
func (r *fakeBedrockStreamReader) Close() error {
	r.closed.Store(true)
	return nil
}
func (r *fakeBedrockStreamReader) Err() error { return r.err }

func TestConsumeBedrockStreamAggregatesTextToolsReasoningAndUsage(t *testing.T) {
	t.Parallel()
	reader := newFakeBedrockStreamReader(
		&bedrocktypes.ConverseStreamOutputMemberContentBlockStart{Value: bedrocktypes.ContentBlockStartEvent{
			ContentBlockIndex: aws.Int32(1), Start: &bedrocktypes.ContentBlockStartMemberToolUse{Value: bedrocktypes.ToolUseBlockStart{
				ToolUseId: aws.String("tool-stream"), Name: aws.String("search_knowledge"),
			}},
		}},
		&bedrocktypes.ConverseStreamOutputMemberContentBlockDelta{Value: bedrocktypes.ContentBlockDeltaEvent{
			ContentBlockIndex: aws.Int32(0), Delta: &bedrocktypes.ContentBlockDeltaMemberText{Value: "先查"},
		}},
		&bedrocktypes.ConverseStreamOutputMemberContentBlockDelta{Value: bedrocktypes.ContentBlockDeltaEvent{
			ContentBlockIndex: aws.Int32(2), Delta: &bedrocktypes.ContentBlockDeltaMemberReasoningContent{Value: &bedrocktypes.ReasoningContentBlockDeltaMemberText{Value: "思考"}},
		}},
		&bedrocktypes.ConverseStreamOutputMemberContentBlockDelta{Value: bedrocktypes.ContentBlockDeltaEvent{
			ContentBlockIndex: aws.Int32(1), Delta: &bedrocktypes.ContentBlockDeltaMemberToolUse{Value: bedrocktypes.ToolUseBlockDelta{Input: aws.String(`{"query":`)}},
		}},
		&bedrocktypes.ConverseStreamOutputMemberContentBlockDelta{Value: bedrocktypes.ContentBlockDeltaEvent{
			ContentBlockIndex: aws.Int32(1), Delta: &bedrocktypes.ContentBlockDeltaMemberToolUse{Value: bedrocktypes.ToolUseBlockDelta{Input: aws.String(`"Bedrock"}`)}},
		}},
		&bedrocktypes.ConverseStreamOutputMemberMetadata{Value: bedrocktypes.ConverseStreamMetadataEvent{
			Usage: &bedrocktypes.TokenUsage{InputTokens: aws.Int32(19), OutputTokens: aws.Int32(6), TotalTokens: aws.Int32(25)},
		}},
	)
	stream := bedrockruntime.NewConverseStreamEventStream(func(options *bedrockruntime.ConverseStreamEventStream) {
		options.Reader = reader
	})
	var deltas strings.Builder
	result, err := consumeBedrockStream(stream, func(delta string) error {
		deltas.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reader.closed.Load() {
		t.Fatal("stream was not closed")
	}
	if result.Answer != "先查" || deltas.String() != result.Answer || result.Reasoning == nil || *result.Reasoning != "思考" {
		t.Fatalf("result = %#v, deltas = %q", result, deltas.String())
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "tool-stream" || result.ToolCalls[0].ArgsJSON != `{"query":"Bedrock"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
	if result.InputTokens != 19 || result.OutputTokens != 6 {
		t.Fatalf("usage = %d/%d", result.InputTokens, result.OutputTokens)
	}
}

func TestBedrockSDKSignsConverseAndEmbeddingRequests(t *testing.T) {
	t.Parallel()
	var embeddingCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AKID/") {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Custom") != "yes" || r.Header.Get("X-Amz-Security-Token") != "session-token" {
			t.Fatalf("headers = %#v", r.Header)
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/converse"):
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["messages"] == nil || body["toolConfig"] == nil {
				t.Fatalf("body = %#v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"output":{"message":{"role":"assistant","content":[{"text":"AWS OK"},{"toolUse":{"toolUseId":"tool-http","name":"search_knowledge","input":{"query":"AWS"}}}]}},"stopReason":"tool_use","usage":{"inputTokens":15,"outputTokens":4,"totalTokens":19},"metrics":{"latencyMs":1}}`))
		case strings.HasSuffix(r.URL.Path, "/invoke"):
			embeddingCalls.Add(1)
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			value, _ := body["inputText"].(string)
			if value == "" {
				t.Fatalf("body = %#v", body)
			}
			base := float64(len(value))
			_, _ = fmt.Fprintf(w, `{"embedding":[%v,%v],"inputTextTokenCount":1}`, base, base+1)
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	rt := RuntimeConfig{
		ProviderKey: "amazon-bedrock", BaseURL: server.URL, Headers: map[string]string{"X-Custom": "yes"},
		Extra: map[string]string{
			"region": "us-east-1", "accessKeyId": "AKID", "secretAccessKey": "SECRET", "sessionToken": "session-token",
		},
	}
	chat, err := ChatWithToolsOnce(context.Background(), rt, "anthropic.claude-test-v1:0", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{}, nativeToolTestDefinitions)
	if err != nil {
		t.Fatal(err)
	}
	if chat.Answer != "AWS OK" || len(chat.ToolCalls) != 1 || chat.ToolCalls[0].ID != "tool-http" || chat.ToolCalls[0].ArgsJSON != `{"query":"AWS"}` {
		t.Fatalf("chat = %#v", chat)
	}
	embeddings, err := Embeddings(context.Background(), rt, "amazon.titan-embed-text-v2:0", []string{"a", "bbb"})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(embeddings) != "[[1 2] [3 4]]" || embeddingCalls.Load() != 2 {
		t.Fatalf("embeddings = %#v, calls = %d", embeddings, embeddingCalls.Load())
	}
}
