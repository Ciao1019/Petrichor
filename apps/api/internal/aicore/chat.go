package aicore

import (
	"context"
	"strings"
)

// Chat 统一补全入口：按 sdk 类型路由协议（对应 model-factory.ts + generation.ts 的 callChatCompletion）。
func Chat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions) (*ChatResult, error) {
	switch effectiveSDK(rt.ProviderKey) {
	case SDKAnthropic:
		return anthropicChat(ctx, rt, modelID, msgs, opts, false, nil)
	case SDKGoogle, SDKGoogleVertex:
		if rt.ProviderKey == "google-vertex" {
			return nil, &unsupportedProtocolError{rt.ProviderKey}
		}
		return googleChat(ctx, rt, modelID, msgs, opts, false, nil)
	case SDKAzure, SDKBedrock:
		return nil, &unsupportedProtocolError{rt.ProviderKey}
	default:
		return OpenAIChat(ctx, rt, modelID, msgs, opts)
	}
}

// ChatStream 统一流式入口。
func ChatStream(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, onDelta func(string) error) (*ChatResult, error) {
	switch effectiveSDK(rt.ProviderKey) {
	case SDKAnthropic:
		return anthropicChat(ctx, rt, modelID, msgs, opts, true, onDelta)
	case SDKGoogle:
		return googleChat(ctx, rt, modelID, msgs, opts, true, onDelta)
	case SDKAzure, SDKBedrock, SDKGoogleVertex:
		return nil, &unsupportedProtocolError{rt.ProviderKey}
	default:
		return OpenAIChatStream(ctx, rt, modelID, msgs, opts, onDelta)
	}
}

// ChatWithTools 带工具的流式补全：按 sdk 类型路由协议；文本增量回调，工具调用聚合返回。
// Anthropic/Google 协议暂不支持工具，回落为无工具补全（与 TS 侧 provider 支持面一致）。
func ChatWithTools(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition, onDelta func(string) error) (*ChatResult, error) {
	if len(tools) == 0 {
		return ChatStream(ctx, rt, modelID, msgs, opts, onDelta)
	}
	switch effectiveSDK(rt.ProviderKey) {
	case SDKAnthropic, SDKGoogle, SDKGoogleVertex, SDKAzure, SDKBedrock:
		return nil, &unsupportedProtocolError{rt.ProviderKey + ":工具调用"}
	default:
		return OpenAIChatWithTools(ctx, rt, modelID, msgs, opts, tools, onDelta)
	}
}

// Embeddings 统一向量入口（voyage 也走 /embeddings 兼容端点）。
func Embeddings(ctx context.Context, rt RuntimeConfig, modelID string, texts []string) ([][]float32, error) {
	base := rt.effectiveBaseURL("")
	if base == "" {
		return nil, &unsupportedProtocolError{rt.ProviderKey + ":缺少 BaseUrl"}
	}
	return OpenAIEmbeddings(ctx, rt, modelID, texts)
}

type unsupportedProtocolError struct{ providerKey string }

func (e *unsupportedProtocolError) Error() string {
	return "该供应商(" + e.providerKey + ")的协议暂不支持，请改用 OpenAI 兼容 / Anthropic / Google 供应商"
}

func effectiveSDK(providerKey string) SdkKind {
	if e, ok := Catalog[providerKey]; ok {
		return e.Sdk
	}
	return SDKOpenAICompatible
}

var _ = strings.TrimSpace
