package ai

import (
	"context"
	"strings"
	"time"

	openai "github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/model"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// NewToolCallingChatModel 根据 Petrichor CHAT 配置构造 Eino 工具调用模型。
// 当前支持的协议均为 OpenAI Chat Completions 兼容协议。
func (g *Generation) NewToolCallingChatModel(
	ctx context.Context,
	modelConfig *ent.AIModelConfig,
	temperatureOverride *float32,
) (model.ToolCallingChatModel, error) {
	if modelConfig == nil {
		return nil, response.BadRequest("缺少 CHAT 模型配置")
	}
	protocol := strings.ToUpper(strings.TrimSpace(modelConfig.Protocol))
	if protocol == "GEMINI" {
		return nil, response.BadRequest("GEMINI 协议已禁用，请使用 OPENAI / DEEPSEEK / OPENAI_COMPAT / SILICONFLOW")
	}
	switch protocol {
	case "OPENAI", "DEEPSEEK", "OPENAI_COMPAT", "SILICONFLOW":
	default:
		return nil, response.BadRequest("协议类型不能为空")
	}
	apiKey, err := g.ResolveAPIKey(modelConfig)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, response.BadRequest(modelConfig.ConfigType + " 配置缺少 API Key")
	}
	baseURL := ""
	if modelConfig.BaseURL != nil {
		baseURL = strings.TrimRight(strings.TrimSpace(*modelConfig.BaseURL), "/")
	}
	if baseURL == "" {
		return nil, response.BadRequest("BaseUrl 不能为空")
	}
	if strings.TrimSpace(modelConfig.Model) == "" {
		return nil, response.BadRequest("模型名称不能为空")
	}
	options := parseChatGenerationOptions(modelConfig.ExtraJSON)
	var temperature *float32
	if temperatureOverride != nil {
		temperature = temperatureOverride
	} else if options.Temperature != nil {
		value := float32(*options.Temperature)
		temperature = &value
	}
	config := &openai.ChatModelConfig{
		APIKey: apiKey, BaseURL: baseURL, Model: modelConfig.Model,
		Timeout: 120 * time.Second, MaxTokens: options.MaxTokens, Temperature: temperature,
	}
	if isDeepSeekConfig(protocol, baseURL, modelConfig.Model, modelConfig.Name) {
		// 带 tools 时 DeepSeek 思考模式兼容性不稳定；旧版默认同样关闭。
		config.ExtraFields = map[string]any{"thinking": map[string]string{"type": "disabled"}}
	}
	return openai.NewChatModel(ctx, config)
}
