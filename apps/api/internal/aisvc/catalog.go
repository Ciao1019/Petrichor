// Package aisvc 是 /api/ai/* 全组接口的 Go 移植，对照 apps/web/src/server/ai/*。
// 本文件对应 provider-catalog.ts：供应商静态目录（含全部元数据）与纯函数。
package aisvc

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"petrichor/api/internal/aicore"
)

// CredentialField 供应商特有的额外凭证字段（Bedrock AK/SK、Vertex 服务账号等）。
type CredentialField struct {
	Key         string  `json:"key"`
	Label       string  `json:"label"`
	Placeholder *string `json:"placeholder,omitempty"`
	Required    bool    `json:"required"`
	Secret      bool    `json:"secret"`
}

// CatalogModel 内置兜底模型条目。
type CatalogModel struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind"`
	Label         *string  `json:"label,omitempty"`
	ContextWindow *int64   `json:"contextWindow,omitempty"`
	Capabilities  []string `json:"capabilities,omitempty"`
}

// ProviderDef 目录里的完整供应商定义。
type ProviderDef struct {
	Key              string
	Name             string
	Description      string
	Accent           string
	DefaultBaseURL   *string // nil 表示必须自己填
	BaseURLRequired  bool
	Sdk              aicore.SdkKind
	Kinds            []string
	APIProtocols     []string // nil 视为 ["chat"]；第一项是默认协议
	Listing          string   // openai | anthropic | google | cohere | none
	CredentialFields []CredentialField
	Models           []CatalogModel
	DocURL           string
}

func strPtr(s string) *string { return &s }
func i64Ptr(v int64) *int64   { return &v }

var bedrockFields = []CredentialField{
	{Key: "region", Label: "Region", Placeholder: strPtr("us-east-1"), Required: true},
	{Key: "accessKeyId", Label: "Access Key ID", Required: true},
	{Key: "secretAccessKey", Label: "Secret Access Key", Required: true, Secret: true},
	{Key: "sessionToken", Label: "Session Token（可选）", Required: false, Secret: true},
}

var vertexFields = []CredentialField{
	{Key: "project", Label: "GCP Project ID", Required: true},
	{Key: "location", Label: "Location", Placeholder: strPtr("us-central1"), Required: true},
	{Key: "clientEmail", Label: "Service Account Email", Required: true},
	{Key: "privateKey", Label: "Service Account Private Key", Required: true, Secret: true},
}

var azureFields = []CredentialField{
	{Key: "resourceName", Label: "资源名称", Placeholder: strPtr("my-openai-resource"), Required: true},
	{Key: "apiVersion", Label: "API Version（可选）", Placeholder: strPtr("2024-10-01-preview"), Required: false},
}

