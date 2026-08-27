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

// 本文件补齐 Anthropic Messages 与 Google Gemini 的原生工具调用协议。
// Eino 只负责编排循环；供应商 wire format 仍集中在 aicore，避免 Runtime 出现分叉实现。

// ===== Anthropic =====

type anthropicToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
}

func anthropicToolsPayload(tools []ToolDefinition) []anthropicToolSpec {
	out := make([]anthropicToolSpec, 0, len(tools))
	for _, item := range tools {
		schema := item.Parameters
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, anthropicToolSpec{Name: item.Name, Description: item.Description, InputSchema: schema})
	}
	return out
}

func toAnthropicToolMessages(msgs []ChatMessage) (string, []map[string]any) {
	systemParts := make([]string, 0, 2)
	out := make([]map[string]any, 0, len(msgs))
	for _, message := range msgs {
		if message.Role == "system" {
			if strings.TrimSpace(message.Content) != "" {
				systemParts = append(systemParts, message.Content)
			}
			continue
		}

		switch message.Role {
		case "assistant":
			blocks := make([]map[string]any, 0, len(message.ToolCalls)+1)
			if message.Content != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": message.Content})
			}
			for _, call := range message.ToolCalls {
				input := map[string]any{}
				if strings.TrimSpace(call.ArgsJSON) != "" {
					_ = json.Unmarshal([]byte(call.ArgsJSON), &input)
				}
				blocks = append(blocks, map[string]any{
					"type": "tool_use", "id": call.ID, "name": call.Name, "input": input,
				})
			}
			if len(blocks) > 0 {
				out = append(out, map[string]any{"role": "assistant", "content": blocks})
			}
		case "tool":
			out = append(out, map[string]any{
				"role": "user",
				"content": []map[string]any{{
					"type": "tool_result", "tool_use_id": message.ToolCallID, "content": message.Content,
				}},
			})
		default:
			out = append(out, map[string]any{"role": "user", "content": message.Content})
		}
	}
	return strings.Join(systemParts, "\n\n"), out
}

