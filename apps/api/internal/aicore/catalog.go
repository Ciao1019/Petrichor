package aicore

import (
	"encoding/json"

	jsoniter "github.com/json-iterator/go"
)

var jsonAPI = jsoniter.ConfigCompatibleWithStandardLibrary

func jsonStringify(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func jsonParse(data string, v any) error {
	return json.Unmarshal([]byte(data), v)
}

// SdkKind 模型工厂路由用的 SDK 类型（对应 provider-catalog.ts 的 sdk 字段）。
type SdkKind string

const (
	SDKOpenAI           SdkKind = "openai"
	SDKAnthropic        SdkKind = "anthropic"
	SDKGoogle           SdkKind = "google"
	SDKGoogleVertex     SdkKind = "google-vertex"
	SDKAzure            SdkKind = "azure"
	SDKBedrock          SdkKind = "amazon-bedrock"
	SDKOpenAICompatible SdkKind = "openai-compatible"
)

type catalogEntry struct {
	Sdk            SdkKind
	DefaultBaseURL string // 空串表示必须由用户配置
}

// Catalog 供应商目录（providerKey → 条目），与 TS provider-catalog.ts 对齐。
var Catalog = map[string]catalogEntry{
	"openai":          {SDKOpenAI, "https://api.openai.com/v1"},
	"anthropic":       {SDKAnthropic, "https://api.anthropic.com/v1"},
	"google":          {SDKGoogle, "https://generativelanguage.googleapis.com/v1beta"},
	"google-vertex":   {SDKGoogleVertex, ""},
	"azure":           {SDKAzure, ""},
	"amazon-bedrock":  {SDKBedrock, ""},
	"xai":             {SDKOpenAICompatible, "https://api.x.ai/v1"},
	"mistral":         {SDKOpenAICompatible, "https://api.mistral.ai/v1"},
	"cohere":          {SDKOpenAICompatible, "https://api.cohere.com/v2"},
	"groq":            {SDKOpenAICompatible, "https://api.groq.com/openai/v1"},
	"cerebras":        {SDKOpenAICompatible, "https://api.cerebras.ai/v1"},
	"deepseek":        {SDKOpenAICompatible, "https://api.deepseek.com/v1"},
	"deepinfra":       {SDKOpenAICompatible, "https://api.deepinfra.com/v1/openai"},
	"togetherai":      {SDKOpenAICompatible, "https://api.together.xyz/v1"},
	"fireworks":       {SDKOpenAICompatible, "https://api.fireworks.ai/inference/v1"},
	"perplexity":      {SDKOpenAICompatible, "https://api.perplexity.ai"},
	"baseten":         {SDKOpenAICompatible, "https://inference.baseten.co/v1"},
	"huggingface":     {SDKOpenAICompatible, "https://router.huggingface.co/v1"},
	"moonshotai":      {SDKOpenAICompatible, "https://api.moonshot.cn/v1"},
	"alibaba":         {SDKOpenAICompatible, "https://dashscope.aliyuncs.com/compatible-mode/v1"},
	"minimax":         {SDKOpenAICompatible, "https://api.minimax.chat/v1"},
	"voyage":          {SDKOpenAICompatible, "https://api.voyageai.com/v1"},
	"gateway":         {SDKOpenAICompatible, "https://ai-gateway.vercel.sh/v1"},
	"siliconflow":     {SDKOpenAICompatible, "https://api.siliconflow.cn/v1"},
	"openrouter":      {SDKOpenAICompatible, "https://openrouter.ai/api/v1"},
	"zhipu":           {SDKOpenAICompatible, "https://open.bigmodel.cn/api/paas/v4"},
	"volcengine":      {SDKOpenAICompatible, "https://ark.cn-beijing.volces.com/api/v3"},
	"ollama":          {SDKOpenAICompatible, "http://127.0.0.1:11434/v1"},
	"lmstudio":        {SDKOpenAICompatible, "http://127.0.0.1:1234/v1"},
	"openai-compatible": {SDKOpenAICompatible, ""},
}

// ResolveQuirks 对应 provider-quirks.ts 的 resolveQuirks。
type Quirks struct {
	DowngradeJSONSchema  bool
	SupportsThinkingFlag bool
}

func ResolveQuirks(providerKey, modelID string) Quirks {
	var q Quirks
	switch providerKey {
	case "deepseek":
		q = Quirks{true, true}
	case "siliconflow":
		q = Quirks{false, true}
	}
	if !q.DowngradeJSONSchema && containsFold(modelID, "deepseek") {
		q.DowngradeJSONSchema = true
		q.SupportsThinkingFlag = true
	}
	return q
}

func containsFold(s, sub string) bool {
	n := len(sub)
	if n == 0 {
		return true
	}
	sLower := []rune(s)
	subLower := []rune(sub)
	toLower := func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}
	for i := range sLower {
		if i+n > len(sLower) {
			break
		}
		match := true
		for j := 0; j < n; j++ {
			if toLower(sLower[i+j]) != toLower(subLower[j]) {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
