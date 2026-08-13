package assistant

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strings"
	"time"

	openai "github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/model"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// Runtime 站内 Assistant（Eino ReAct + UIMessageStream）。
type Runtime struct {
	client *ent.Client
	sql    *sql.DB
	log    *zap.Logger
	cfg    *config.Config
	gen    *ai.Generation
}

func NewRuntime(client *ent.Client, sqlDB *sql.DB, log *zap.Logger, cfg *config.Config) *Runtime {
	return &Runtime{
		client: client,
		sql:    sqlDB,
		log:    log,
		cfg:    cfg,
		gen:    ai.NewGeneration(cfg),
	}
}

func (r *Runtime) Health(c *gin.Context) {
	response.OK(c, gin.H{
		"runtime": "go",
		"stream":  "ui-message-v1",
		"status":  "ready",
	})
}

type chatRequest struct {
	Message string `json:"message" binding:"required,min=1"`
	ModelID *int64 `json:"modelId"`
}

type chatResponse struct {
	Reply   string   `json:"reply"`
	Runtime string   `json:"runtime"`
	Tools   []string `json:"tools"`
}

func (r *Runtime) resolveChatModelConfig(ctx context.Context, userID int64, modelID *int64) (*ent.AIModelConfig, error) {
	if modelID != nil {
		cfg, err := r.client.AIModelConfig.Query().
			Where(aimodelconfig.UserIDEQ(userID), aimodelconfig.IDEQ(*modelID)).
			Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return nil, response.NotFound("CHAT 配置不存在")
			}
			return nil, err
		}
		if cfg.ConfigType != "CHAT" {
			return nil, response.BadRequest("配置类型不是 CHAT")
		}
		if !cfg.Enabled {
			return nil, response.BadRequest("CHAT 配置未启用")
		}
		return cfg, nil
	}
	cfg, err := r.client.AIModelConfig.Query().
		Where(
			aimodelconfig.UserIDEQ(userID),
			aimodelconfig.EnabledEQ(true),
			aimodelconfig.IsDefaultEQ(true),
			aimodelconfig.ConfigTypeEQ("CHAT"),
		).
		Order(ent.Asc(aimodelconfig.FieldID)).
		First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.BadRequest("未找到可用的默认配置：CHAT")
		}
		return nil, err
	}
	return cfg, nil
}

func (r *Runtime) buildChatModel(ctx context.Context, cfg *ent.AIModelConfig) (model.ToolCallingChatModel, error) {
	if cfg == nil {
		return nil, response.BadRequest("缺少 CHAT 模型配置")
	}
	protocol := strings.ToUpper(strings.TrimSpace(cfg.Protocol))
	if protocol == "GEMINI" {
		return nil, response.BadRequest("GEMINI 协议已禁用，请使用 OPENAI / DEEPSEEK / OPENAI_COMPAT / SILICONFLOW")
	}
	switch protocol {
	case "OPENAI", "DEEPSEEK", "OPENAI_COMPAT", "SILICONFLOW":
	default:
		return nil, response.BadRequest("协议类型不能为空")
	}
	apiKey, err := r.gen.ResolveAPIKey(cfg)
	if err != nil {
		return nil, response.BadRequest(err.Error())
	}
	baseURL := ""
	if cfg.BaseURL != nil {
		baseURL = strings.TrimRight(strings.TrimSpace(*cfg.BaseURL), "/")
	}
	if apiKey == "" {
		return nil, response.BadRequest("AI 模型 API Key 为空")
	}
	if baseURL == "" {
		return nil, response.BadRequest("BaseUrl 不能为空")
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return nil, response.BadRequest("模型名称不能为空")
	}

	options := parseEinoChatOptions(cfg.ExtraJSON)
	if options.DisableThinkingForTools && isDeepSeekRuntimeConfig(protocol, baseURL, cfg.Model, cfg.Name) {
		options.Thinking = "disabled"
	}
	modelConfig := &openai.ChatModelConfig{
		Model:       cfg.Model,
		APIKey:      apiKey,
		BaseURL:     baseURL,
		Timeout:     120 * time.Second,
		MaxTokens:   options.MaxTokens,
		Temperature: options.Temperature,
	}
	if options.Thinking != "" {
		modelConfig.ExtraFields = map[string]any{
			"thinking": map[string]string{"type": options.Thinking},
		}
	}

	return openai.NewChatModel(ctx, modelConfig)
}

type einoChatOptions struct {
	MaxTokens               *int
	Temperature             *float32
	Thinking                string
	DisableThinkingForTools bool
}

func parseEinoChatOptions(raw *string) einoChatOptions {
	options := einoChatOptions{DisableThinkingForTools: true}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return options
	}
	var value map[string]any
	if json.Unmarshal([]byte(*raw), &value) != nil {
		return options
	}
	if parsed, ok := finiteNumber(firstRuntimeValue(value["maxTokens"], value["max_tokens"])); ok && parsed > 0 && parsed == math.Trunc(parsed) {
		integer := int(parsed)
		options.MaxTokens = &integer
	}
	if parsed, ok := finiteNumber(value["temperature"]); ok && parsed >= 0 && parsed <= 2 {
		temperature := float32(parsed)
		options.Temperature = &temperature
	}
	thinking := firstRuntimeValue(value["deepSeekThinking"], value["deepseekThinking"], value["thinking"])
	if deepSeek, ok := value["deepseek"].(map[string]any); ok {
		thinking = firstRuntimeValue(value["deepSeekThinking"], value["deepseekThinking"], deepSeek["thinking"], value["thinking"])
		options.DisableThinkingForTools = runtimeBool(firstRuntimeValue(
			value["disableDeepSeekThinkingForTools"],
			value["deepSeekDisableThinkingForTools"],
			deepSeek["disableThinkingForTools"],
		), true)
	} else {
		options.DisableThinkingForTools = runtimeBool(firstRuntimeValue(
			value["disableDeepSeekThinkingForTools"],
			value["deepSeekDisableThinkingForTools"],
		), true)
	}
	options.Thinking = normalizeRuntimeThinking(thinking)
	return options
}

func firstRuntimeValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func finiteNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

func normalizeRuntimeThinking(value any) string {
	if object, ok := value.(map[string]any); ok {
		return normalizeRuntimeThinking(object["type"])
	}
	if boolean, ok := value.(bool); ok {
		if boolean {
			return "enabled"
		}
		return "disabled"
	}
	text := strings.ToLower(strings.TrimSpace(toRuntimeString(value)))
	if text == "enabled" || text == "disabled" {
		return text
	}
	return ""
}

func runtimeBool(value any, fallback bool) bool {
	if boolean, ok := value.(bool); ok {
		return boolean
	}
	if text, ok := value.(string); ok {
		switch strings.ToLower(strings.TrimSpace(text)) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		}
	}
	return fallback
}

func isDeepSeekRuntimeConfig(protocol, baseURL, modelName, configName string) bool {
	if protocol == "DEEPSEEK" {
		return true
	}
	descriptor := strings.ToLower(modelName + " " + configName)
	if protocol == "SILICONFLOW" {
		return strings.Contains(strings.ToLower(modelName), "deepseek")
	}
	if protocol != "OPENAI" && protocol != "OPENAI_COMPAT" {
		return false
	}
	return strings.Contains(strings.ToLower(baseURL), "deepseek.com") || strings.Contains(descriptor, "deepseek")
}

func toRuntimeString(value any) string {
	if value == nil {
		return ""
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	return ""
}

func (r *Runtime) recallDeps() recallDeps {
	return recallDeps{SQL: r.sql, Gen: r.gen}
}
