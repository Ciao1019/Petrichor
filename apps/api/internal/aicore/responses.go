package aicore

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	httpx "petrichor/api/internal/httpx"
)

// OpenAI Responses 使用 Item 而不是 Chat Completions 的 messages/tool_calls 复合结构。
// 这里保持项目内部 ChatMessage 不变，只在协议边界转换，避免 Runtime 感知供应商差异。
type openAIResponsesRequest struct {
	Model           string           `json:"model"`
	Input           []any            `json:"input"`
	Temperature     *float64         `json:"temperature,omitempty"`
	MaxOutputTokens *int64           `json:"max_output_tokens,omitempty"`
	Stream          bool             `json:"stream"`
	Tools           []map[string]any `json:"tools,omitempty"`
	ToolChoice      any              `json:"tool_choice,omitempty"`
}

type openAIResponseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Type    string `json:"type"`
}

type openAIResponseContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type openAIResponseItem struct {
	ID        string                  `json:"id"`
	Type      string                  `json:"type"`
	Role      string                  `json:"role"`
	Status    string                  `json:"status"`
	CallID    string                  `json:"call_id"`
	Name      string                  `json:"name"`
	Arguments string                  `json:"arguments"`
	Content   []openAIResponseContent `json:"content"`
	Summary   []openAIResponseContent `json:"summary"`
}