func anthropicChatWithTools(
	ctx context.Context,
	rt RuntimeConfig,
	modelID string,
	msgs []ChatMessage,
	opts GenerationOptions,
	tools []ToolDefinition,
	stream bool,
	onDelta func(string) error,
) (*ChatResult, error) {
	system, messages := toAnthropicToolMessages(msgs)
	body := map[string]any{
		"model": modelID, "max_tokens": pickMax(opts.MaxTokens, 8192),
		"messages": messages, "tools": anthropicToolsPayload(tools), "stream": stream,
	}
	if system != "" {
		body["system"] = system
	}
	if opts.Temperature != nil {
		body["temperature"] = *opts.Temperature
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		rt.effectiveBaseURL("https://api.anthropic.com/v1")+"/messages", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", rt.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	for key, value := range rt.Headers {
		req.Header.Set(key, value)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		return nil, &httpx.HttpError{Status: 502, Message: fmt.Sprintf("模型调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	if !stream {
		data, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			return nil, readErr
		}
		return parseAnthropicToolResponse(data)
	}
	return readAnthropicToolStream(resp.Body, onDelta)
}

func parseAnthropicToolResponse(data []byte) (*ChatResult, error) {
	var payload struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
		Usage struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	if payload.Error != nil {
		return nil, fmt.Errorf("%s", payload.Error.Message)
	}
	result := &ChatResult{InputTokens: payload.Usage.InputTokens, OutputTokens: payload.Usage.OutputTokens}
	for _, block := range payload.Content {
		switch block.Type {
		case "text":
			result.Answer += block.Text
		case "tool_use":
			args := string(block.Input)
			if strings.TrimSpace(args) == "" || args == "null" {
				args = "{}"
			}
			result.ToolCalls = append(result.ToolCalls, ToolCall{ID: block.ID, Name: block.Name, ArgsJSON: args})
		}
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
	return result, nil
}

type anthropicStreamTool struct {
	id   string
	name string
	args strings.Builder
}

func readAnthropicToolStream(body io.Reader, onDelta func(string) error) (*ChatResult, error) {
	result := &ChatResult{}
	toolBlocks := map[int]*anthropicStreamTool{}
	order := make([]int, 0, 4)
	scanner := bufio.NewScanner(body)
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
		var event struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message struct {
				Usage struct {
					InputTokens  int64 `json:"input_tokens"`
					OutputTokens int64 `json:"output_tokens"`
				} `json:"usage"`
			} `json:"message"`
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
			} `json:"delta"`
			Usage struct {
				InputTokens  int64 `json:"input_tokens"`
				OutputTokens int64 `json:"output_tokens"`
			} `json:"usage"`
			Error *struct{ Message string } `json:"error"`
		}
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		if event.Error != nil {
			return result, fmt.Errorf("%s", event.Error.Message)
		}
		switch event.Type {
		case "message_start":
			result.InputTokens = event.Message.Usage.InputTokens
			result.OutputTokens = event.Message.Usage.OutputTokens
		case "content_block_start":
			if event.ContentBlock.Type == "tool_use" {
				toolBlocks[event.Index] = &anthropicStreamTool{id: event.ContentBlock.ID, name: event.ContentBlock.Name}
				order = append(order, event.Index)
			}
		case "content_block_delta":
			switch event.Delta.Type {
			case "text_delta":
				if event.Delta.Text != "" {
					result.Answer += event.Delta.Text
					if onDelta != nil {
						if err := onDelta(event.Delta.Text); err != nil {
							return result, err
						}
					}
				}
			case "input_json_delta":
				if call := toolBlocks[event.Index]; call != nil {
					call.args.WriteString(event.Delta.PartialJSON)
				}
			}
		case "message_delta":
			if event.Usage.InputTokens > 0 {
				result.InputTokens = event.Usage.InputTokens
			}
			if event.Usage.OutputTokens > 0 {
				result.OutputTokens = event.Usage.OutputTokens
			}
		case "error":
			return result, fmt.Errorf("Anthropic 流式响应返回错误")
		}
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	for _, index := range order {
		call := toolBlocks[index]
		if call == nil || (call.id == "" && call.name == "") {
			continue
		}
		args := call.args.String()
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		result.ToolCalls = append(result.ToolCalls, ToolCall{ID: call.id, Name: call.name, ArgsJSON: args})
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
	return result, nil
}

// ===== Google Gemini =====

type googleToolPart struct {
	Text             string                  `json:"text,omitempty"`
	FunctionCall     *googleFunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *googleFunctionResponse `json:"functionResponse,omitempty"`
}

type googleFunctionCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type googleFunctionResponse struct {
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

func googleToolDeclarations(tools []ToolDefinition) []map[string]any {
	declarations := make([]map[string]any, 0, len(tools))
	for _, item := range tools {
		var parameters any = map[string]any{"type": "object", "properties": map[string]any{}}
		if len(item.Parameters) > 0 {
			_ = json.Unmarshal(item.Parameters, &parameters)
		}
		declarations = append(declarations, map[string]any{
			"name": item.Name, "description": item.Description, "parameters": parameters,
		})
	}
	return []map[string]any{{"functionDeclarations": declarations}}
}

func toGoogleToolContents(msgs []ChatMessage) (string, []map[string]any) {
	systemParts := make([]string, 0, 2)
	contents := make([]map[string]any, 0, len(msgs))
	callNames := map[string]string{}
	for _, message := range msgs {
		if message.Role == "system" {
			if strings.TrimSpace(message.Content) != "" {
				systemParts = append(systemParts, message.Content)
			}
			continue
		}
		switch message.Role {
		case "assistant":
			parts := make([]googleToolPart, 0, len(message.ToolCalls)+1)
			if message.Content != "" {
				parts = append(parts, googleToolPart{Text: message.Content})
			}
			for _, call := range message.ToolCalls {
				args := map[string]any{}
				if strings.TrimSpace(call.ArgsJSON) != "" {
					_ = json.Unmarshal([]byte(call.ArgsJSON), &args)
				}
				callNames[call.ID] = call.Name
				parts = append(parts, googleToolPart{FunctionCall: &googleFunctionCall{Name: call.Name, Args: args}})
			}
			contents = append(contents, map[string]any{"role": "model", "parts": parts})
		case "tool":
			name := callNames[message.ToolCallID]
			if name == "" {
				name = message.ToolCallID
			}
			response := map[string]any{"result": message.Content}
			var parsed any
			if json.Unmarshal([]byte(message.Content), &parsed) == nil {
				response["result"] = parsed
			}
			contents = append(contents, map[string]any{
				"role": "user", "parts": []googleToolPart{{FunctionResponse: &googleFunctionResponse{Name: name, Response: response}}},
			})
		default:
			contents = append(contents, map[string]any{"role": "user", "parts": []googleToolPart{{Text: message.Content}}})
		}
	}
	return strings.Join(systemParts, "\n\n"), contents
}

func googleChatWithTools(
	ctx context.Context,
	rt RuntimeConfig,
	modelID string,
	msgs []ChatMessage,
	opts GenerationOptions,
	tools []ToolDefinition,
	stream bool,
	onDelta func(string) error,
) (*ChatResult, error) {
	system, contents := toGoogleToolContents(msgs)
	generation := map[string]any{"maxOutputTokens": pickMax(opts.MaxTokens, 8192)}
	if opts.Temperature != nil {
		generation["temperature"] = *opts.Temperature
	}
	body := map[string]any{
		"contents": contents, "tools": googleToolDeclarations(tools), "generationConfig": generation,
	}
	if system != "" {
		body["systemInstruction"] = map[string]any{"parts": []map[string]string{{"text": system}}}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	action := ":generateContent"
	query := urlValues()
	query.Set("key", rt.APIKey)
	if stream {
		action = ":streamGenerateContent"
		query.Set("alt", "sse")
	}
	requestURL := rt.effectiveBaseURL("https://generativelanguage.googleapis.com/v1beta") + "/models/" + modelID + action + "?" + query.Encode()
	headers := map[string]string{}
	for key, value := range rt.Headers {
		headers[key] = value
	}
	return executeGoogleToolProtocol(ctx, requestURL, headers, raw, stream, onDelta)
}

func parseGoogleToolResponse(data []byte, callOffset int) (*ChatResult, error) {
	var payload struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text         string              `json:"text"`
					FunctionCall *googleFunctionCall `json:"functionCall"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		Usage struct {
			Prompt     int64 `json:"promptTokenCount"`
			Candidates int64 `json:"candidatesTokenCount"`
		} `json:"usageMetadata"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	if payload.Error != nil {
		return nil, fmt.Errorf("%s", payload.Error.Message)
	}
	result := &ChatResult{InputTokens: payload.Usage.Prompt, OutputTokens: payload.Usage.Candidates}
	callIndex := callOffset
	for _, candidate := range payload.Candidates {
		for _, part := range candidate.Content.Parts {
			result.Answer += part.Text
			if part.FunctionCall == nil {
				continue
			}
			args, _ := json.Marshal(part.FunctionCall.Args)
			result.ToolCalls = append(result.ToolCalls, ToolCall{
				ID:   fmt.Sprintf("gemini-call-%d-%s", callIndex, part.FunctionCall.Name),
				Name: part.FunctionCall.Name, ArgsJSON: string(args),
			})
			callIndex++
		}
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
	return result, nil
}

func readGoogleToolStream(body io.Reader, onDelta func(string) error) (*ChatResult, error) {
	result := &ChatResult{}
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	callOffset := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		chunk, err := parseGoogleToolResponse([]byte(payload), callOffset)
		if err != nil {
			continue
		}
		if chunk.InputTokens > 0 {
			result.InputTokens = chunk.InputTokens
		}
		if chunk.OutputTokens > 0 {
			result.OutputTokens = chunk.OutputTokens
		}
		if chunk.Answer != "" {
			result.Answer += chunk.Answer
			if onDelta != nil {
				if err := onDelta(chunk.Answer); err != nil {
					return result, err
				}
			}
		}
		result.ToolCalls = append(result.ToolCalls, chunk.ToolCalls...)
		callOffset += len(chunk.ToolCalls)
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
	return result, nil
}
