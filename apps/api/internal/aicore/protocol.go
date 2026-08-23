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

	httpx "petrichor/api/internal/httpx"
)

// 统一的多协议调用层：OpenAI 兼容 / Anthropic Messages / Google Gemini。

type sseDeltaFunc func(payload string) (delta string, done bool)
type nonStreamParser func(data []byte) (*ChatResult, error)

type protocolRequest struct {
	URL       string
	Body      []byte
	Query     map[string]string
	Headers   map[string]string
	BearerKey string // 非空时设置 Authorization: Bearer
}

func executeProtocol(ctx context.Context, reqMeta protocolRequest, stream bool, onDelta func(string) error, parseFull nonStreamParser, parseSSE sseDeltaFunc) (*ChatResult, error) {
	urlStr := reqMeta.URL
	if len(reqMeta.Query) > 0 {
		q := urlValues()
		for k, v := range reqMeta.Query {
			q.Set(k, v)
		}
		urlStr += "?" + q.Encode()
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, urlStr, bytes.NewReader(reqMeta.Body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	for k, v := range reqMeta.Headers {
		httpReq.Header.Set(k, v)
	}
	if reqMeta.BearerKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+reqMeta.BearerKey)
	}
	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		return nil, &httpx.HttpError{Status: 502, Message: fmt.Sprintf("模型调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}

	if !stream {
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		return parseFull(data)
	}

	res := &ChatResult{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		delta, done := parseSSE(payload)
		if delta != "" {
			res.Answer += delta
			if onDelta != nil {
				if err := onDelta(delta); err != nil {
					return res, err
				}
			}
		}
		if done {
			break
		}
	}
	return res, scanner.Err()
}

// ===== Anthropic =====

func anthropicChat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, stream bool, onDelta func(string) error) (*ChatResult, error) {
	system := ""
	apiMsgs := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == "system" && system == "" {
			system = m.Content
			continue
		}
		if len(m.Parts) > 0 {
			content := make([]map[string]any, 0, len(m.Parts))
			for _, p := range m.Parts {
				switch p.Type {
				case "image_url":
					src := map[string]any{"type": "url", "url": p.ImageURL}
					if len(p.Data) > 0 {
						mime := p.MIMEType
						if mime == "" {
							mime = "image/png"
						}
						src = map[string]any{"type": "base64", "media_type": mime, "data": b64(p.Data)}
					}
					content = append(content, map[string]any{"type": "image", "source": src})
				default:
					content = append(content, map[string]any{"type": "text", "text": p.Text})
				}
			}
			apiMsgs = append(apiMsgs, map[string]any{"role": m.Role, "content": content})
			continue
		}
		apiMsgs = append(apiMsgs, map[string]any{"role": m.Role, "content": m.Content})
	}

	maxTokens := pickMax(opts.MaxTokens, 8192)
	body := map[string]any{
		"model": modelID, "max_tokens": maxTokens, "messages": apiMsgs, "stream": stream,
	}
	if system != "" {
		body["system"] = system
	}
	if opts.Temperature != nil {
		body["temperature"] = *opts.Temperature
	}

	raw, _ := json.Marshal(body)
	return executeProtocol(ctx, protocolRequest{
		URL:     rt.effectiveBaseURL("https://api.anthropic.com/v1") + "/messages",
		Body:    raw,
		Headers: map[string]string{"x-api-key": rt.APIKey, "anthropic-version": "2023-06-01"},
	}, stream, onDelta, parseAnthropicResponse, anthropicSSEDelta)
}

func parseAnthropicResponse(data []byte) (*ChatResult, error) {
	var parsed struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
		Type  string                    `json:"type"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("%s", parsed.Error.Message)
	}
	res := &ChatResult{InputTokens: parsed.Usage.InputTokens, OutputTokens: parsed.Usage.OutputTokens}
	var sb strings.Builder
	for _, c := range parsed.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	res.Answer = sb.String()
	return res, nil
}

func anthropicSSEDelta(payload string) (string, bool) {
	var evt struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	}
	if err := json.Unmarshal([]byte(payload), &evt); err != nil {
		return "", false
	}
	switch evt.Type {
	case "content_block_delta":
		if evt.Delta.Type == "text_delta" {
			return evt.Delta.Text, false
		}
	case "message_stop":
		return "", true
	}
	return "", false
}

// ===== Google Gemini =====

type gInlineMedia struct {
	MIMEType string `json:"mimeType"`
	Data     string `json:"data"`
}
type gPart struct {
	Text       string        `json:"text,omitempty"`
	InlineData *gInlineMedia `json:"inlineData,omitempty"`
}
type gContent struct {
	Role  string  `json:"role"`
	Parts []gPart `json:"parts"`
}

func googleChat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, stream bool, onDelta func(string) error) (*ChatResult, error) {
	contents := make([]gContent, 0, len(msgs))
	system := ""
	for _, m := range msgs {
		if m.Role == "system" && system == "" {
			system = m.Content
			continue
		}
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		if len(m.Parts) == 0 {
			contents = append(contents, gContent{Role: role, Parts: []gPart{{Text: m.Content}}})
			continue
		}
		parts := make([]gPart, 0, len(m.Parts))
		for _, p := range m.Parts {
			if p.Type == "image_url" && len(p.Data) > 0 && p.ImageURL == "" {
				mime := p.MIMEType
				if mime == "" {
					mime = "image/png"
				}
				parts = append(parts, gPart{InlineData: &gInlineMedia{MIMEType: mime, Data: b64(p.Data)}})
			} else if p.Type == "image_url" {
				parts = append(parts, gPart{Text: "[image: " + p.ImageURL + "]"})
			} else {
				parts = append(parts, gPart{Text: p.Text})
			}
		}
		contents = append(contents, gContent{Role: role, Parts: parts})
	}
	body := map[string]any{
		"contents":         contents,
		"generationConfig": map[string]any{"maxOutputTokens": pickMax(opts.MaxTokens, 8192)},
	}
	if system != "" {
		body["systemInstruction"] = map[string]any{"parts": []gPart{{Text: system}}}
	}
	action := ":generateContent"
	query := map[string]string{"key": rt.APIKey}
	if stream {
		// alt=sse 必须走 Query 拼接；直接嵌进 URL 会与 executeProtocol 追加的 key= 产生双问号
		action = ":streamGenerateContent"
		query["alt"] = "sse"
	}
	raw, _ := json.Marshal(body)
	base := rt.effectiveBaseURL("https://generativelanguage.googleapis.com/v1beta")
	return executeProtocol(ctx, protocolRequest{
		URL:   base + "/models/" + modelID + action,
		Body:  raw,
		Query: query,
	}, stream, onDelta, parseGoogleResponse, googleSSEDelta)
}

func parseGoogleResponse(data []byte) (*ChatResult, error) {
	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount     int64 `json:"promptTokenCount"`
			CandidatesTokenCount int64 `json:"candidatesTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	res := &ChatResult{InputTokens: parsed.UsageMetadata.PromptTokenCount, OutputTokens: parsed.UsageMetadata.CandidatesTokenCount}
	for _, c := range parsed.Candidates {
		for _, p := range c.Content.Parts {
			res.Answer += p.Text
		}
	}
	return res, nil
}

func googleSSEDelta(payload string) (string, bool) {
	res, err := parseGoogleResponse([]byte(payload))
	if err != nil || res == nil || res.Answer == "" {
		return "", false
	}
	return res.Answer, false
}

func pickMax(v *int64, def int64) int64 {
	if v == nil || *v <= 0 {
		return def
	}
	return *v
}