type openAIResponseEnvelope struct {
	ID     string               `json:"id"`
	Status string               `json:"status"`
	Output []openAIResponseItem `json:"output"`
	Usage  struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
	} `json:"usage"`
	Error             *openAIResponseError `json:"error"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
}

func usesResponsesProtocol(rt RuntimeConfig) bool {
	return strings.EqualFold(strings.TrimSpace(rt.APIProtocol), "responses")
}

func toOpenAIResponsesInput(msgs []ChatMessage) []any {
	items := make([]any, 0, len(msgs)*2)
	for _, message := range msgs {
		if message.Role == "tool" {
			items = append(items, map[string]any{
				"type":    "function_call_output",
				"call_id": message.ToolCallID,
				"output":  message.Content,
			})
			continue
		}

		content := responsesMessageContent(message)
		if content != nil {
			items = append(items, map[string]any{
				"role":    message.Role,
				"content": content,
			})
		}
		for _, call := range message.ToolCalls {
			items = append(items, map[string]any{
				"type":      "function_call",
				"call_id":   call.ID,
				"name":      call.Name,
				"arguments": call.ArgsJSON,
			})
		}
	}
	return items
}

func responsesMessageContent(message ChatMessage) any {
	if len(message.Parts) == 0 {
		// 只有工具调用的 assistant 消息不需要额外制造一个空 message Item。
		if message.Content == "" && len(message.ToolCalls) > 0 {
			return nil
		}
		return message.Content
	}
	parts := make([]map[string]any, 0, len(message.Parts))
	for _, part := range message.Parts {
		switch part.Type {
		case "image_url":
			url := part.ImageURL
			if url == "" && len(part.Data) > 0 {
				mime := part.MIMEType
				if mime == "" {
					mime = "image/png"
				}
				url = "data:" + mime + ";base64," + b64(part.Data)
			}
			parts = append(parts, map[string]any{"type": "input_image", "image_url": url})
		default:
			parts = append(parts, map[string]any{"type": "input_text", "text": part.Text})
		}
	}
	return parts
}

func openAIResponsesToolsPayload(tools []ToolDefinition) []map[string]any {
	if len(tools) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		parameters := tool.Parameters
		if len(parameters) == 0 {
			parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, map[string]any{
			"type":        "function",
			"name":        tool.Name,
			"description": tool.Description,
			"parameters":  parameters,
		})
	}
	return out
}

func buildOpenAIResponsesRequest(modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition, stream bool) openAIResponsesRequest {
	return openAIResponsesRequest{
		Model:           modelID,
		Input:           toOpenAIResponsesInput(msgs),
		Temperature:     opts.Temperature,
		MaxOutputTokens: opts.MaxTokens,
		Stream:          stream,
		Tools:           openAIResponsesToolsPayload(tools),
	}
}

// OpenAIResponsesChat 调用 Responses API 的非流式文本补全。
func OpenAIResponsesChat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions) (*ChatResult, error) {
	return openAIResponses(ctx, rt, buildOpenAIResponsesRequest(modelID, msgs, opts, nil, false), nil)
}

// OpenAIResponsesChatStream 调用 Responses API 的文本流。
func OpenAIResponsesChatStream(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, onDelta func(string) error) (*ChatResult, error) {
	return openAIResponses(ctx, rt, buildOpenAIResponsesRequest(modelID, msgs, opts, nil, true), onDelta)
}

// OpenAIResponsesChatWithTools 调用 Responses API，并聚合函数参数流。
func OpenAIResponsesChatWithTools(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition, onDelta func(string) error) (*ChatResult, error) {
	return openAIResponses(ctx, rt, buildOpenAIResponsesRequest(modelID, msgs, opts, tools, true), onDelta)
}

// OpenAIResponsesChatWithToolsOnce 是 Eino Generate 使用的非流式入口。
func OpenAIResponsesChatWithToolsOnce(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition) (*ChatResult, error) {
	return openAIResponses(ctx, rt, buildOpenAIResponsesRequest(modelID, msgs, opts, tools, false), nil)
}

func openAIResponses(ctx context.Context, rt RuntimeConfig, body openAIResponsesRequest, onDelta func(string) error) (*ChatResult, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	url, err := openAIResponsesEndpoint(rt)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if effectiveSDK(rt.ProviderKey) == SDKAzure {
		applyAzureHeaders(req, rt)
	} else {
		applyHeaders(req, rt, nil)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		return nil, modelHTTPError(resp.StatusCode, data)
	}
	if !body.Stream {
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		return parseOpenAIResponsesPayload(data)
	}
	return parseOpenAIResponsesStream(ctx, resp.Body, onDelta)
}

func openAIResponsesEndpoint(rt RuntimeConfig) (string, error) {
	if effectiveSDK(rt.ProviderKey) == SDKAzure {
		return azureEndpoint(rt, "/responses")
	}
	entry, ok := Catalog[rt.ProviderKey]
	fallback := ""
	if ok {
		fallback = entry.DefaultBaseURL
	}
	baseURL := rt.effectiveBaseURL(fallback)
	if baseURL == "" {
		return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "模型供应商缺少 BaseUrl"}
	}
	return baseURL + "/responses", nil
}

func parseOpenAIResponsesPayload(data []byte) (*ChatResult, error) {
	var response openAIResponseEnvelope
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("Responses 响应解析失败：%w", err)
	}
	if err := openAIResponseStatusError(response); err != nil {
		return nil, err
	}
	result := &ChatResult{InputTokens: response.Usage.InputTokens, OutputTokens: response.Usage.OutputTokens}
	mergeOpenAIResponseOutput(result, response.Output)
	if result.Answer == "" && len(result.ToolCalls) == 0 && result.Reasoning == nil {
		return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "模型返回空结果"}
	}
	return result, nil
}

func mergeOpenAIResponseOutput(result *ChatResult, items []openAIResponseItem) {
	seenCalls := make(map[string]int, len(result.ToolCalls))
	for index, call := range result.ToolCalls {
		seenCalls[call.ID] = index
	}
	for _, item := range items {
		switch item.Type {
		case "message":
			for _, content := range item.Content {
				if content.Type == "output_text" || content.Type == "text" {
					result.Answer += content.Text
				}
			}
		case "function_call":
			callID := item.CallID
			if callID == "" {
				callID = item.ID
			}
			call := ToolCall{ID: callID, Name: item.Name, ArgsJSON: item.Arguments}
			if existing, ok := seenCalls[callID]; ok && callID != "" {
				mergeToolCall(&result.ToolCalls[existing], call)
				continue
			}
			seenCalls[callID] = len(result.ToolCalls)
			result.ToolCalls = append(result.ToolCalls, call)
		case "reasoning":
			var summary strings.Builder
			for _, part := range item.Summary {
				if part.Type == "summary_text" || part.Type == "text" {
					summary.WriteString(part.Text)
				}
			}
			if summary.Len() > 0 {
				appendReasoning(result, summary.String())
			}
		}
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
}

func mergeToolCall(target *ToolCall, incoming ToolCall) {
	if incoming.ID != "" {
		target.ID = incoming.ID
	}
	if incoming.Name != "" {
		target.Name = incoming.Name
	}
	if incoming.ArgsJSON != "" {
		target.ArgsJSON = incoming.ArgsJSON
	}
}

func appendReasoning(result *ChatResult, delta string) {
	if delta == "" {
		return
	}
	if result.Reasoning == nil {
		value := delta
		result.Reasoning = &value
		return
	}
	value := *result.Reasoning + delta
	result.Reasoning = &value
}

func openAIResponseStatusError(response openAIResponseEnvelope) error {
	if response.Error != nil {
		message := strings.TrimSpace(response.Error.Message)
		if message == "" {
			message = "Responses API 返回失败"
		}
		return &httpx.HttpError{Status: http.StatusBadGateway, Message: "模型调用失败：" + truncate(message, 300)}
	}
	switch response.Status {
	case "failed", "cancelled", "incomplete":
		reason := response.Status
		if response.IncompleteDetails != nil && response.IncompleteDetails.Reason != "" {
			reason += "（" + response.IncompleteDetails.Reason + "）"
		}
		return &httpx.HttpError{Status: http.StatusBadGateway, Message: "模型响应未完成：" + reason}
	default:
		return nil
	}
}

func modelHTTPError(status int, data []byte) error {
	var wrapped struct {
		Error *openAIResponseError `json:"error"`
	}
	message := ""
	if json.Unmarshal(data, &wrapped) == nil && wrapped.Error != nil {
		message = strings.TrimSpace(wrapped.Error.Message)
	}
	if message == "" {
		message = truncate(string(data), 300)
	}
	return &httpx.HttpError{Status: http.StatusBadGateway, Message: fmt.Sprintf("模型调用失败(%d)：%s", status, message)}
}

type responsesToolAccumulator struct {
	outputIndex int
	itemID      string
	callID      string
	name        string
	arguments   string
}

type responsesStreamAccumulator struct {
	byIndex map[int]*responsesToolAccumulator
	byItem  map[string]*responsesToolAccumulator
	ordered []*responsesToolAccumulator
}

func newResponsesStreamAccumulator() *responsesStreamAccumulator {
	return &responsesStreamAccumulator{
		byIndex: map[int]*responsesToolAccumulator{},
		byItem:  map[string]*responsesToolAccumulator{},
	}
}

func (a *responsesStreamAccumulator) get(index *int, itemID string) *responsesToolAccumulator {
	if index != nil {
		if acc := a.byIndex[*index]; acc != nil {
			if itemID != "" {
				acc.itemID = itemID
				a.byItem[itemID] = acc
			}
			return acc
		}
	}
	if itemID != "" {
		if acc := a.byItem[itemID]; acc != nil {
			if index != nil {
				acc.outputIndex = *index
				a.byIndex[*index] = acc
			}
			return acc
		}
	}
	outputIndex := len(a.ordered)
	if index != nil {
		outputIndex = *index
	}
	acc := &responsesToolAccumulator{outputIndex: outputIndex, itemID: itemID}
	a.ordered = append(a.ordered, acc)
	if index != nil {
		a.byIndex[*index] = acc
	}
	if itemID != "" {
		a.byItem[itemID] = acc
	}
	return acc
}

func (a *responsesStreamAccumulator) mergeItem(index *int, item openAIResponseItem) {
	if item.Type != "function_call" {
		return
	}
	acc := a.get(index, item.ID)
	if item.ID != "" {
		acc.itemID = item.ID
	}
	if item.CallID != "" {
		acc.callID = item.CallID
	}
	if item.Name != "" {
		acc.name = item.Name
	}
	if item.Arguments != "" {
		// output_item.done/completed 携带的是完整参数，必须覆盖而不是再次追加。
		acc.arguments = item.Arguments
	}
}

func (a *responsesStreamAccumulator) appendArguments(index *int, itemID, delta string) {
	a.get(index, itemID).arguments += delta
}

func (a *responsesStreamAccumulator) finishArguments(index *int, itemID, arguments string) {
	if arguments != "" {
		a.get(index, itemID).arguments = arguments
	}
}

func (a *responsesStreamAccumulator) writeResult(result *ChatResult) {
	sort.SliceStable(a.ordered, func(i, j int) bool {
		return a.ordered[i].outputIndex < a.ordered[j].outputIndex
	})
	seen := map[string]struct{}{}
	for _, acc := range a.ordered {
		callID := acc.callID
		if callID == "" {
			callID = acc.itemID
		}
		key := callID + "\x00" + acc.name
		if _, ok := seen[key]; ok {
			continue
		}
		if callID == "" && acc.name == "" {
			continue
		}
		seen[key] = struct{}{}
		result.ToolCalls = append(result.ToolCalls, ToolCall{ID: callID, Name: acc.name, ArgsJSON: acc.arguments})
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
}

type openAIResponsesStreamEvent struct {
	Type        string                 `json:"type"`
	Delta       string                 `json:"delta"`
	Arguments   string                 `json:"arguments"`
	ItemID      string                 `json:"item_id"`
	OutputIndex *int                   `json:"output_index"`
	Item        openAIResponseItem     `json:"item"`
	Response    openAIResponseEnvelope `json:"response"`
	Error       *openAIResponseError   `json:"error"`
	Message     string                 `json:"message"`
}

func parseOpenAIResponsesStream(ctx context.Context, reader io.Reader, onDelta func(string) error) (*ChatResult, error) {
	result := &ChatResult{}
	tools := newResponsesStreamAccumulator()
	terminal := false
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			terminal = true
			break
		}
		var event openAIResponsesStreamEvent
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			return result, fmt.Errorf("Responses 流事件解析失败：%w", err)
		}
		switch event.Type {
		case "response.output_text.delta":
			if event.Delta != "" {
				result.Answer += event.Delta
				if onDelta != nil {
					if err := onDelta(event.Delta); err != nil {
						return result, err
					}
				}
			}
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			appendReasoning(result, event.Delta)
		case "response.output_item.added", "response.output_item.done":
			tools.mergeItem(event.OutputIndex, event.Item)
		case "response.function_call_arguments.delta":
			tools.appendArguments(event.OutputIndex, event.ItemID, event.Delta)
		case "response.function_call_arguments.done":
			tools.finishArguments(event.OutputIndex, event.ItemID, event.Arguments)
		case "response.completed":
			if err := openAIResponseStatusError(event.Response); err != nil {
				return result, err
			}
			result.InputTokens = event.Response.Usage.InputTokens
			result.OutputTokens = event.Response.Usage.OutputTokens
			for index := range event.Response.Output {
				idx := index
				tools.mergeItem(&idx, event.Response.Output[index])
			}
			if result.Answer == "" {
				fallback := &ChatResult{}
				mergeOpenAIResponseOutput(fallback, event.Response.Output)
				if fallback.Answer != "" {
					result.Answer = fallback.Answer
					if onDelta != nil {
						if err := onDelta(fallback.Answer); err != nil {
							return result, err
						}
					}
				}
				if result.Reasoning == nil {
					result.Reasoning = fallback.Reasoning
				}
			}
			terminal = true
		case "response.failed", "response.incomplete":
			if err := openAIResponseStatusError(event.Response); err != nil {
				return result, err
			}
			return result, &httpx.HttpError{Status: http.StatusBadGateway, Message: "模型响应未完成"}
		case "error":
			message := event.Message
			if event.Error != nil && event.Error.Message != "" {
				message = event.Error.Message
			}
			if message == "" {
				message = "Responses API 流式调用失败"
			}
			return result, &httpx.HttpError{Status: http.StatusBadGateway, Message: "模型调用失败：" + truncate(message, 300)}
		}
		if terminal {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	if !terminal {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		default:
			return result, &httpx.HttpError{Status: http.StatusBadGateway, Message: "模型流在完成事件前中断"}
		}
	}
	tools.writeResult(result)
	return result, nil
}
