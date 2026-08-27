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
	case SDKGoogle:
		return googleChat(ctx, rt, modelID, msgs, opts, false, nil)
	case SDKGoogleVertex:
		return vertexChat(ctx, rt, modelID, msgs, opts, nil, false, nil)
	case SDKAzure:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChat(ctx, rt, modelID, msgs, opts)
		}
		return azureChat(ctx, rt, modelID, msgs, opts, nil, false, nil)
	case SDKBedrock:
		return bedrockChat(ctx, rt, modelID, msgs, opts, nil, false, nil)
	default:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChat(ctx, rt, modelID, msgs, opts)
		}
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
	case SDKGoogleVertex:
		return vertexChat(ctx, rt, modelID, msgs, opts, nil, true, onDelta)
	case SDKAzure:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChatStream(ctx, rt, modelID, msgs, opts, onDelta)
		}
		return azureChat(ctx, rt, modelID, msgs, opts, nil, true, onDelta)
	case SDKBedrock:
		return bedrockChat(ctx, rt, modelID, msgs, opts, nil, true, onDelta)
	default:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChatStream(ctx, rt, modelID, msgs, opts, onDelta)
		}
		return OpenAIChatStream(ctx, rt, modelID, msgs, opts, onDelta)
	}
}

// ChatWithTools 带工具的流式补全：按 sdk 类型路由协议；文本增量回调，工具调用聚合返回。
// Anthropic 与 Google 使用各自原生工具协议，避免切换供应商后 Agent 能回答却不能检索。
func ChatWithTools(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition, onDelta func(string) error) (*ChatResult, error) {
	if len(tools) == 0 {
		return ChatStream(ctx, rt, modelID, msgs, opts, onDelta)
	}
	switch effectiveSDK(rt.ProviderKey) {
	case SDKAnthropic:
		return anthropicChatWithTools(ctx, rt, modelID, msgs, opts, tools, true, onDelta)
	case SDKGoogle:
		return googleChatWithTools(ctx, rt, modelID, msgs, opts, tools, true, onDelta)
	case SDKGoogleVertex:
		return vertexChat(ctx, rt, modelID, msgs, opts, tools, true, onDelta)
	case SDKAzure:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChatWithTools(ctx, rt, modelID, msgs, opts, tools, onDelta)
		}
		return azureChat(ctx, rt, modelID, msgs, opts, tools, true, onDelta)
	case SDKBedrock:
		return bedrockChat(ctx, rt, modelID, msgs, opts, tools, true, onDelta)
	default:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChatWithTools(ctx, rt, modelID, msgs, opts, tools, onDelta)
		}
		return OpenAIChatWithTools(ctx, rt, modelID, msgs, opts, tools, onDelta)
	}
}

// ChatWithToolsOnce 带工具的非流式补全。主要供 Eino 的 Generate 接口使用；
// 当前原生工具协议与流式入口保持同一支持面，避免同一模型在两种调用方式下行为漂移。
func ChatWithToolsOnce(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition) (*ChatResult, error) {
	if len(tools) == 0 {
		return Chat(ctx, rt, modelID, msgs, opts)
	}
	switch effectiveSDK(rt.ProviderKey) {
	case SDKAnthropic:
		return anthropicChatWithTools(ctx, rt, modelID, msgs, opts, tools, false, nil)
	case SDKGoogle:
		return googleChatWithTools(ctx, rt, modelID, msgs, opts, tools, false, nil)
	case SDKGoogleVertex:
		return vertexChat(ctx, rt, modelID, msgs, opts, tools, false, nil)
	case SDKAzure:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChatWithToolsOnce(ctx, rt, modelID, msgs, opts, tools)
		}
		return azureChat(ctx, rt, modelID, msgs, opts, tools, false, nil)
	case SDKBedrock:
		return bedrockChat(ctx, rt, modelID, msgs, opts, tools, false, nil)
	default:
		if usesResponsesProtocol(rt) {
			return OpenAIResponsesChatWithToolsOnce(ctx, rt, modelID, msgs, opts, tools)
		}
		return OpenAIChatWithToolsOnce(ctx, rt, modelID, msgs, opts, tools)
	}
}

// Embeddings 统一向量入口（voyage 也走 /embeddings 兼容端点）。
func Embeddings(ctx context.Context, rt RuntimeConfig, modelID string, texts []string) ([][]float32, error) {
	if effectiveSDK(rt.ProviderKey) == SDKAzure {
		return azureEmbeddings(ctx, rt, modelID, texts)
	}
	if effectiveSDK(rt.ProviderKey) == SDKGoogleVertex {
		return vertexEmbeddings(ctx, rt, modelID, texts)
	}
	if effectiveSDK(rt.ProviderKey) == SDKBedrock {
		return bedrockEmbeddings(ctx, rt, modelID, texts)
	}
	// 目录内置供应商允许不保存 base_url；必须与 Chat/OpenAIEmbeddings 一样
	// 回落 Catalog.DefaultBaseURL。此前这里先用空 fallback 拦截，导致 SiliconFlow
	// 等供应商明明有默认端点，查询向量却永久不可用。
	base := effectiveEmbeddingBaseURL(rt)
	if base == "" {
		return nil, &unsupportedProtocolError{rt.ProviderKey + ":缺少 BaseUrl"}
	}
	return OpenAIEmbeddings(ctx, rt, modelID, texts)
}

func effectiveEmbeddingBaseURL(rt RuntimeConfig) string {
	return rt.effectiveBaseURL(defaultEmbeddingBase(rt.ProviderKey))
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
