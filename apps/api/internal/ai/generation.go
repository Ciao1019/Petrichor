package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/crypto"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model    string
	Messages []ChatMessage
	Stream   bool
}

type ChatUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	TotalTokens  int `json:"totalTokens"`
}

type ChatResponse struct {
	Content   string
	Reasoning *string
	ModelName string
	Usage     ChatUsage
	Raw       json.RawMessage
}

type Generation struct {
	cfg        *config.Config
	httpClient *http.Client
}

func NewGeneration(cfg *config.Config) *Generation {
	return &Generation{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// NewGenerationWithHTTPClient 仅供组件测试注入 HTTP 客户端；业务代码使用 NewGeneration。
func NewGenerationWithHTTPClient(cfg *config.Config, client *http.Client) *Generation {
	gen := NewGeneration(cfg)
	if client != nil {
		gen.httpClient = client
	}
	return gen
}

func (g *Generation) ResolveAPIKey(modelCfg *ent.AIModelConfig) (string, error) {
	if modelCfg.APIKeyEnc == nil || strings.TrimSpace(*modelCfg.APIKeyEnc) == "" {
		return "", response.BadRequest(modelCfg.ConfigType + " 配置缺少 API Key")
	}
	raw := strings.TrimSpace(*modelCfg.APIKeyEnc)
	// 兼容 Go 重构早期曾写入的明文。
	if !looksLikeHexCipher(raw) {
		return raw, nil
	}
	if g.cfg.EncryptKey == "" || g.cfg.EncryptSalt == "" {
		return "", fmt.Errorf("缺少 PETRICHOR_ENCRYPT_KEY/SALT，无法解密 API Key")
	}
	return crypto.DecryptText(g.cfg.EncryptKey, g.cfg.EncryptSalt, raw)
}

type chatGenerationOptions struct {
	MaxTokens        *int
	Temperature      *float64
	DeepSeekThinking string
}

func (g *Generation) Chat(ctx context.Context, modelCfg *ent.AIModelConfig, messages []ChatMessage) (*ChatResponse, error) {
	request, err := g.newChatHTTPRequest(ctx, modelCfg, messages, false, nil)
	if err != nil {
		return nil, err
	}
	httpResponse, err := g.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer httpResponse.Body.Close()
	raw, err := io.ReadAll(httpResponse.Body)
	if err != nil {
		return nil, err
	}
	if httpResponse.StatusCode >= 300 {
		return nil, response.BadRequest(fmt.Sprintf("调用 Chat 接口失败：HTTP %d", httpResponse.StatusCode))
	}
	var parsed struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			CompletionTokens int `json:"completion_tokens"`
			PromptTokens     int `json:"prompt_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	content := ""
	var reasoning *string
	if len(parsed.Choices) > 0 {
		content = strings.TrimSpace(parsed.Choices[0].Message.Content)
		value := strings.TrimSpace(parsed.Choices[0].Message.ReasoningContent)
		if value == "" {
			value = strings.TrimSpace(parsed.Choices[0].Message.Reasoning)
		}
		if value != "" {
			reasoning = &value
		}
	}
	modelName := strings.TrimSpace(parsed.Model)
	if modelName == "" {
		modelName = modelCfg.Model
	}
	return &ChatResponse{
		Content:   content,
		Reasoning: reasoning,
		ModelName: modelName,
		Usage: ChatUsage{
			InputTokens:  parsed.Usage.PromptTokens,
			OutputTokens: parsed.Usage.CompletionTokens,
			TotalTokens:  parsed.Usage.TotalTokens,
		},
		Raw: raw,
	}, nil
}

// StreamChat 将 OpenAI 兼容上游的 SSE 文本增量逐块交给调用方。
func (g *Generation) StreamChat(
	ctx context.Context,
	modelCfg *ent.AIModelConfig,
	messages []ChatMessage,
	temperature *float64,
	onDelta func(string) error,
) error {
	request, err := g.newChatHTTPRequest(ctx, modelCfg, messages, true, temperature)
	if err != nil {
		return err
	}
	httpResponse, err := g.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer httpResponse.Body.Close()
	if httpResponse.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, httpResponse.Body)
		return response.BadRequest(fmt.Sprintf("调用 Chat 接口失败：HTTP %d", httpResponse.StatusCode))
	}

	scanner := bufio.NewScanner(httpResponse.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var event struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return fmt.Errorf("解析模型流式响应失败: %w", err)
		}
		for _, choice := range event.Choices {
			if choice.Delta.Content != "" {
				if err := onDelta(choice.Delta.Content); err != nil {
					return err
				}
			}
		}
	}
	return scanner.Err()
}

func (g *Generation) newChatHTTPRequest(
	ctx context.Context,
	modelCfg *ent.AIModelConfig,
	messages []ChatMessage,
	stream bool,
	temperatureOverride *float64,
) (*http.Request, error) {
	if modelCfg == nil {
		return nil, response.BadRequest("缺少 CHAT 模型配置")
	}
	protocol := strings.ToUpper(strings.TrimSpace(modelCfg.Protocol))
	if protocol == "GEMINI" {
		return nil, response.BadRequest("GEMINI 协议已禁用，请使用 OPENAI / DEEPSEEK / OPENAI_COMPAT / SILICONFLOW")
	}
	switch protocol {
	case "OPENAI", "DEEPSEEK", "OPENAI_COMPAT", "SILICONFLOW":
	default:
		return nil, response.BadRequest("协议类型不能为空")
	}
	apiKey, err := g.ResolveAPIKey(modelCfg)
	if err != nil {
		return nil, err
	}
	if modelCfg.BaseURL == nil || strings.TrimSpace(*modelCfg.BaseURL) == "" {
		return nil, response.BadRequest("BaseUrl 不能为空")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(*modelCfg.BaseURL), "/")
	if strings.TrimSpace(modelCfg.Model) == "" {
		return nil, response.BadRequest("模型名称不能为空")
	}
	options := parseChatGenerationOptions(modelCfg.ExtraJSON)
	body := map[string]any{
		"model":    modelCfg.Model,
		"messages": messages,
		"stream":   stream,
	}
	if options.MaxTokens != nil {
		body["max_tokens"] = *options.MaxTokens
	}
	if temperatureOverride != nil {
		body["temperature"] = *temperatureOverride
	} else if options.Temperature != nil {
		body["temperature"] = *options.Temperature
	}
	if isDeepSeekConfig(protocol, baseURL, modelCfg.Model, modelCfg.Name) && options.DeepSeekThinking != "" {
		body["thinking"] = map[string]string{"type": options.DeepSeekThinking}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	return request, nil
}

func parseChatGenerationOptions(raw *string) chatGenerationOptions {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return chatGenerationOptions{}
	}
	var value map[string]any
	if json.Unmarshal([]byte(*raw), &value) != nil {
		return chatGenerationOptions{}
	}
	options := chatGenerationOptions{}
	if parsed, ok := numberValue(firstNonNil(value["maxTokens"], value["max_tokens"])); ok && parsed > 0 && parsed == math.Trunc(parsed) {
		integer := int(parsed)
		options.MaxTokens = &integer
	}
	if parsed, ok := numberValue(value["temperature"]); ok {
		options.Temperature = &parsed
	}
	thinking := firstNonNil(value["deepSeekThinking"], value["deepseekThinking"], value["thinking"])
	if deepSeek, ok := value["deepseek"].(map[string]any); ok {
		thinking = firstNonNil(value["deepSeekThinking"], value["deepseekThinking"], deepSeek["thinking"], value["thinking"])
	}
	options.DeepSeekThinking = normalizeThinking(thinking)
	return options
}

func normalizeThinking(value any) string {
	if object, ok := value.(map[string]any); ok {
		return normalizeThinking(object["type"])
	}
	if boolean, ok := value.(bool); ok {
		if boolean {
			return "enabled"
		}
		return "disabled"
	}
	text := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	if text == "enabled" || text == "disabled" {
		return text
	}
	return ""
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func isDeepSeekConfig(protocol, baseURL, model, name string) bool {
	if protocol == "DEEPSEEK" {
		return true
	}
	descriptor := strings.ToLower(model + " " + name)
	if protocol == "SILICONFLOW" {
		return strings.Contains(strings.ToLower(model), "deepseek")
	}
	if protocol != "OPENAI" && protocol != "OPENAI_COMPAT" {
		return false
	}
	lowerBaseURL := strings.ToLower(baseURL)
	return strings.Contains(lowerBaseURL, "deepseek.com") || strings.Contains(descriptor, "deepseek")
}

func looksLikeHexCipher(s string) bool {
	if len(s) < 64 || len(s)%2 != 0 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