// ProviderCatalog 与 TS PROVIDER_CATALOG 一一对应的静态清单。
var ProviderCatalog = []ProviderDef{
	{
		Key: "openai", Name: "OpenAI",
		Description:      "GPT 系列、o 系列推理模型与 text-embedding 向量模型",
		Accent:           "emerald",
		DefaultBaseURL:   strPtr("https://api.openai.com/v1"),
		Sdk:              aicore.SDKOpenAI,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		APIProtocols:     []string{"chat", "responses"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://platform.openai.com/docs/models",
		Models: []CatalogModel{
			{ID: "gpt-5.2", Kind: "LANGUAGE", ContextWindow: i64Ptr(400000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
			{ID: "gpt-5.1", Kind: "LANGUAGE", ContextWindow: i64Ptr(400000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
			{ID: "gpt-5", Kind: "LANGUAGE", ContextWindow: i64Ptr(400000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
			{ID: "gpt-5-mini", Kind: "LANGUAGE", ContextWindow: i64Ptr(400000), Capabilities: []string{"tools", "vision", "json"}},
			{ID: "gpt-4.1", Kind: "LANGUAGE", ContextWindow: i64Ptr(1047576), Capabilities: []string{"tools", "vision", "json"}},
			{ID: "gpt-4o", Kind: "LANGUAGE", ContextWindow: i64Ptr(128000), Capabilities: []string{"tools", "vision", "json"}},
			{ID: "text-embedding-3-large", Kind: "EMBEDDING"},
			{ID: "text-embedding-3-small", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "anthropic", Name: "Anthropic",
		Description:      "Claude 系列，原生 /v1/messages，支持 prompt caching 与 thinking",
		Accent:           "orange",
		DefaultBaseURL:   strPtr("https://api.anthropic.com/v1"),
		Sdk:              aicore.SDKAnthropic,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "anthropic",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.anthropic.com/en/docs/about-claude/models",
		Models: []CatalogModel{
			{ID: "claude-opus-4-5", Kind: "LANGUAGE", ContextWindow: i64Ptr(200000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
			{ID: "claude-sonnet-4-5", Kind: "LANGUAGE", ContextWindow: i64Ptr(200000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
			{ID: "claude-haiku-4-5", Kind: "LANGUAGE", ContextWindow: i64Ptr(200000), Capabilities: []string{"tools", "vision", "json"}},
		},
	},
	{
		Key: "google", Name: "Google Gemini",
		Description:      "Gemini 系列，百万级上下文，原生多模态",
		Accent:           "blue",
		DefaultBaseURL:   strPtr("https://generativelanguage.googleapis.com/v1beta"),
		Sdk:              aicore.SDKGoogle,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "google",
		CredentialFields: []CredentialField{},
		DocURL:           "https://ai.google.dev/gemini-api/docs/models",
		Models: []CatalogModel{
			{ID: "gemini-2.5-pro", Kind: "LANGUAGE", ContextWindow: i64Ptr(2000000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
			{ID: "gemini-2.5-flash", Kind: "LANGUAGE", ContextWindow: i64Ptr(1000000), Capabilities: []string{"tools", "vision", "json"}},
			{ID: "text-embedding-004", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "google-vertex", Name: "Google Vertex AI",
		Description:      "GCP 托管的 Gemini 与 Claude，服务账号鉴权",
		Accent:           "blue",
		Sdk:              aicore.SDKGoogleVertex,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "none",
		CredentialFields: vertexFields,
		DocURL:           "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models",
		Models: []CatalogModel{
			{ID: "gemini-2.5-pro", Kind: "LANGUAGE", ContextWindow: i64Ptr(2000000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
			{ID: "gemini-2.5-flash", Kind: "LANGUAGE", ContextWindow: i64Ptr(1000000), Capabilities: []string{"tools", "vision", "json"}},
			{ID: "text-embedding-005", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "azure", Name: "Azure OpenAI",
		Description:      "Azure 托管的 OpenAI 模型，按部署名调用",
		Accent:           "cyan",
		Sdk:              aicore.SDKAzure,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		APIProtocols:     []string{"chat", "responses"},
		Listing:          "none",
		CredentialFields: azureFields,
		DocURL:           "https://learn.microsoft.com/azure/ai-services/openai/concepts/models",
		Models:           []CatalogModel{},
	},
	{
		Key: "amazon-bedrock", Name: "Amazon Bedrock",
		Description:      "AWS 托管的 Claude / Llama / Titan，SigV4 鉴权",
		Accent:           "amber",
		Sdk:              aicore.SDKBedrock,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "none",
		CredentialFields: bedrockFields,
		DocURL:           "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html",
		Models: []CatalogModel{
			{ID: "anthropic.claude-sonnet-4-5-20250929-v1:0", Kind: "LANGUAGE", ContextWindow: i64Ptr(200000), Capabilities: []string{"tools", "vision", "json"}},
			{ID: "amazon.titan-embed-text-v2:0", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "xai", Name: "xAI Grok",
		Description:      "Grok 系列，实时联网能力",
		Accent:           "slate",
		DefaultBaseURL:   strPtr("https://api.x.ai/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		APIProtocols:     []string{"chat", "responses"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.x.ai/docs/models",
		Models: []CatalogModel{
			{ID: "grok-4", Kind: "LANGUAGE", ContextWindow: i64Ptr(256000), Capabilities: []string{"tools", "vision", "reasoning", "json"}},
		},
	},
	{
		Key: "mistral", Name: "Mistral AI",
		Description:      "Mistral / Codestral 系列与 mistral-embed",
		Accent:           "orange",
		DefaultBaseURL:   strPtr("https://api.mistral.ai/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.mistral.ai/getting-started/models/models_overview/",
		Models: []CatalogModel{
			{ID: "mistral-large-latest", Kind: "LANGUAGE", ContextWindow: i64Ptr(128000), Capabilities: []string{"tools", "json"}},
			{ID: "mistral-embed", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "cohere", Name: "Cohere",
		Description:      "Command 系列与 embed 多语言向量模型",
		Accent:           "rose",
		DefaultBaseURL:   strPtr("https://api.cohere.com/v2"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "cohere",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.cohere.com/docs/models",
		Models: []CatalogModel{
			{ID: "command-a-03-2025", Kind: "LANGUAGE", ContextWindow: i64Ptr(256000), Capabilities: []string{"tools", "json"}},
			{ID: "embed-v4.0", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "groq", Name: "Groq",
		Description:      "LPU 超低延迟推理，托管开源模型",
		Accent:           "orange",
		DefaultBaseURL:   strPtr("https://api.groq.com/openai/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://console.groq.com/docs/models",
		Models:           []CatalogModel{},
	},
	{
		Key: "cerebras", Name: "Cerebras",
		Description:      "晶圆级芯片推理，极高吞吐",
		Accent:           "amber",
		DefaultBaseURL:   strPtr("https://api.cerebras.ai/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://inference-docs.cerebras.ai/introduction",
		Models:           []CatalogModel{},
	},
	{
		Key: "deepseek", Name: "DeepSeek",
		Description:      "深度求索官方接口，思考模式与非思考模式",
		Accent:           "violet",
		DefaultBaseURL:   strPtr("https://api.deepseek.com/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
		Models: []CatalogModel{
			{ID: "deepseek-chat", Kind: "LANGUAGE", ContextWindow: i64Ptr(1000000), Capabilities: []string{"tools", "json"}},
			{ID: "deepseek-reasoner", Kind: "LANGUAGE", ContextWindow: i64Ptr(1000000), Capabilities: []string{"tools", "reasoning", "json"}},
		},
	},
	{
		Key: "deepinfra", Name: "Deep Infra",
		Description:      "开源模型托管，按量计费",
		Accent:           "cyan",
		DefaultBaseURL:   strPtr("https://api.deepinfra.com/v1/openai"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://deepinfra.com/models",
		Models:           []CatalogModel{},
	},
	{
		Key: "togetherai", Name: "Together AI",
		Description:      "开源模型托管与微调平台",
		Accent:           "blue",
		DefaultBaseURL:   strPtr("https://api.together.xyz/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.together.ai/docs/serverless-models",
		Models:           []CatalogModel{},
	},
	{
		Key: "fireworks", Name: "Fireworks AI",
		Description:      "高性能开源模型推理",
		Accent:           "rose",
		DefaultBaseURL:   strPtr("https://api.fireworks.ai/inference/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://fireworks.ai/models",
		Models:           []CatalogModel{},
	},
	{
		Key: "perplexity", Name: "Perplexity",
		Description:      "Sonar 系列，内建联网检索与引用",
		Accent:           "cyan",
		DefaultBaseURL:   strPtr("https://api.perplexity.ai"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "none",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.perplexity.ai/getting-started/models",
		Models: []CatalogModel{
			{ID: "sonar-pro", Kind: "LANGUAGE", ContextWindow: i64Ptr(200000), Capabilities: []string{"json"}},
			{ID: "sonar", Kind: "LANGUAGE", ContextWindow: i64Ptr(128000), Capabilities: []string{"json"}},
			{ID: "sonar-reasoning-pro", Kind: "LANGUAGE", ContextWindow: i64Ptr(128000), Capabilities: []string{"reasoning", "json"}},
		},
	},
	{
		Key: "baseten", Name: "Baseten",
		Description:      "自托管模型部署平台",
		Accent:           "violet",
		DefaultBaseURL:   strPtr("https://inference.baseten.co/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.baseten.co/development/model-apis/overview",
		Models:           []CatalogModel{},
	},
	{
		Key: "huggingface", Name: "Hugging Face",
		Description:      "HF Router，聚合多家推理供应商",
		Accent:           "amber",
		DefaultBaseURL:   strPtr("https://router.huggingface.co/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://huggingface.co/docs/inference-providers",
		Models:           []CatalogModel{},
	},
	{
		Key: "moonshotai", Name: "Moonshot AI（Kimi）",
		Description:      "月之暗面 Kimi 系列",
		Accent:           "slate",
		DefaultBaseURL:   strPtr("https://api.moonshot.cn/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://platform.moonshot.cn/docs/intro",
		Models:           []CatalogModel{},
	},
	{
		Key: "alibaba", Name: "阿里云百炼（通义千问）",
		Description:      "DashScope 兼容模式，Qwen 全系与 text-embedding",
		Accent:           "orange",
		DefaultBaseURL:   strPtr("https://dashscope.aliyuncs.com/compatible-mode/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://help.aliyun.com/zh/model-studio/models",
		Models: []CatalogModel{
			{ID: "qwen-max", Kind: "LANGUAGE", ContextWindow: i64Ptr(128000), Capabilities: []string{"tools", "json"}},
			{ID: "qwen-plus", Kind: "LANGUAGE", ContextWindow: i64Ptr(128000), Capabilities: []string{"tools", "json"}},
			{ID: "text-embedding-v4", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "minimax", Name: "MiniMax",
		Description:      "MiniMax 稀宇科技，abab 与 MiniMax-M 系列",
		Accent:           "rose",
		DefaultBaseURL:   strPtr("https://api.minimax.chat/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "none",
		CredentialFields: []CredentialField{},
		DocURL:           "https://platform.minimaxi.com/document/introduction",
		Models: []CatalogModel{
			{ID: "MiniMax-M2", Kind: "LANGUAGE", ContextWindow: i64Ptr(200000), Capabilities: []string{"tools", "json"}},
		},
	},
	{
		Key: "voyage", Name: "Voyage AI",
		Description:      "专注检索的高质量向量与重排模型",
		Accent:           "violet",
		DefaultBaseURL:   strPtr("https://api.voyageai.com/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"EMBEDDING"},
		Listing:          "none",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.voyageai.com/docs/embeddings",
		Models: []CatalogModel{
			{ID: "voyage-3-large", Kind: "EMBEDDING"},
			{ID: "voyage-3.5", Kind: "EMBEDDING"},
			{ID: "voyage-code-3", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "gateway", Name: "Vercel AI Gateway",
		Description:      "一个 Key 直通数百个模型，自带故障转移与用量统计",
		Accent:           "slate",
		DefaultBaseURL:   strPtr("https://ai-gateway.vercel.sh/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://vercel.com/docs/ai-gateway",
		Models:           []CatalogModel{},
	},
	{
		Key: "siliconflow", Name: "SiliconFlow（硅基流动）",
		Description:      "国内开源模型聚合，含 bge-m3 等向量模型",
		Accent:           "blue",
		DefaultBaseURL:   strPtr("https://api.siliconflow.cn/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.siliconflow.cn/cn/userguide/introduction",
		Models: []CatalogModel{
			{ID: "BAAI/bge-m3", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "openrouter", Name: "OpenRouter",
		Description:      "全球模型聚合路由，单 Key 覆盖数百模型",
		Accent:           "violet",
		DefaultBaseURL:   strPtr("https://openrouter.ai/api/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://openrouter.ai/docs/models",
		Models:           []CatalogModel{},
	},
	{
		Key: "zhipu", Name: "智谱 AI（GLM）",
		Description:      "GLM 系列，开放平台兼容接口",
		Accent:           "cyan",
		DefaultBaseURL:   strPtr("https://open.bigmodel.cn/api/paas/v4"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://docs.bigmodel.cn/cn/guide/start/model-overview",
		Models: []CatalogModel{
			{ID: "glm-4.6", Kind: "LANGUAGE", ContextWindow: i64Ptr(200000), Capabilities: []string{"tools", "json"}},
			{ID: "embedding-3", Kind: "EMBEDDING"},
		},
	},
	{
		Key: "volcengine", Name: "火山方舟（豆包）",
		Description:      "字节跳动方舟平台，按推理接入点调用",
		Accent:           "rose",
		DefaultBaseURL:   strPtr("https://ark.cn-beijing.volces.com/api/v3"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://www.volcengine.com/docs/82379",
		Models:           []CatalogModel{},
	},
	{
		Key: "ollama", Name: "Ollama",
		Description:      "本地模型运行时，默认 11434 端口",
		Accent:           "slate",
		DefaultBaseURL:   strPtr("http://127.0.0.1:11434/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://github.com/ollama/ollama/blob/main/docs/openai.md",
		Models:           []CatalogModel{},
	},
	{
		Key: "lmstudio", Name: "LM Studio",
		Description:      "本地推理服务器，默认 1234 端口",
		Accent:           "slate",
		DefaultBaseURL:   strPtr("http://127.0.0.1:1234/v1"),
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		CredentialFields: []CredentialField{},
		DocURL:           "https://lmstudio.ai/docs/app/api/endpoints/openai",
		Models:           []CatalogModel{},
	},
	{
		Key: "openai-compatible", Name: "OpenAI 兼容（自定义）",
		Description:      "任意兼容 /v1/chat/completions 的端点，需自行填写 BaseUrl",
		Accent:           "amber",
		Sdk:              aicore.SDKOpenAICompatible,
		Kinds:            []string{"LANGUAGE", "EMBEDDING"},
		Listing:          "openai",
		BaseURLRequired:  true,
		CredentialFields: []CredentialField{},
		DocURL:           "https://ai-sdk.dev/providers/openai-compatible-providers",
		Models:           []CatalogModel{},
	},
}

var providerByKey = func() map[string]*ProviderDef {
	m := make(map[string]*ProviderDef, len(ProviderCatalog))
	for i := range ProviderCatalog {
		m[ProviderCatalog[i].Key] = &ProviderCatalog[i]
	}
	return m
}()

// FindProvider 按 key 找目录定义。
func FindProvider(key any) *ProviderDef {
	s := strings.TrimSpace(flexToString(key))
	if s == "" {
		return nil
	}
	return providerByKey[s]
}

// SupportedAPIProtocols 该供应商可选的语言模型协议。
func SupportedAPIProtocols(p *ProviderDef) []string {
	if p == nil {
		return []string{"chat"}
	}
	if len(p.APIProtocols) > 0 {
		return p.APIProtocols
	}
	return []string{"chat"}
}

// ResolveAPIProtocol 解析最终生效协议：非法或不支持时回落第一项。
func ResolveAPIProtocol(p *ProviderDef, override any) string {
	supported := SupportedAPIProtocols(p)
	value := strings.ToLower(strings.TrimSpace(flexToString(override)))
	for _, s := range supported {
		if s == value {
			return value
		}
	}
	return supported[0]
}

// ResolveBaseURL 最终生效 BaseUrl：用户覆盖优先，否则目录默认值；nil 表示无需 BaseUrl。
func ResolveBaseURL(p *ProviderDef, override any) *string {
	value := strings.TrimRight(strings.TrimSpace(flexToString(override)), "/")
	if value != "" {
		return &value
	}
	if p == nil {
		return nil
	}
	return p.DefaultBaseURL
}

// AssertBaseURLSatisfied 校验实例的 BaseUrl 是否满足要求。
func AssertBaseURLSatisfied(p *ProviderDef, baseURL *string) error {
	if p.BaseURLRequired {
		resolved := ResolveBaseURL(p, strVal(baseURL))
		if resolved == nil || *resolved == "" {
			return badRequestMsg("%s 必须填写 BaseUrl", p.Name)
		}
	}
	return nil
}

func strVal(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// ProviderAPIProtocol 供应商实例上生效的语言模型协议（存于 optionsJson.apiProtocol）。
func ProviderAPIProtocol(providerKey string, optionsJSON *string) string {
	p := FindProvider(providerKey)
	if p == nil {
		return "chat"
	}
	opts := storedJSONObject(optionsJSON)
	return ResolveAPIProtocol(p, opts["apiProtocol"])
}

// FindCatalogModel 在内置清单里按 id 找元信息。
func FindCatalogModel(p *ProviderDef, modelID string) *CatalogModel {
	value := strings.TrimSpace(modelID)
	for i := range p.Models {
		if p.Models[i].ID == value {
			return &p.Models[i]
		}
	}
	return nil
}

// GuessModelKind 从模型 id 猜测类型（在线 /models 不带类型信息）。
func GuessModelKind(modelID string) string {
	value := strings.ToLower(modelID)
	for _, hint := range []string{"embed", "bge-", "gte-", "e5-", "m3e", "jina-clip", "text2vec"} {
		if strings.Contains(value, hint) {
			return "EMBEDDING"
		}
	}
	return "LANGUAGE"
}

// GuessContextWindow 上下文窗口推断：内置清单优先，其次按家族特征兜底。
func GuessContextWindow(modelID string) int64 {
	m := strings.ToLower(modelID)
	switch {
	case strings.Contains(m, "claude"):
		return 200000
	case strings.Contains(m, "gemini-2"), strings.Contains(m, "gemini-1.5-pro"):
		return 2000000
	case strings.Contains(m, "gemini"):
		return 1000000
	case strings.Contains(m, "deepseek-v4"), strings.Contains(m, "deepseek-chat"), strings.Contains(m, "deepseek-reasoner"):
		return 1000000
	case strings.Contains(m, "deepseek-r1"), strings.Contains(m, "deepseek-v3"):
		return 64000
	case strings.Contains(m, "deepseek"):
		return 128000
	case strings.Contains(m, "qwen3.6"), strings.Contains(m, "qwen-3.6"):
		return 1000000
	case strings.Contains(m, "qwen"):
		return 128000
	case strings.Contains(m, "glm-5"):
		return 200000
	case strings.Contains(m, "glm-4"):
		return 128000
	case strings.Contains(m, "kimi"), strings.Contains(m, "moonshot"):
		return 128000
	case strings.Contains(m, "grok"):
		return 256000
	case strings.Contains(m, "gpt-5"), strings.Contains(m, "gpt-4.1"):
		return 400000
	case strings.Contains(m, "gpt-4o"), strings.Contains(m, "gpt-4-turbo"),
		regexp.MustCompile("^o1").MatchString(m), regexp.MustCompile("^o3").MatchString(m):
		return 128000
	case strings.Contains(m, "gpt-3.5"):
		return 16385
	default:
		return 128000
	}
}

type catalogSummary struct {
	Key                  string            `json:"key"`
	Name                 string            `json:"name"`
	Description          string            `json:"description"`
	Accent               string            `json:"accent"`
	DefaultBaseURL       *string           `json:"defaultBaseUrl"`
	BaseURLRequired      bool              `json:"baseUrlRequired"`
	Kinds                []string          `json:"kinds"`
	APIProtocols         []string          `json:"apiProtocols"`
	SupportsModelListing bool              `json:"supportsModelListing"`
	CredentialFields     []CredentialField `json:"credentialFields"`
	PresetModels         []CatalogModel    `json:"presetModels"`
	DocURL               string            `json:"docUrl"`
}

func toCatalogSummary(p *ProviderDef) catalogSummary {
	return catalogSummary{
		Key:                  p.Key,
		Name:                 p.Name,
		Description:          p.Description,
		Accent:               p.Accent,
		DefaultBaseURL:       p.DefaultBaseURL,
		BaseURLRequired:      p.BaseURLRequired,
		Kinds:                p.Kinds,
		APIProtocols:         SupportedAPIProtocols(p),
		SupportsModelListing: p.Listing != "none",
		CredentialFields:     p.CredentialFields,
		PresetModels:         p.Models,
		DocURL:               p.DocURL,
	}
}

func listCatalogSummaries() []catalogSummary {
	out := make([]catalogSummary, 0, len(ProviderCatalog))
	for i := range ProviderCatalog {
		out = append(out, toCatalogSummary(&ProviderCatalog[i]))
	}
	return out
}

// flexToString 复刻 String(raw ?? "")：任意入参转字符串。
func flexToString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}
