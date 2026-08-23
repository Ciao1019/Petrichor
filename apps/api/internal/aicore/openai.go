package aicore

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	httpx "petrichor/api/internal/httpx"
)

// ChatMessage 对话消息；Parts 非空时为多模态内容。
type ChatMessage struct {
	Role    string      `json:"role"` // system | user | assistant
	Content string      `json:"content,omitempty"`
	Parts   []MediaPart `json:"-"`
}

// MediaPart 多模态片段。
type MediaPart struct {
	Type     string // text | image_url
	Text     string
	ImageURL string
	MIMEType string
	Data     []byte
}

// ChatResult 补全结果。
type ChatResult struct {
	Answer       string
	Reasoning    *string
	InputTokens  int64
	OutputTokens int64
}

var httpClient = &http.Client{Timeout: 300 * time.Second}

func (r RuntimeConfig) effectiveBaseURL(fallback string) string {
	if r.BaseURL != "" {
		return strings.TrimRight(r.BaseURL, "/")
	}
	return strings.TrimRight(fallback, "/")
}

func applyHeaders(req *http.Request, r RuntimeConfig, extra map[string]string) {
	req.Header.Set("Content-Type", "application/json")
	if r.APIKey != "" && !strings.EqualFold(r.ProviderKey, "ollama") && !strings.EqualFold(r.ProviderKey, "lmstudio") {
		req.Header.Set("Authorization", "Bearer "+r.APIKey)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	for k, v := range r.Headers {
		req.Header.Set(k, v)
	}
}

// ===== OpenAI 兼容协议 =====

type openAIChatRequest struct {
	Model          string            `json:"model"`
	Messages       []openAIMessage   `json:"messages"`
	Temperature    *float64          `json:"temperature,omitempty"`
	MaxTokens      *int64            `json:"max_tokens,omitempty"`
	Stream         bool              `json:"stream"`
	ResponseFormat *openAIRespFormat `json:"response_format,omitempty"`
	Thinking       *openAIThinking   `json:"thinking,omitempty"`
}

type openAIThinking struct {
	Type string `json:"type"`
}

type openAIRespFormat struct {
	Type string `json:"type"`
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string 或 parts 数组
}

func toOpenAIMessages(msgs []ChatMessage) []openAIMessage {
	out := make([]openAIMessage, 0, len(msgs))
	for _, m := range msgs {
		if len(m.Parts) == 0 {
			out = append(out, openAIMessage{Role: m.Role, Content: m.Content})
			continue
		}
		parts := make([]map[string]any, 0, len(m.Parts))
		for _, p := range m.Parts {
			switch p.Type {
			case "image_url":
				url := p.ImageURL
				if url == "" && len(p.Data) > 0 {
					mime := p.MIMEType
					if mime == "" {
						mime = "image/png"
					}
					url = "data:" + mime + ";base64," + b64(p.Data)
				}
				parts = append(parts, map[string]any{
					"type":      "image_url",
					"image_url": map[string]string{"url": url},
				})
			default:
				parts = append(parts, map[string]any{"type": "text", "text": p.Text})
			}
		}
		out = append(out, openAIMessage{Role: m.Role, Content: parts})
	}
	return out
}

// OpenAIChat 非流式补全（覆盖所有 openai-compatible sdk 与 openai chat 协议）。
func OpenAIChat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions) (*ChatResult, error) {
	body := openAIChatRequest{
		Model:       modelID,
		Messages:    toOpenAIMessages(msgs),
		Temperature: opts.Temperature,
		MaxTokens:   opts.MaxTokens,
	}
	applyQuirksToOpenAI(&body, rt, modelID, opts)

	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	url := rt.effectiveBaseURL(Catalog[rt.ProviderKey].DefaultBaseURL) + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	applyHeaders(req, rt, map[string]string{})
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, &httpx.HttpError{Status: 502, Message: fmt.Sprintf("模型调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content          *string `json:"content"`
				ReasoningContent *string `json:"reasoning_content"`
				Reasoning        *string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("响应解析失败：%w", err)
	}
	if len(parsed.Choices) == 0 {
		return nil, &httpx.HttpError{Status: 502, Message: "模型返回空结果"}
	}
	c := parsed.Choices[0]
	res := &ChatResult{InputTokens: parsed.Usage.PromptTokens, OutputTokens: parsed.Usage.CompletionTokens}
	if c.Message.Content != nil {
		res.Answer = *c.Message.Content
	}
	res.Reasoning = firstNonNil(c.Message.ReasoningContent, c.Message.Reasoning)
	return res, nil
}

// OpenAIChatStream 流式补全，逐段回调 delta 文本。
func OpenAIChatStream(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, onDelta func(string) error) (*ChatResult, error) {
	body := openAIChatRequest{Model: modelID, Messages: toOpenAIMessages(msgs), Temperature: opts.Temperature, MaxTokens: opts.MaxTokens, Stream: true}
	applyQuirksToOpenAI(&body, rt, modelID, opts)
	return doSSE(ctx, rt, rt.effectiveBaseURL(Catalog[rt.ProviderKey].DefaultBaseURL)+"/chat/completions", body, onDelta)
}

func doSSE(ctx context.Context, rt RuntimeConfig, url string, body any, onDelta func(string) error) (*ChatResult, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	applyHeaders(req, rt, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		return nil, &httpx.HttpError{Status: 502, Message: fmt.Sprintf("模型调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	res := &ChatResult{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          *string `json:"content"`
					ReasoningContent *string `json:"reasoning_content"`
					Reasoning        *string `json:"reasoning"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int64 `json:"prompt_tokens"`
				CompletionTokens int64 `json:"completion_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if chunk.Usage != nil {
			res.InputTokens = chunk.Usage.PromptTokens
			res.OutputTokens = chunk.Usage.CompletionTokens
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Content != nil && *choice.Delta.Content != "" {
				res.Answer += *choice.Delta.Content
				if err := onDelta(*choice.Delta.Content); err != nil {
					return res, err
				}
			}
			if r := firstNonNil(choice.Delta.ReasoningContent, choice.Delta.Reasoning); r != nil {
				res.Reasoning = r
			}
		}
	}
	return res, scanner.Err()
}

// applyQuirksToOpenAI 注入 thinking 开关（对应 provider-quirks.ts 的 injectThinkingFlag）。
func applyQuirksToOpenAI(body *openAIChatRequest, rt RuntimeConfig, modelID string, opts GenerationOptions) {
	q := ResolveQuirks(rt.ProviderKey, modelID)
	if !q.SupportsThinkingFlag {
		return
	}
	thinking := opts.Thinking
	if opts.DisableThinkingForTools != nil && *opts.DisableThinkingForTools {
		disabled := "disabled"
		thinking = &disabled
	}
	if thinking != nil && *thinking != "" {
		body.Thinking = &openAIThinking{Type: *thinking}
	}
}

// OpenAIEmbeddings 批量向量。
func OpenAIEmbeddings(ctx context.Context, rt RuntimeConfig, modelID string, texts []string) ([][]float32, error) {
	base := rt.effectiveBaseURL(defaultEmbeddingBase(rt.ProviderKey))
	payload := map[string]any{"model": modelID, "input": texts}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/embeddings", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	applyHeaders(req, rt, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, &httpx.HttpError{Status: 502, Message: fmt.Sprintf("向量调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	var parsed struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	out := make([][]float32, len(parsed.Data))
	for _, d := range parsed.Data {
		if d.Index < len(out) {
			out[d.Index] = d.Embedding
		}
	}
	return out, nil
}

func defaultEmbeddingBase(providerKey string) string {
	if e, ok := Catalog[providerKey]; ok && e.DefaultBaseURL != "" {
		return e.DefaultBaseURL
	}
	return ""
}

func firstNonNil(a, b *string) *string {
	if a != nil {
		return a
	}
	return b
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func b64(data []byte) string {
	const enc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var sb strings.Builder
	for i := 0; i < len(data); i += 3 {
		var b [3]byte
		copy(b[:], data[i:])
		v := uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2])
		sb.WriteByte(enc[(v>>18)&0x3F])
		sb.WriteByte(enc[(v>>12)&0x3F])
		if i+1 < len(data) {
			sb.WriteByte(enc[(v>>6)&0x3F])
		} else {
			sb.WriteByte('=')
		}
		if i+2 < len(data) {
			sb.WriteByte(enc[v&0x3F])
		} else {
			sb.WriteByte('=')
		}
	}
	return sb.String()
}
